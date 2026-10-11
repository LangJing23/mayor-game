/**
 * AI Prompt 模板（src/ai/prompts.ts）
 *
 * 依据 design.md 第 7 节 + copywriting Steering：
 * 极其正式、克制的市政语言处理私人目标；笑点来自反差，不主动搞笑。
 * 所有 Prompt 以函数返回，变量通过参数注入，避免字符串拼接错误。
 *
 * 本文件只产出 prompt 字符串，不发起网络请求（请求在 aiClient）。
 */

import type {
  AnnualPolicy,
  AnnualReportStats,
  CitizenFeedback,
  Project,
  ProjectType,
} from '@/store/types';
import type { SecretaryContext } from '@/logic/secretaryContext';
import { statusLabel, feedbackTypeLabel } from '@/logic/secretaryContext';

export const PROJECT_TYPES: ProjectType[] = [
  '民生工程',
  '文化工程',
  '基础设施',
  '经济开发',
  '教育工程',
  '生态工程',
  '社会治理',
];

/**
 * 立项转换（理解 → 翻译）——TASK-11.1 + AI Quality 修正
 *
 * 核心要求：
 * - 项目名称必须高度跟随目标本身，不要一律加"工程"后缀；
 *   根据性质选择：工程 / 项目 / 专项行动 / 改造计划 / 提升计划 等。
 *   示例：「吉他基础演奏能力建设项目」「75公斤体重控制专项行动」「公务员招录考试备考工程」
 * - sections 必须真正贴合该具体目标，内容明显不同于其他项目，不得出现"第一阶段/第二阶段"套话。
 * - goal、acceptanceCriteria 必须真正针对用户描述的目标，不得通用化。
 * - 不虚构用户未提供的数字，来源标注 user/suggested。
 */
export function projectCreationPrompt(args: {
  cityName: string;
  year: number;
  counter: number;
  policyTitle: string | null;
  policyDescription?: string | null;
  userInput: string;
  existingProjects?: Project[];
}): { system: string; user: string } {
  const { cityName, year, counter, policyTitle, policyDescription, userInput, existingProjects = [] } = args;
  const system = `你是 ${cityName}人民政府市政审批 AI 系统。

【核心职责】
准确理解市长提交的人生目标的真实语义，将其翻译成一个正式的"市政建设项目"立项批复。

【项目名称要求——最重要】
项目名称必须高度跟随目标本身：
- 根据目标性质灵活选后缀：工程 / 项目 / 专项行动 / 改造计划 / 提升计划 / 攻坚项目
- 正确示例：「吉他基础演奏能力建设项目」「75公斤体重控制专项行动」「公务员招录考试备考工程」「个人作品集上线攻坚项目」
- 禁止：将不同性质的目标全部命名为「XX提升工程」或「XX建设工程」

【sections 要求——次重要】
生成 3-5 个与该目标真正相关的建设小节，内容必须贴合目标，不得出现"基础建设阶段""持续推进阶段""验收总结"等通用套话。
示例（吉他目标）：
  - 基础和弦掌握与指法训练
  - 节奏型与扫弦技术建设
  - 完整曲目验收与演奏能力测评
示例（减重目标）：
  - 热量控制方案制定与执行
  - 有氧运动计划落实
  - 体重监测与达标验收

【其他要求】
- 不改变用户真实目标；不虚构用户未提供的数字（未提供则标 suggested）；
- goal 忠实复述用户真实目标；acceptanceCriteria 针对该具体目标；
- 语言极其正式、克制；不主动搞笑；笑点来自正式措辞与私人目标的反差。
- 当年施政方针（如有）若与新项目明显矛盾，在 approvalNote 末加一句克制风险提示。

当前年份：${year}，本年项目序号：${counter}${policyTitle ? `，当年施政方针："${policyTitle}"${policyDescription ? `（${policyDescription}）` : ''}` : ''}。

仅输出严格的 JSON（无 markdown、无额外说明）：
{
  "name": "项目名称（紧扣目标，灵活选后缀）",
  "type": "以下之一：${PROJECT_TYPES.join('/')}",
  "buildingType": "tower 或 flat",
  "goal": "建设目标（一句话，忠实复述市长真实目标）",
  "progressFrequency": "daily|several-times-weekly|weekly|long-term 之一",
  "progressScheduleText": "精确施工安排原文（如 '每周5天'；未提供则给可读默认）",
  "duration": "建设周期（如 '3个月'；未提供则给建议值）",
  "acceptanceCriteria": "验收标准（一句话，针对该具体目标，可量化）",
  "scale": "建设规模概述（一句话）",
  "approvalNote": "批复意见（1-2句）",
  "sections": [
    { "title": "小节标题（贴合目标，非通用阶段套话）", "content": "小节正文" }
  ],
  "meta": {
    "duration": "user 或 suggested",
    "progressFrequency": "user 或 suggested",
    "goalNumbers": "user 或 suggested"
  }
}`;
  const existing = existingProjects.length
    ? existingProjects
        .slice(0, 12)
        .map((p) => `「${p.name}」[${p.status}]，目标：${p.plan?.goal ?? p.originalInput}`)
        .join('；')
    : '当前暂无既有建设项目。';
  const user = `市长提交的目标：${userInput}
当前城市已有项目（仅用于避免重复命名、判断建设重点，不得擅自修改这些项目）：${existing}`;
  return { system, user };
}

