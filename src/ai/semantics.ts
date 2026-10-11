/**
 * 轻量语义解析（src/ai/semantics.ts）
 *
 * 用途：
 * - Demo/Mock 模式下，把用户自然语言目标解析为结构化 ProjectDraft（分类 + 参数提取 + 动态 sections）。
 * - Real AI 失败降级时也复用此模块，保证离线/异常下仍能产出合理 Draft。
 *
 * 原则（依据 TASK-11.1）：
 * - 理解真实语义，不做无关套用；短输入"考公""减肥""学英语"也要正确归类。
 * - 用户显式写出的周期/频率/数字标 source='user'；系统补充的标 'suggested'，不伪装成用户事实。
 * - 不同类别生成不同正文结构（3–5 个 section）。
 */

import type {
  BuildingType,
  DraftSection,
  FieldSource,
  ProgressFrequency,
  ProjectDraft,
  ProjectType,
} from '@/store/types';

/* ============================================================
 * 1. 目标分类
 * ============================================================ */

export type GoalCategory =
  | 'civil-exam' // 考公 / 考编
  | 'fitness' // 健身 / 减脂
  | 'digital' // 博客 / 软件 / 产品
  | 'language' // 语言学习
  | 'skill' // 兴趣技能
  | 'generic'; // 兜底

interface CategoryRule {
  category: GoalCategory;
  keywords: string[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'civil-exam',
    keywords: ['考公', '公务员', '国考', '省考', '行测', '申论', '考编', '事业编', '编制', '选调'],
  },
  {
    category: 'fitness',
    keywords: ['减脂', '减肥', '健身', '跑步', '增肌', '瘦', '塑形', '马拉松', '练肌', '体重'],
  },
  {
    category: 'digital',
    keywords: ['博客', '网站', 'app', 'App', 'APP', '小程序', '开源', '产品', '软件', '网页', '上线', 'github', 'GitHub'],
  },
  {
    category: 'language',
    keywords: ['英语', '口语', '雅思', '托福', '四级', '六级', '日语', '法语', '韩语', '单词', '外语', '听力'],
  },
  {
    category: 'skill',
    keywords: ['吉他', '钢琴', '绘画', '画画', '摄影', '书法', '尤克里里', '乐器', '手绘', '素描'],
  },
];

export function classifyGoal(input: string): GoalCategory {
  const text = input.toLowerCase();
  const raw = input;
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()) || raw.includes(k))) {
      return rule.category;
    }
  }
  return 'generic';
}

/* ============================================================
 * 2. 参数提取（周期 / 频率 / 数字）
 *    仅提取用户显式写出的；提取到即标 user，否则由分类默认值标 suggested。
 * ============================================================ */

export interface ExtractedParams {
  /** 用户显式周期（如"明年""3个月""半年"），未提供为 null */
  duration: string | null;
  /** 用户显式施工频率（粗粒度，用于状态机阈值），未提供为 null */
  frequency: ProgressFrequency | null;
  /** 用户显式精确施工安排原文（如"每周5天""每天"），未提供为 null */
  scheduleText: string | null;
  /** 用户显式写出的量化数字短语，未提供为空 */
  numbers: string[];
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
function toNum(s: string): number {
  return Number(s) || CN_NUM[s] || 0;
}

export function extractParams(input: string): ExtractedParams {
  const numbers: string[] = [];

  // —— 施工频率（优先于周期判定，避免"每周5天"里的"天"被当成周期）—— //
  // 粗粒度 frequency 决定状态机阈值；scheduleText 保留用户精确原文供批复/审计。
  // 映射：每天/每周6-7 → daily；每周2-5 → several-times-weekly；每周1 → weekly；长期 → long-term。
  let frequency: ProgressFrequency | null = null;
  let scheduleText: string | null = null;
  let freqPhrase: string | null = null;
  if (/每天|天天|每日|日日/.test(input)) {
    frequency = 'daily';
    scheduleText = '每天';
    freqPhrase = (input.match(/每天|天天|每日|日日/) || [])[0] ?? null;
  } else {
    // "每周N天/次" 允许中间夹非数字字符（如"每周学习5天"）
    const perWeek = input.match(/(每周|一周)[^0-9一二三四五六七八九十]*([0-9一二三四五六七八九十]+)\s*(天|次|日)/);
    if (perWeek) {
      const n = toNum(perWeek[2]);
      frequency = n >= 6 ? 'daily' : n >= 2 ? 'several-times-weekly' : 'weekly';
      scheduleText = `每周${perWeek[2]}${perWeek[3]}`;
      freqPhrase = perWeek[0];
      numbers.push(perWeek[0]);
    } else if (/每周|一周/.test(input)) {
      frequency = 'weekly';
      scheduleText = '每周1次';
      freqPhrase = (input.match(/每周|一周/) || [])[0] ?? null;
    } else if (/长期|持续|慢慢/.test(input)) {
      frequency = 'long-term';
      scheduleText = '长期推进';
    }
  }

  // —— 周期（排除已被频率短语占用的片段）—— //
  let duration: string | null = null;
  // 相对时间词优先（明年/年底等）
  const relMatch = input.match(/(明年|今年|年底|年内|下半年|上半年|这个月|下个月)/);
  if (relMatch) {
    duration = relMatch[1];
  } else {
    // 时长表达；若候选落在频率短语内则跳过
    const durRe = /([0-9一二三四五六七八九十两半]+\s*(?:个月|月|个星期|星期|周|年))/g;
    let dm: RegExpExecArray | null;
    while ((dm = durRe.exec(input)) !== null) {
      if (freqPhrase && freqPhrase.includes(dm[1])) continue;
      duration = dm[1];
      break;
    }
  }

  // —— 其它量化数字（公斤/斤/篇/个/分钟/小时/字 等）—— //
  const numRe = /([0-9一二三四五六七八九十百千两]+\s*(?:公斤|斤|千克|篇|个|分钟|小时|字|页|首|幅|章|关|套))/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(input)) !== null) {
    if (!numbers.includes(m[1])) numbers.push(m[1]);
  }

  return { duration, frequency, scheduleText, numbers };
}

