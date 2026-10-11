/**
 * 市民反馈生成逻辑（src/logic/citizenFeedback.ts）—— 纯逻辑，确定性模板 + 轻量规则。
 *
 * 职责（TASK-14）：根据城市 Projects + 已发生的状态事件，生成符合项目语境的市民反馈数据。
 * 不含 UI（TASK-15）、不调 LLM（高频系统，Demo 需稳定；Real AI 润色为后续可选）。
 * 不写进 stallDetector；由上层在状态事件发生后调用本模块（模块分离）。
 *
 * 文案风格（copywriting.md）：极其正式地讨论极其私人/琐碎/荒诞的人生问题，
 * 像 12345 热线 / 政务留言板 / 城建投诉，不是游戏 NPC / 段子 / 鸡汤。
 */

import type {
  CitizenFeedback,
  CitizenPersona,
  FeedbackType,
  Project,
  ProjectStatus,
  ProjectType,
} from '@/store/types';

/* ============================================================
 * 1. 固定 4 位市民 Persona
 * ============================================================ */

export const CITIZEN_PERSONAS: CitizenPersona[] = [
  {
    id: 'efficiency',
    name: '陈建国',
    title: '本市纳税人代表',
    concern: '项目是否真正推进、是否频繁立项、是否开工仪式多而实际施工少',
    avatarIndex: 0,
  },
  {
    id: 'health',
    name: '周秀兰',
    title: '社区卫生服务站居民',
    concern: '健康、作息、运动类工程，以及长期透支、生活基础设施被忽略',
    avatarIndex: 1,
  },
  {
    id: 'growth',
    name: '李文博',
    title: '市职业技能发展促进会会员',
    concern: '学习、职业、技能等长期建设项目，以及半途而废',
    avatarIndex: 2,
  },
  {
    id: 'life',
    name: '吴月',
    title: '本市普通市民',
    concern: '兴趣、休息、关系、娱乐，以及城市是否只剩重点工程而没有生活',
    avatarIndex: 3,
  },
];

const PERSONA_IDS = {
  efficiency: 'efficiency',
  health: 'health',
  growth: 'growth',
  life: 'life',
} as const;

/* ============================================================
 * 2. 项目类别 → 最相关 persona（决定由谁发声，保证语境匹配）
 * ============================================================ */

function personaForProject(p: Project): string {
  // 先按项目类别，再按目标关键词细化
  const text = `${p.name} ${p.plan?.goal ?? ''} ${p.originalInput}`;
  if (/健身|减脂|减肥|跑步|作息|早睡|睡眠|体质|健康|运动/.test(text)) return PERSONA_IDS.health;
  if (/考公|公务员|考编|英语|雅思|托福|学习|技能|职业|课程|证书|论文|考研/.test(text))
    return PERSONA_IDS.growth;
  if (/博客|网站|app|小程序|产品|开源|软件|副业|写作|效率/i.test(text)) return PERSONA_IDS.efficiency;
  if (/吉他|钢琴|绘画|摄影|兴趣|旅行|休息|娱乐|阅读|游戏|手办/.test(text)) return PERSONA_IDS.life;
  // 按 ProjectType 兜底
  const byType: Record<ProjectType, string> = {
    民生工程: PERSONA_IDS.health,
    教育工程: PERSONA_IDS.growth,
    文化工程: PERSONA_IDS.life,
    经济开发: PERSONA_IDS.efficiency,
    基础设施: PERSONA_IDS.efficiency,
    生态工程: PERSONA_IDS.health,
    社会治理: PERSONA_IDS.efficiency,
  };
  return byType[p.type] ?? PERSONA_IDS.efficiency;
}

/* ============================================================
 * 3. 模板库（每种事件多条变体，确定性轮转，不用 Math.random）
 * ============================================================ */

type EventKind =
  | 'new'
  | 'warning'
  | 'halted'
  | 'abandoned'
  | 'completed'
  | 'restart' // 复工（TASK-18）→ 市民正面反馈
  | 'downgrade' // 规划降级（TASK-18）→ 市民中性/理解反馈
  | 'demolish'; // 爆破销项（TASK-18）→ 市民中性告知反馈

interface Template {
  type: FeedbackType;
  text: (name: string) => string;
}