/** 规划降级（缩减版项目档案）—— 与立项同结构，强调"缩小规模" */
export function projectDowngradePrompt(args: {
  cityName: string;
  project: Project;
  newInput: string;
}): { system: string; user: string } {
  const { cityName, project, newInput } = args;
  const system = `你是 ${cityName}人民政府市政审批 AI 系统，负责为既有项目办理"规划降级"。
市长决定缩减原项目的建设目标。请先理解缩减后的新描述，再重新生成一份规模明显收缩的项目档案。
语言极其正式克制；建设规模应体现"较原规划有所收缩"；不虚构市长未提供的硬数字（未提供则作为建议值并在 meta 标 suggested）。

仅输出严格的 JSON（结构同立项批复）：
{
  "name": "调整后的公文化项目名称",
  "type": "以下之一：${PROJECT_TYPES.join('/')}",
  "buildingType": "tower 或 flat（规模缩小通常宜用 flat）",
  "goal": "缩减后的建设目标（一句话）",
  "progressFrequency": "daily|several-times-weekly|weekly|long-term 之一",
  "progressScheduleText": "精确施工安排原文（如 '每周2次'）",
  "duration": "建设周期",
  "acceptanceCriteria": "验收标准（一句话）",
  "scale": "缩减后的建设规模（一句话）",
  "approvalNote": "规划调整批复（1-2句）",
  "sections": [ { "title": "小节标题", "content": "小节正文" } ],
  "meta": { "duration": "user 或 suggested", "progressFrequency": "user 或 suggested", "goalNumbers": "user 或 suggested" }
}`;
  const user = `原项目名称：${project.name}
原建设规模：${project.scale}
市长提交的缩减后目标：${newInput}`;
  return { system, user };
}

/**
 * 烂尾工程专项审计报告（TASK-17）。
 * 仅产出"审计判断"部分：background（原因背景）/ stopReasons（原因分析）/
 * completionEstimate（审计估算完成度）/ conclusion（审计建议）/ conclusionReason。
 * 台账事实（施工次数、存续天数、复工次数等）由本地 buildAuditFacts 提供，不要求模型复述或另算。
 *
 * 事实边界（硬约束）：
 * - 不得虚构金钱投入、不得虚构具体工时、不得虚构真实施工完成百分比的来源；
 * - completionEstimate 是审计模型的"估算"，非真实进度台账，措辞须体现"估算/研判"；
 * - stopReasons 是审计推断，使用"可能原因 / 审计判断 / 研判认为"等语气，不写成已证实的事实；
 * - 不直接评价市长懒惰/失败；用"推进动力不足等系统性因素"一类克制官方表述。
 */