/* ============================================================
 * 3. 分类默认配置（建议值；仅在用户未提供时使用，标 suggested）
 * ============================================================ */

interface CategoryProfile {
  type: ProjectType;
  buildingType: BuildingType;
  defaultFrequency: ProgressFrequency;
  defaultDuration: string;
  /** 名称生成（接收精炼后的目标词） */
  name: (input: string) => string;
}

const PROFILES: Record<GoalCategory, CategoryProfile> = {
  'civil-exam': {
    type: '教育工程',
    buildingType: 'tower',
    defaultFrequency: 'daily',
    defaultDuration: '6个月',
    name: (input) => {
      if (/省考|选调/.test(input)) return '省级公务员招录考试备考工程';
      if (/国考/.test(input)) return '国家公务员招录考试备考工程';
      if (/考编|事业编|编制/.test(input)) return '事业单位招聘考试备考工程';
      return '公务员招录考试备考工程';
    },
  },
  fitness: {
    type: '民生工程',
    buildingType: 'tower',
    defaultFrequency: 'several-times-weekly',
    defaultDuration: '3个月',
    name: () => '市民体质健康提升工程',
  },
  digital: {
    type: '文化工程',
    buildingType: 'flat',
    defaultFrequency: 'weekly',
    defaultDuration: '3个月',
    name: () => '个人数字内容建设工程',
  },
  language: {
    type: '教育工程',
    buildingType: 'tower',
    defaultFrequency: 'daily',
    defaultDuration: '4个月',
    name: () => '外语能力建设工程',
  },
  skill: {
    type: '文化工程',
    buildingType: 'flat',
    defaultFrequency: 'several-times-weekly',
    defaultDuration: '3个月',
    name: () => '市民技艺培养工程',
  },
  generic: {
    type: '民生工程',
    buildingType: 'tower',
    defaultFrequency: 'weekly',
    defaultDuration: '3个月',
    name: () => '市民重点民生建设工程',
  },
};

/* ============================================================
 * 4. 动态 sections 生成（按类别，正文真正贴合目标）
 * ============================================================ */

function freqLabel(f: ProgressFrequency): string {
  return f === 'daily'
    ? '每日施工'
    : f === 'several-times-weekly'
      ? '每周多次施工'
      : f === 'weekly'
        ? '每周施工'
        : '长期推进';
}