const PROJECT_TEMPLATES: Record<EventKind, Template[]> = {
  new: [
    { type: 'question', text: (n) => `市长您好，请问本年度是否还计划继续新增重点工程？目前「${n}」等项目尚需形成有效施工。` },
    { type: 'suggestion', text: (n) => `市长您好，「${n}」已正式立项，建议尽早明确阶段性施工安排，避免只停留在开工阶段。` },
    { type: 'question', text: (n) => `有市民询问，「${n}」立项后预计多久可见实质进展？望有关部门予以说明。` },
  ],
  warning: [
    { type: 'question', text: (n) => `市长您好，「${n}」近期施工频率明显下降，请问项目目前是否仍按原规划推进？` },
    { type: 'complaint', text: (n) => `部分市民反映，「${n}」近期施工活动明显减少，希望有关部门说明项目进展。` },
    { type: 'suggestion', text: (n) => `关于「${n}」，建议尽快恢复既定施工节奏，防止工程进一步滞后。` },
  ],
  halted: [
    { type: 'complaint', text: (n) => `市长您好，「${n}」已连续多日未见施工，请问围挡什么时候撤？` },
    { type: 'complaint', text: (n) => `有关「${n}」长期停工问题，建议尽快明确后续处置方案。` },
    { type: 'question', text: (n) => `「${n}」现场长期无施工人员，请问项目是否仍在正常推进？` },
  ],
  abandoned: [
    { type: 'complaint', text: (n) => `市长您好，请问「${n}」已经停工这么久，什么时候恢复建设？` },
    { type: 'complaint', text: (n) => `有关部门此前多次表示「${n}」将稳步推进，目前现场长期无施工人员，请问后续如何处理？` },
    { type: 'complaint', text: (n) => `「${n}」长期无实质进展，已影响市容市貌，恳请市长尽快研究处置办法。` },
  ],
  completed: [
    { type: 'praise', text: (n) => `「${n}」现已完成验收，建议后续加强日常维护，避免建成即闲置。` },
    { type: 'suggestion', text: (n) => `「${n}」顺利竣工，市民希望相关成果能够长期发挥作用。` },
  ],
  // 复工：市民正面反馈（措辞温和，认可市长重新推进的态度）
  restart: [
    { type: 'praise', text: (n) => `市民获悉「${n}」宣布复工，对市长坚持推进既有工程的态度表示认可。` },
    { type: 'praise', text: (n) => `「${n}」已恢复施工，部分市民表示期待工程早日形成实质进展。` },
  ],
  // 规划降级：市民中性/理解反馈
  downgrade: [
    { type: 'suggestion', text: (n) => `「${n}」完成规划调整，建设规模有所收缩，市民对量力而行的安排表示理解。` },
    { type: 'suggestion', text: (n) => `关于「${n}」缩减建设规模一事，市民建议后续聚焦核心目标、确保按期收尾。` },
  ],
  // 爆破销项：市民中性告知反馈
  demolish: [
    { type: 'suggestion', text: (n) => `「${n}」控制爆破完成，市民表示已释放地块，期待后续合理规划。` },
    { type: 'suggestion', text: (n) => `关于「${n}」实施销项一事，市民表示理解，并关注原地块的后续安排。` },
  ],
};

/** 城市级结构性反馈（无 projectId） */
type CityIssue = 'over-expansion' | 'all-long-term' | 'many-completed';
const CITY_TEMPLATES: Record<CityIssue, Template> = {
  'over-expansion': {
    type: 'suggestion',
    text: () => `市长您好，目前全市新开工项目较多，但部分既有工程长期未完成，是否考虑控制新增建设规模、优先治理存量？`,
  },
  'all-long-term': {
    type: 'complaint',
    text: () => `部分市民反映，本市重点工程建设周期普遍较长，短期可感知成果仍然不足。`,
  },
  'many-completed': {
    type: 'suggestion',
    text: () => `近期多项工程完成验收，市民希望后续减少重复建设，加强成果使用。`,
  },
};

/* ============================================================
 * 4. 工具：确定性选择 / 去重 / 文号
 * ============================================================ */

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 确定性挑选模板变体：由 projectId + status 决定，相同状态可复现 */
function pickTemplate(templates: Template[], seed: string): Template {
  return templates[hashStr(seed) % templates.length];
}

function docNumber(seed: string, now: number): string {
  const d = new Date(now);
  const n = (hashStr(seed) % 900) + 100;
  return `市民热线〔${d.getFullYear()}〕第 ${n} 号`;
}