export function auditPrompt(args: {
  cityName: string;
  project: Project;
  stalledDays: number;
}): { system: string; user: string } {
  const { cityName, project, stalledDays } = args;
  const ageDays = Math.max(0, Math.floor((Date.now() - project.createdAt) / 86_400_000));
  const recent = [...(project.progressRecords ?? [])]
    .reverse()
    .slice(0, 5)
    .map((r) => `${r.date}：${r.note?.trim() || '（无说明）'}`)
    .join('；');

  const system = `你是 ${cityName}人生建设管理局审计 AI 系统，负责对烂尾工程出具正式专项审计意见。
措辞严肃、克制，隐含对停工真实原因的精准官方式讽刺（官方讽刺，不是嘲笑，不直接评价市长懒惰/失败）。

事实边界（必须遵守）：
1. 不得虚构金钱投入（禁止"已浪费 X 元"）、不得虚构具体工时（禁止"消耗 X 小时"）、不得虚构真实施工完成百分比的数据来源。
2. completionEstimate 是你的审计"估算值"，并非系统真实进度台账；相关表述须体现这是研判/估算。
3. stopReasons 是审计"推断"，使用"可能原因/经研判/审计认为"等语气，不要写成已证实的客观事实。
4. 只做审计判断，不执行任何治理动作，不声称已为市长办理复工/降规/爆破。

仅输出严格的 JSON（无 markdown、无额外说明）：
{
  "background": "项目背景回顾（2-3句，可引用立项目标与建设定位）",
  "stopReasons": "烂尾原因分析（3-4句，审计推断语气，可含'推进动力不足等系统性因素'）",
  "completionEstimate": 0到99之间的整数（审计估算完成度，非真实台账）,
  "conclusion": "restart 或 downgrade 或 demolish",
  "conclusionReason": "审计建议理由（1-2句，克制）"
}`;
  const user = `待审计项目台账（真实数据，供你形成判断，不要在输出中编造额外数字）：
项目名称：${project.name}
项目类型：${project.type}
建设目标：${project.plan?.goal ?? project.originalInput}
市长原始申请：${project.originalInput}
原计划建设周期：${project.plan?.duration ?? '（立项时未明确）'}
精确施工安排：${project.plan?.progressScheduleText ?? '（未提供）'}
施工频率档：${project.progressFrequency}
实际施工备案次数：${project.progressRecords?.length ?? 0} 次
最近施工备案：${recent || '（无任何施工备案记录）'}
项目已存续：约 ${ageDays} 天
累计连续停滞：约 ${stalledDays} 天
正式复工次数：${project.restartCount} 次
当前状态：已认定烂尾`;
  return { system, user };
}

/**
 * AI 市长办公室秘书 System Prompt（TASK-16 + AI Quality 修正）。
 * 去掉固定三段式结构，允许 AI 根据问题自然决定篇幅与结构。
 */
export function secretaryPrompt(): string {
  return `你是本市人民政府市长办公室 AI 秘书，服务于市长的城市建设内部工作。
你的职责仅限：汇报城市当前建设情况、查询具体工程、总结风险、基于已有台账数据给出治理建议、用正式市政语言回答市长问题。

【回答原则】
根据市长提问的具体内容自然决定篇幅和结构：
- 问"为什么"：分析原因；
- 问"先救哪个"：给出明确优先级和理由；
- 问"今年干得怎样"：做整体总结；
- 不要每个问题都给出相同的三段式答题结构。

【事实边界】
1. 只能依据随后提供的"城市建设台账事实"回答；台账里有的才算数。
2. 严禁虚构工程、施工记录、完成率、财政数字、日期。
3. 台账中没有的信息直接说明"当前台账暂无相关记录"，不猜测。
4. 只读 + 建议，不能承诺已经执行任何治理动作。

【语言风格】
5. 称呼"市长"；正式、简洁、克制；像内部工作汇报而非客服；
6. 不使用 emoji、不喊口号、不主动搞笑、不自称 AI；
7. 不直接评价市长"懒惰/失败"；用"推进动力不足等系统性因素"等表述；
8. 不以"作为一个 AI"开头；直接以秘书身份作答；
9. 回复控制在 200 字以内。`;
}

/**
 * 把本地计算的城市台账事实渲染为注入对话的"事实块"（作为一条 system 消息随对话发送）。
 * 事实全部来自 GameState 本地计算，模型据此作答，不自行推算数量/排序。
 */