function buildSections(
  category: GoalCategory,
  goal: string,
  frequency: ProgressFrequency,
  duration: string,
): DraftSection[] {
  const fl = freqLabel(frequency);
  switch (category) {
    case 'civil-exam':
      return [
        { title: '建设目标', content: `围绕"${goal}"开展系统性备考建设，确保市长具备参加目标招录考试的能力储备。` },
        { title: '施工安排', content: `施工频率拟定为${fl}，重点推进行测与申论两大基础设施同步建设。` },
        { title: '阶段重点', content: '一阶段夯实行测各模块基础；二阶段强化申论写作与材料分析；三阶段集中套题与模拟演练。' },
        { title: '备考内容', content: '涵盖行测言语、数量、判断、资料分析，申论归纳、对策、大作文，以及时政积累。' },
        { title: '验收标准', content: `在建设周期（${duration}）内完成成套真题训练，并实际参加一次目标招录考试。` },
      ];
    case 'fitness':
      return [
        { title: '建设目标', content: `围绕"${goal}"推进市民体质健康基础设施建设，改善身体机能与形体状况。` },
        { title: '训练安排', content: `施工频率拟定为${fl}，统筹有氧与力量训练的工程进度。` },
        { title: '建设周期', content: `拟定建设周期约${duration}，分阶段推进并动态调整训练强度。` },
        { title: '验收标准', content: '以阶段性体测数据达标、训练出勤稳定作为竣工验收依据。' },
        { title: '风险提示', content: '施工过程中应防范运动损伤与进度中断，必要时启动规划降级而非直接停工。' },
      ];
    case 'digital':
      return [
        { title: '建设内容', content: `围绕"${goal}"开展数字内容/产品的规划、开发与发布建设。` },
        { title: '核心交付物', content: '明确可对外发布的核心成果（如站点、内容集、可运行版本），作为主体工程。' },
        { title: '推进周期', content: `拟定建设周期约${duration}，${fl}。` },
        { title: '阶段安排', content: '一阶段完成框架搭建；二阶段完成核心功能/内容；三阶段完成打磨与上线发布。' },
        { title: '验收标准', content: '以成果正式对外发布、并持续产出一个周期作为竣工验收依据。' },
      ];
    case 'language':
      return [
        { title: '能力建设目标', content: `围绕"${goal}"推进外语综合能力基础设施建设。` },
        { title: '训练内容', content: '统筹听、说、读、写四类训练设施，重点补强薄弱环节。' },
        { title: '施工频率', content: `施工频率拟定为${fl}，保持语言输入与输出的持续性。` },
        { title: '阶段重点', content: '一阶段积累词汇与基础语法；二阶段强化听说训练；三阶段进入实战应用与测评。' },
        { title: '验收方式', content: `在建设周期（${duration}）内通过阶段性测评或达到既定能力水平。` },
      ];
    case 'skill':
      return [
        { title: '建设目标', content: `围绕"${goal}"推进市民技艺培养工程，形成可展示的技能成果。` },
        { title: '训练安排', content: `施工频率拟定为${fl}，循序渐进推进基础与进阶训练。` },
        { title: '建设周期', content: `拟定建设周期约${duration}，分阶段提升熟练度。` },
        { title: '阶段重点', content: '一阶段掌握基础要领；二阶段完成完整作品/曲目练习；三阶段公开展示或录制留存。' },
        { title: '验收标准', content: '以完成一件完整作品或完整表演作为竣工验收依据。' },
      ];
    case 'generic':
    default:
      return [
        { title: '建设目标', content: `围绕"${goal}"开展重点民生建设，忠实落实市长的原始建设意图。` },
        { title: '施工安排', content: `施工频率拟定为${fl}，分阶段稳步推进。` },
        { title: '建设周期', content: `拟定建设周期约${duration}。` },
        { title: '验收标准', content: '以市长原始目标达成作为竣工验收依据。' },
      ];
  }
}

/* ============================================================
 * 5. 组装 ProjectDraft（Mock 主入口 / Real AI 降级入口）
 * ============================================================ */