function dateStr(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 去重键：项目级 = projectId+status+kind；城市级 = city+issue */
function hasProjectFeedback(existing: CitizenFeedback[], projectId: string, status: ProjectStatus): boolean {
  return existing.some((f) => f.projectId === projectId && f.projectStatus === status);
}
function hasCityFeedback(existing: CitizenFeedback[], issue: CityIssue, now: number): boolean {
  // 同一城市级议题 7 天内不重复
  const sevenDays = 7 * 86400000;
  return existing.some((f) => !f.projectId && f.content === CITY_TEMPLATES[issue].text('') && now - f.createdAt < sevenDays);
}

/* ============================================================
 * 5. 事件 → 反馈候选
 * ============================================================ */

export interface FeedbackContext {
  /** 本次新发生状态变化的项目事件（来自 TASK-13 / 立项 / 竣工） */
  events: Array<{ projectId: string; kind: EventKind }>;
  projects: Project[];
  existing: CitizenFeedback[];
  now: number;
}

const EVENT_PRIORITY: Record<EventKind, number> = {
  abandoned: 5,
  // 治理动作是市长刚发起的显式操作，反馈应可见：给较高优先级
  demolish: 5,
  halted: 4,
  restart: 4,
  downgrade: 4,
  warning: 3,
  completed: 1,
  new: 0,
};
const CITY_PRIORITY = 2; // 介于 warning(3) 与 completed(1) 之间

const MAX_PER_RUN = 2; // 单次最多新增 1–2 条高价值反馈

interface Candidate {
  priority: number;
  feedback: CitizenFeedback;
}

function makeProjectFeedback(p: Project, kind: EventKind, now: number): CitizenFeedback {
  const personaId = personaForProject(p);
  const tpl = pickTemplate(PROJECT_TEMPLATES[kind], `${p.id}:${kind}`);
  const seed = `${p.id}:${kind}`;
  return {
    id: `fb_${hashStr(seed)}_${now}`,
    personaId,
    type: tpl.type,
    content: tpl.text(p.name),
    projectId: p.id,
    projectStatus: p.status,
    docNumber: docNumber(seed, now),
    date: dateStr(now),
    createdAt: now,
    read: false,
  };
}

function makeCityFeedback(issue: CityIssue, now: number): CitizenFeedback {
  const tpl = CITY_TEMPLATES[issue];
  // 城市级议题由 efficiency 市民发声（结构性/规模问题）
  return {
    id: `fb_city_${issue}_${now}`,
    personaId: PERSONA_IDS.efficiency,
    type: tpl.type,
    content: tpl.text(''),
    docNumber: docNumber(`city:${issue}`, now),
    date: dateStr(now),
    createdAt: now,
    read: false,
  };
}

/** 检测城市级结构性议题 */
function detectCityIssue(projects: Project[]): CityIssue | null {
  const active = projects.filter((p) => p.status !== 'completed');
  const stalled = projects.filter((p) => p.status === 'halted' || p.status === 'abandoned');
  const completed = projects.filter((p) => p.status === 'completed');
  const inConstruction = projects.filter((p) => p.status === 'construction' || p.status === 'warning');

  // 大量新项目 + 多个停工 → 控制扩张
  if (stalled.length >= 3 && inConstruction.length >= 3) return 'over-expansion';
  // 竣工较多 → 减少重复建设
  if (completed.length >= 3 && completed.length >= projects.length / 2) return 'many-completed';
  // 全部长期型且无竣工 → 短期成果不足
  if (
    projects.length >= 4 &&
    completed.length === 0 &&
    active.every((p) => p.progressFrequency === 'long-term' || (p.plan?.duration ?? '').includes('年'))
  )
    return 'all-long-term';
  return null;
}

/**
 * 生成本次应新增的市民反馈（已去重、已节流、已按优先级裁剪到 MAX_PER_RUN）。
 * 纯函数：不写 Store，由调用方 addFeedback。
 */
export function generateFeedback(ctx: FeedbackContext): CitizenFeedback[] {
  const { events, projects, existing, now } = ctx;
  const projById = new Map(projects.map((p) => [p.id, p]));
  const candidates: Candidate[] = [];

  // 项目级
  for (const ev of events) {
    const p = projById.get(ev.projectId);
    if (!p) continue;
    const isGovernance = ev.kind === 'restart' || ev.kind === 'downgrade' || ev.kind === 'demolish';
    // 治理动作（复工/降级/爆破）是市长显式操作，必定反馈，不按"项目+状态"去重
    // （否则复工后 status=construction 的去重键会误伤；多轮治理也应各自产生反馈）。
    if (!isGovernance && hasProjectFeedback(existing, p.id, p.status)) continue;
    // completed 不必每个都触发：只对确定性抽样命中的生成（降低频率）
    if (ev.kind === 'completed' && hashStr(p.id) % 2 !== 0) continue;
    candidates.push({ priority: EVENT_PRIORITY[ev.kind], feedback: makeProjectFeedback(p, ev.kind, now) });
  }

  // 城市级（结构性）
  const issue = detectCityIssue(projects);
  if (issue && !hasCityFeedback(existing, issue, now)) {
    candidates.push({ priority: CITY_PRIORITY, feedback: makeCityFeedback(issue, now) });
  }

  // 按优先级降序，取前 MAX_PER_RUN；同优先级按 createdAt/id 稳定
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, MAX_PER_RUN).map((c) => c.feedback);
}

/** persona 查询辅助（供 UI / 测试） */
export function getPersona(id: string): CitizenPersona | undefined {
  return CITIZEN_PERSONAS.find((p) => p.id === id);
}