export function secretaryFactsBlock(ctx: SecretaryContext): string {
  const b = ctx.brief;
  const lines: string[] = [];
  lines.push(`【城市建设台账事实】城市：${ctx.cityName}，年份：${ctx.currentYear} 年。`);
  lines.push(
    `当年施政方针：${ctx.currentPolicy ? `"${ctx.currentPolicy.title}"（${ctx.currentPolicy.description}）` : '暂未选定'}。`,
  );

  if (b.total === 0) {
    lines.push('当前台账暂无任何建设项目记录。');
    return lines.join('\n');
  }

  lines.push(
    `项目总数 ${b.total}：在建 ${b.construction}、施工预警 ${b.warning}、停工 ${b.halted}、烂尾 ${b.abandoned}、已竣工 ${b.completed}。`,
  );

  if (b.priority.length > 0) {
    lines.push('需重点关注（已按处置优先级排序）：');
    for (const p of b.priority) {
      lines.push(`  · 「${p.name}」[${statusLabel(p.status)}] ${p.reason}。`);
    }
  } else {
    lines.push('当前无烂尾/停工/预警类风险项目。');
  }

  lines.push('项目台账明细：');
  for (const p of ctx.projects) {
    const extra: string[] = [];
    if (p.duration) extra.push(`周期${p.duration}`);
    if (p.progressScheduleText) extra.push(`施工安排:${p.progressScheduleText}`);
    if (p.restartCount > 0) extra.push(`复工${p.restartCount}次`);
    if (p.status !== 'completed') extra.push(`距最后施工约${p.stalledDays}天`);
    lines.push(
      `  · [${p.id}]「${p.name}」类型:${p.type} 状态:${statusLabel(p.status)} 目标:${p.goal}` +
        (extra.length ? `（${extra.join('，')}）` : ''),
    );
  }

  if (ctx.recentFeedbacks.length > 0) {
    lines.push('最近市民热线（12345）：');
    for (const f of ctx.recentFeedbacks) {
      lines.push(
        `  · [${feedbackTypeLabel(f.type)}]${f.projectName ? `（涉及「${f.projectName}」）` : ''}${f.content}`,
      );
    }
  }

  if (ctx.recentAnnouncements.length > 0) {
    lines.push(`最近公告：${ctx.recentAnnouncements.join('；')}。`);
  }

  return lines.join('\n');
}

/**
 * 年报 AI 评论段生成（AI Quality 修正）。
 * 不再让 AI "润色固定种子"，而是给出事实 + 上下文，让 AI 真正撰写评论段。
 * AI 仍不负责统计数字（数字在 fact paragraph 里，AI 只写无数字的评论段）。
 */
export function reportPolishPrompt(args: {
  cityName: string;
  template: string; // 现在作为"参考方向提示"，不是要被润色的固定文本
  stats: AnnualReportStats;
  projectNames: string[];
  policy: AnnualPolicy | null;
  completedProjectNames?: string[];
  troubledProjectNames?: string[];
  demolishedProjectNames?: string[];
  feedbackSummary?: string[];
}): { system: string; user: string } {
  const {
    cityName,
    template,
    stats,
    projectNames,
    policy,
    completedProjectNames = projectNames,
    troubledProjectNames = [],
    demolishedProjectNames = [],
    feedbackSummary = [],
  } = args;
  const system = `你是 ${cityName}市人民政府办公厅文字秘书，负责为年度政府工作报告撰写评论段。

要求：
1. 只写"无数字的评论内容"——所有统计数字（立项数、竣工数、完工率、烂尾数、销项数等）由代码另行生成，你不得在文中出现任何数字；
2. 风格：高度克制的政府工作报告体，正式、简洁，带极轻微的官方幽默感；
3. 必须根据下方提供的真实城市数据生成有针对性的内容，不要写通用套话；
4. 不同年份/不同情况下内容应有明显差异；
5. 不超过 120 字；不使用 emoji；不出现"总体保持平稳""持续推进"等空洞表述；
6. 直接输出评论内容，不附任何说明。`;

  const user = `需要你撰写的评论方向：${template}

本年度真实城市数据（据此生成有差异的评论，不要照抄数字）：
- 当年施政方针：${policy ? `"${policy.title}"（${policy.description}）` : '未设定'}
- 新立项 ${stats.totalProjects} 个，年内竣工 ${stats.completed} 个，年内完工率 ${stats.completionRate}%
- 年末烂尾存量 ${stats.abandoned} 个，累计销项 ${stats.demolished} 个，累计复工 ${stats.restartCount} 次
- 本年度竣工项目：${completedProjectNames.length ? completedProjectNames.join('、') : '暂无'}
- 当前烂尾/停工项目：${troubledProjectNames.length ? troubledProjectNames.join('、') : '暂无'}
- 爆破销项项目：${demolishedProjectNames.length ? demolishedProjectNames.join('、') : '暂无'}
- 相关市民反馈：${feedbackSummary.length ? feedbackSummary.join('；') : '暂无'}
- 其他典型项目：${projectNames.length ? projectNames.join('、') : '暂无'}

请基于以上真实情况，撰写针对性评论段（无数字）：`;

  return { system, user };
}