export function buildDraftFromSemantics(input: string): ProjectDraft {
  const goal = input.trim();
  const category = classifyGoal(goal);
  const profile = PROFILES[category];
  const params = extractParams(goal);

  // 频率：用户提供→user，否则分类默认→suggested
  const frequency = params.frequency ?? profile.defaultFrequency;
  const freqSource: FieldSource = params.frequency ? 'user' : 'suggested';
  // 精确施工安排原文：用户提供则用原文，否则按粗粒度频率给出可读默认
  const scheduleText =
    params.scheduleText ??
    (frequency === 'daily'
      ? '每天'
      : frequency === 'several-times-weekly'
        ? '每周多次'
        : frequency === 'weekly'
          ? '每周1次'
          : '长期推进');

  // 周期：用户提供→user，否则分类默认→suggested
  const duration = params.duration ?? profile.defaultDuration;
  const durSource: FieldSource = params.duration ? 'user' : 'suggested';

  // 目标数字来源：用户写出任意量化数字→user，否则 suggested
  const goalNumbersSource: FieldSource = params.numbers.length > 0 ? 'user' : 'suggested';

  const sections = buildSections(category, goal, frequency, duration);

  // 验收标准取 sections 中验收相关小节的内容，避免重复造句
  const acceptance =
    sections.find((s) => s.title.includes('验收'))?.content ?? '以市长原始目标达成作为竣工验收依据。';

  const name = profile.name(goal);
  const scale = params.numbers.length
    ? `建设规模依据市长明确提出的 ${params.numbers.join('、')} 推进。`
    : `建设规模按分阶段推进，具体指标以建设周期内实际进展为准。`;

  const approvalNote =
    durSource === 'suggested'
      ? '经审核，本项目符合市政建设方向，予以批准立项。文中建设周期等为建议值，请市长审定后执行。'
      : '经审核，本项目符合市政建设方向，予以批准立项。';

  return {
    name,
    type: profile.type,
    buildingType: profile.buildingType,
    progressFrequency: frequency,
    approvalNote,
    goal,
    acceptanceCriteria: acceptance,
    duration,
    progressScheduleText: scheduleText,
    scale,
    sections,
    meta: {
      duration: durSource,
      progressFrequency: freqSource,
      goalNumbers: goalNumbersSource,
    },
  };
}

/* ============================================================
 * 建筑楼型推导（deriveBuildingType）
 * ------------------------------------------------------------
 * 楼型由"最终项目体量"推导，而非项目类别永久锁死（类别仅次要 fallback）。
 * 必须以市长最终审定后的值为准：批准瞬间用 finalDraft 重新 derive。
 * 规则（MVP，保持简单）：
 *   ≤2 个月普通项目        → flat
 *   3–5 个月               → 偏 flat（除非目标/规模明显偏大）
 *   ≥6 个月 / 长期常态化    → tower
 *   无法解析周期            → 用 category/profile 默认 buildingType（即 draft 自带建议）
 * ============================================================ */

/** 把周期文本解析为近似月数；无法解析返回 null。 */
export function parseDurationMonths(duration: string | undefined | null): number | null {
  if (!duration) return null;
  const s = duration.trim();

  // 相对时间词
  if (/明年|今年|年底|年内|全年/.test(s)) return 12;
  if (/下半年|上半年|半年/.test(s)) return 6;
  if (/这个月|本月|下个月|一个月/.test(s)) return 1;
  if (/长期|持续|常态|长线/.test(s)) return 12;

  // 数字 + 单位
  const num = (m: RegExpMatchArray | null): number | null => {
    if (!m) return null;
    const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
    return Number(m[1]) || map[m[1]] || null;
  };
  const yr = num(s.match(/([0-9一二三四五六七八九十]+)\s*年/));
  if (yr !== null) return yr * 12;
  const mo = num(s.match(/([0-9一二三四五六七八九十半]+)\s*个?月/));
  if (mo !== null) return mo;
  const wk = num(s.match(/([0-9一二三四五六七八九十]+)\s*个?(?:周|星期)/));
  if (wk !== null) return (wk * 7) / 30; // 周→月近似
  const day = num(s.match(/([0-9一二三四五六七八九十]+)\s*(?:天|日)/));
  if (day !== null) return day / 30;

  return null;
}

/**
 * 由最终 draft 的体量确定性推导楼型。
 * @param draft 已审定的 finalDraft（含 duration / progressFrequency / goal / buildingType 建议）
 */
export function deriveBuildingType(draft: Pick<ProjectDraft, 'duration' | 'progressFrequency' | 'goal' | 'buildingType'>): BuildingType {
  const months = parseDurationMonths(draft.duration);

  // 长期常态化项目 → tower（即便周期文本短，如"每天"的长线习惯）
  if (draft.progressFrequency === 'long-term') return 'tower';

  if (months !== null) {
    if (months <= 2) return 'flat'; // ≤2 个月 → flat
    if (months >= 6) return 'tower'; // ≥6 个月 → tower
    // 3–5 个月：默认偏 flat，除非目标/规模明显偏大（出现"系统/平台/长期/全面/体系"等体量词）
    const big = /系统|平台|体系|全面|长期|综合|中心|基础设施/.test(draft.goal || '');
    return big ? 'tower' : 'flat';
  }

  // 无法解析周期：使用 category/profile 给出的建议（draft 自带），合法则沿用，否则默认 tower
  return draft.buildingType === 'flat' || draft.buildingType === 'tower' ? draft.buildingType : 'tower';
}