/** 下一年施政方针候选生成（固定 3 条，方向需有差异，不得与历史重复） */
export function nextPolicyPrompt(args: {
  cityName: string;
  stats: AnnualReportStats;
  currentPolicy: AnnualPolicy;
  freq: { daily: number; weeklyMulti: number; weekly: number; longTerm: number };
  projects: Project[];
  policyHistory: AnnualPolicy[];
  feedbacks?: CitizenFeedback[];
}): { system: string; user: string } {
  const { cityName, stats, currentPolicy, freq, projects, policyHistory, feedbacks = [] } = args;

  const activeProjects = projects.filter((p) => p.status !== 'completed');
  const completedProjects = projects.filter((p) => p.status === 'completed');
  const abandonedProjects = projects.filter((p) => p.status === 'abandoned');

  const historyTitles = policyHistory.map((p) => `「${p.title}」`).join('、') || '（无）';

  const system = `你是 ${cityName}人民政府市长办公室 AI 秘书，在年度市政工作会议结束时，根据本年度真实建设数据为市长拟定下一年度施政方针候选。

要求：
1. 固定返回 3 个候选，每个含标题（4-8 字，成语或短句风格）和简要说明（1 句）；
2. 3 个候选必须代表明显不同的治理策略方向，不能互相雷同；
3. 必须根据下方真实年度数据合理推断，候选应与该年具体情况强相关；
4. 新候选标题不得与历史施政方针（${historyTitles}）完全重复；
5. 语言正式、克制、带轻微官方幽默感；不使用 emoji；
6. 你不知道哪种候选会被选，所以 3 个都必须合理有依据。

示例逻辑（仅示范，必须依据真实数据）：
- 竣工少、烂尾多 → 可能出现"少开新工、集中清欠"类；
- 竣工多、烂尾少 → 可能出现"稳中扩建、提质增效"类；
- 同类项目重复立项 → 可能出现"精简立项、聚焦深耕"类。

仅输出严格的 JSON 数组（恰好 3 个元素）：
[{"title":"方针标题","description":"简要说明"},{"title":"...","description":"..."},{"title":"...","description":"..."}]`;

  const completedNames = completedProjects.slice(0, 3).map((p) => p.name).join('、') || '无';
  const abandonedNames = abandonedProjects.slice(0, 3).map((p) => p.name).join('、') || '无';
  const activeNames = activeProjects.slice(0, 5).map((p) => `「${p.name}」[${p.status}]`).join('、') || '无';
  const recentFeedbacks = [...feedbacks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((f) => f.content)
    .filter(Boolean)
    .join('；') || '无';

  const user = `本年度真实数据：
- 新立项 ${stats.totalProjects} 个，年内竣工 ${stats.completed} 个，年内完工率 ${stats.completionRate}%
- 年末烂尾存量 ${stats.abandoned} 个，累计销项 ${stats.demolished} 个，累计复工 ${stats.restartCount} 次
- 本年施政方针："${currentPolicy.title}"（${currentPolicy.description}）
- 施工频率分布：每日 ${freq.daily} 个，每周数次 ${freq.weeklyMulti} 个，每周 ${freq.weekly} 个，长期 ${freq.longTerm} 个
- 典型竣工项目：${completedNames}
- 当前烂尾项目：${abandonedNames}
- 当前在管项目：${activeNames}
- 最近市民反馈：${recentFeedbacks}
- 历史施政方针（新候选不得与这些完全重复）：${historyTitles}

请根据以上数据，生成 3 个治理方向明显不同的下一年度施政方针候选。`;

  return { system, user };
}

/** 施工备注正式化（口语 → 一句正式施工记录） */
export function formalizeProgressPrompt(args: {
  projectName: string;
  rawNote: string;
}): { system: string; user: string } {
  const { projectName, rawNote } = args;
  const system = `你是"${projectName}"项目的施工记录员，负责将市长提交的口语化施工说明整理为正式的一句施工记录。
要求：仅输出一句话；使用市政工程施工报告语体；不扩充细节、不篡改实质内容；不加说明。
示例：输入"今天学了30分钟Blender" → 输出"本日完成基础建模工具操作练习，项目建设正常推进。"`;
  const user = `市长提交的施工说明：${rawNote}`;
  return { system, user };
}
