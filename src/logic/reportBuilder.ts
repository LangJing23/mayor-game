/**
 * 年度政府工作报告构建（src/logic/reportBuilder.ts）—— TASK-19。
 *
 * 定位（纯逻辑编排层，不含 UI、不直接 fetch）：
 *   年末生成一次 → 返回 AnnualReport（由上层 TASK-20 持久化/展示/归档）。
 *   历史年份直接读 annualReports，不承诺用未来 GameState 重算历史年末快照。
 *
 * 事实与 AI 的硬边界（REQ-10 + 本轮指令）：
 *   - 所有统计数字（立项/竣工/完工率/烂尾存量/累计销项/累计复工）由本地确定性计算，
 *     写入 AnnualReportStats 并直接拼入报告"事实段"，AI 永不接触数字。
 *   - AI 只润色"无数字的评论段"（总体评价/典型项目点评/方针落实评价/停工原因/新年展望）。
 *   - 润色结果若意外混入数字，回退预置中性评论（defensive guard，不依赖 Prompt 保证）。
 *   - builder 不调用 advanceYear，不生成下一年方针候选（属 TASK-20）。
 */

import { aiClient, type ReportCommentaryContext } from '@/ai/aiClient';
import type {
  AnnualPolicy,
  AnnualReport,
  AnnualReportStats,
  CitizenFeedback,
  Project,
} from '@/store/types';

/* ============================================================
 * 0. 输入：报告生成所需的 GameState 切片
 * ============================================================ */

export interface ReportSourceState {
  cityName: string;
  /** 当前在册项目（含在建/预警/停工/烂尾/竣工） */
  projects: Project[];
  /** 已爆破销项的历史快照（累计，无 demolishedAt） */
  demolishedProjects: Project[];
  /** 市民反馈（按 createdAt 年份过滤取当年） */
  feedbacks: CitizenFeedback[];
  /** 历年施政方针（优先按 year 取目标年份方针） */
  policyHistory: AnnualPolicy[];
  /** 当前年份方针（仅当 targetYear===currentYear 且 history 缺失时兜底） */
  currentPolicy: AnnualPolicy | null;
  /** 当前年份（用于方针兜底判断） */
  currentYear: number;
}

/* ============================================================
 * 1. 工具
 * ============================================================ */

const yearOf = (ts: number): number => new Date(ts).getFullYear();

/** 当年立项集合（按 createdAt 年份归属；在册 + 已爆破快照都算曾经立过项） */
function newlyCreatedInYear(src: ReportSourceState, targetYear: number): Project[] {
  const all = [...src.projects, ...src.demolishedProjects];
  return all.filter((p) => yearOf(p.createdAt) === targetYear);
}

/** 当年竣工集合（按 completedAt 年份，允许跨年立项的项目计入；在册 + 已爆破快照） */
function completedInYear(src: ReportSourceState, targetYear: number): Project[] {
  const all = [...src.projects, ...src.demolishedProjects];
  return all.filter((p) => p.completedAt != null && yearOf(p.completedAt) === targetYear);
}

/** 目标年份施政方针：优先 policyHistory.find(year)，仅当目标年=当前年且缺失时兜底 currentPolicy */
export function resolveYearPolicy(src: ReportSourceState, targetYear: number): AnnualPolicy | null {
  const fromHistory = src.policyHistory.find((p) => p.year === targetYear);
  if (fromHistory) return fromHistory;
  if (targetYear === src.currentYear && src.currentPolicy) return src.currentPolicy;
  return null;
}

/** 文本是否包含阿拉伯数字或中文数字（用于 AI 评论段的 defensive guard） */
function containsNumber(text: string): boolean {
  return /[0-9]|[一二三四五六七八九十百千万零两]/.test(text);
}

/** 允许评论段提及本地项目名/方针名中的数字；只拦截模型重新编造统计数字。 */
function containsGeneratedNumber(text: string, context: ReportCommentaryContext): boolean {
  const allowed = [
    context.policy?.title ?? '',
    ...(context.completedProjectNames ?? []),
    ...(context.troubledProjectNames ?? []),
    ...(context.demolishedProjectNames ?? []),
  ].filter(Boolean);
  const scrubbed = allowed.reduce((value, name) => value.split(name).join(''), text);
  return containsNumber(scrubbed);
}

/* ============================================================
 * 2. 年度统计（全部本地确定性，AI 不参与）
 * ============================================================ */

export function computeAnnualStats(src: ReportSourceState, targetYear: number): AnnualReportStats {
  const created = newlyCreatedInYear(src, targetYear);
  const completedThisYear = completedInYear(src, targetYear);

  // completionRate 的分子/分母必须同一子集：当年新立项目中、同年即竣工的数量
  const createdIds = new Set(created.map((p) => p.id));
  const completedSameYear = completedThisYear.filter((p) => createdIds.has(p.id)).length;

  const totalProjects = created.length;
  const completed = completedThisYear.length; // 当年实际竣工数（可含跨年立项）
  const completionRate =
    totalProjects > 0 ? Math.round((completedSameYear / totalProjects) * 100) : 0;

  // 烂尾存量：报告生成当时在册 status==='abandoned'（snapshot 指标，不按年）
  const abandoned = src.projects.filter((p) => p.status === 'abandoned').length;

  // 累计销项：截至本年度末全市累计（无 demolishedAt，不按年归因）
  const demolished = src.demolishedProjects.length;

  // 累计复工：当年新立项目的 restartCount 之和（累计口径，非"本年度复工次数"）
  const restartCount = created.reduce((sum, p) => sum + (p.restartCount || 0), 0);

  const policy = resolveYearPolicy(src, targetYear);

  return {
    year: targetYear,
    totalProjects,
    completed,
    completedSameYear,
    abandoned,
    demolished,
    restartCount,
    completionRate,
    policyTitle: policy?.title ?? '（未设定施政方针）',
  };
}

/* ============================================================
 * 3. 典型项目名 / 市民反馈摘要（本地）
 * ============================================================ */

/** 当年竣工典型项目名（1–2 个，供第一部分正面点评；无数字） */
function completedHighlights(src: ReportSourceState, targetYear: number): string[] {
  return completedInYear(src, targetYear).slice(0, 2).map((p) => p.name);
}

/** 停滞/销项典型项目名（1–2 个，供第二部分停工原因；取当前烂尾 + 已销项快照） */
function troubledHighlights(src: ReportSourceState): string[] {
  const abandoned = src.projects.filter((p) => p.status === 'abandoned').map((p) => p.name);
  const demolished = src.demolishedProjects.map((p) => p.name);
  return [...abandoned, ...demolished].slice(0, 2);
}

/** 爆破销项项目单独列出，供年报评论段区分"仍待治理"与"已经销项"。 */
function demolishedHighlights(src: ReportSourceState): string[] {
  return src.demolishedProjects.slice(0, 3).map((p) => p.name);
}

/** 当年市民好评摘要：数量 + 1 条代表文案（按 createdAt 年份过滤） */
function praiseSummary(src: ReportSourceState, targetYear: number): { count: number; sample: string | null } {
  const praises = src.feedbacks.filter(
    (f) => f.type === 'praise' && yearOf(f.createdAt) === targetYear,
  );
  return { count: praises.length, sample: praises[0]?.content ?? null };
}

/* ============================================================
 * 4. 事实段（含全部数字，代码直接生成，AI 不碰）
 * ============================================================ */

function reviewFactParagraph(stats: AnnualReportStats, praiseCount: number): string {
  const parts = [
    `全年共新立项重点建设项目 ${stats.totalProjects} 个，年内竣工 ${stats.completed} 个，` +
      `本年度新立项目年内完工率 ${stats.completionRate}%。`,
  ];
  if (praiseCount > 0) {
    parts.push(`本年度共收到市民正面评价 ${praiseCount} 条。`);
  }
  return parts.join('');
}

function problemsFactParagraph(stats: AnnualReportStats): string {
  return (
    `截至本年度末，全市存量烂尾工程 ${stats.abandoned} 项；` +
    `累计完成爆破销项 ${stats.demolished} 项，累计组织项目复工 ${stats.restartCount} 次。`
  );
}

/** 延续推进项目清单（当前在建/预警/停工项目名，代码生成，无统计计算） */
function outlookFactParagraph(src: ReportSourceState): string {
  const ongoing = src.projects
    .filter((p) => p.status === 'construction' || p.status === 'warning' || p.status === 'halted')
    .map((p) => p.name);
  if (ongoing.length === 0) return '当前无延续推进的在建项目。';
  const shown = ongoing.slice(0, 5);
  const more = ongoing.length > shown.length ? ` 等 ${ongoing.length} 个项目` : '';
  return `延续推进项目包括：${shown.map((n) => `「${n}」`).join('、')}${more}。`;
}

/* ============================================================
 * 5. 评论段种子（无数字，交 AI 润色；失败/Demo 回退种子本身）
 * ============================================================ */

function reviewCommentarySeed(stats: AnnualReportStats, highlights: string[]): string {
  const tone =
    stats.completionRate >= 60
      ? '评价本年度竣工成果和建设效率，指出形成成果的项目特点。'
      : stats.abandoned > 0
        ? '评价本年度推进不足与存量烂尾之间的关系，保持克制但要有明确判断。'
        : '评价本年度项目推进方式和建设节奏，避免泛泛而谈。';
  const hl = highlights.length ? `可结合竣工项目：${highlights.join('、')}。` : '没有典型竣工项目可点名。';
  return `${tone}${hl}请写一段政府工作报告中的年度建设总体评价，不写任何统计数字。`;
}

function problemsCommentarySeed(policy: AnnualPolicy | null, troubled: string[]): string {
  const policyCtx = policy ? `当年施政方针为"${policy.title}"，请评价方针落实情况。` : '请分析本年度存在的主要建设问题。';
  const cause = troubled.length
    ? `典型停工/烂尾项目：${troubled.join('、')}，请分析其代表性困难。`
    : '当前没有可点名的停工或烂尾项目。';
  return `${policyCtx}${cause}请写出最突出的问题、形成原因及方针落实判断，不写任何统计数字。`;
}

function outlookCommentarySeed(): string {
  return '请根据本年度建设表现和遗留问题，提出下一年度真正有针对性的工作重点，避免空洞套话，不写任何统计数字。';
}

function reviewCommentaryFallback(stats: AnnualReportStats): string {
  if (stats.completionRate >= 60) {
    return '本年度建设工作形成了一定成果，项目推进与验收衔接较为顺畅，城市建设的有效产出有所增加。';
  }
  if (stats.abandoned > 0) {
    return '本年度建设工作保持一定项目储备，但部分工程推进不足，新增建设与存量治理之间仍需更好统筹。';
  }
  return '本年度建设工作按既定方向推进，项目储备与实际施工之间的衔接仍有进一步完善空间。';
}

function problemsCommentaryFallback(stats: AnnualReportStats): string {
  if (stats.abandoned > 0) {
    return '当前突出问题是部分项目开工后缺少持续推进，施政方针在存量工程治理和施工约束方面仍需落实得更具体。';
  }
  if (stats.demolished > 0) {
    return '部分建设目标经过评估后转入销项，说明立项论证和后续调整机制仍需前置，避免资源长期沉淀。';
  }
  return '本年度未形成明显存量风险，但项目从立项到验收的连续管理仍需保持，防止阶段性成果转为长期搁置。';
}

function outlookCommentaryFallback(stats: AnnualReportStats, ongoing: string[]): string {
  if (stats.abandoned > 0) {
    return '下一年度应把存量工程分类治理放在更突出位置，减少无充分准备的新增立项，并为在建项目设置更清晰的收尾节点。';
  }
  if (ongoing.length > 0) {
    return '下一年度应围绕现有在建项目集中推进，完善施工备案、阶段验收和后续运营衔接，再根据实际能力审慎安排新增建设。';
  }
  return '下一年度应把建设重点从单纯增加项目转向提高项目质量，完善立项、施工、验收和运营的完整衔接。';
}

/* ============================================================
 * 6. 固定句（不可修改，REQ-10.2）
 * ============================================================ */

function reviewOpeningFixed(stats: AnnualReportStats): string {
  return `${stats.year}年，在市长的坚强领导下，全市上下坚持"${stats.policyTitle}"的建设方针，持续推进各项重点工程建设。`;
}

const PROBLEMS_TRANSITION_FIXED =
  '然而，我们也清醒地认识到，本年度城市建设工作中仍存在若干突出问题，不容忽视。';

function outlookOpeningFixed(targetYear: number): string {
  return `${targetYear + 1}年，本市将在巩固既有建设成果的基础上，重点聚焦以下工作目标：`;
}

/* ============================================================
 * 7. 编排：模板 → AI 润色（仅评论段）→ 拼合 AnnualReport
 * ============================================================ */

/**
 * 对评论段种子做 AI 润色；带 defensive guard：
 * 润色结果若混入数字（AI 误塞统计），回退种子，保证"数字只来自事实段"。
 * polishReportSection 在 Demo/失败时可能返回方向提示；此处统一换成确定性的可展示评论，再加数字守卫。
 */
async function polishCommentary(
  seed: string,
  stats: AnnualReportStats,
  projectNames: string[],
  context: ReportCommentaryContext,
  fallback: string,
): Promise<string> {
  try {
    const polished = await aiClient.polishReportSection(seed, stats, projectNames, context);
    const text = (polished || '').trim();
    if (!text || text === seed) return fallback;
    if (containsGeneratedNumber(text, context)) return fallback; // 评论段不应出现统计数字
    return text;
  } catch {
    return fallback;
  }
}

/**
 * 生成某年度政府工作报告（年末调用一次）。
 * 返回完整 AnnualReport；不持久化、不改年份、不生成方针候选（交 TASK-20）。
 */
export async function buildAnnualReport(
  src: ReportSourceState,
  targetYear: number,
): Promise<AnnualReport> {
  const stats = computeAnnualStats(src, targetYear);
  const policy = resolveYearPolicy(src, targetYear);
  const { count: praiseCount } = praiseSummary(src, targetYear);
  const highlights = completedHighlights(src, targetYear);
  const troubled = troubledHighlights(src);
  const demolished = demolishedHighlights(src);
  const ongoing = src.projects
    .filter((p) => p.status === 'construction' || p.status === 'warning' || p.status === 'halted')
    .map((p) => p.name);
  const feedbackSummary = src.feedbacks
    .filter((f) => yearOf(f.createdAt) === targetYear)
    .slice(0, 5)
    .map((f) => f.content)
    .filter(Boolean);
  const commentaryContext: ReportCommentaryContext = {
    policy,
    completedProjectNames: highlights,
    troubledProjectNames: troubled,
    demolishedProjectNames: demolished,
    feedbackSummary,
  };

  // 事实段（含数字，代码生成）
  const reviewFact = reviewFactParagraph(stats, praiseCount);
  const problemsFact = problemsFactParagraph(stats);
  const outlookFact = outlookFactParagraph(src);

  // 评论段（无数字，AI 根据真实上下文撰写）—— 三段并行
  const [reviewComment, problemsComment, outlookComment] = await Promise.all([
    polishCommentary(
      reviewCommentarySeed(stats, highlights),
      stats,
      highlights,
      commentaryContext,
      reviewCommentaryFallback(stats),
    ),
    polishCommentary(
      problemsCommentarySeed(policy, troubled),
      stats,
      troubled,
      commentaryContext,
      problemsCommentaryFallback(stats),
    ),
    polishCommentary(
      outlookCommentarySeed(),
      stats,
      [...highlights, ...troubled, ...ongoing],
      commentaryContext,
      outlookCommentaryFallback(stats, ongoing),
    ),
  ]);

  // 拼合：固定句 + 事实段 + 评论段
  const review = `${reviewOpeningFixed(stats)}${reviewFact}${reviewComment}`;
  const problems = `${PROBLEMS_TRANSITION_FIXED}${problemsFact}${problemsComment}`;
  const outlook = `${outlookOpeningFixed(targetYear)}${outlookFact}${outlookComment}`;

  return {
    year: targetYear,
    generatedAt: Date.now(),
    // 报告完整记录当年方针；缺失时以占位 policy（不影响 stats 已算好的数字）
    policy: policy ?? {
      year: targetYear,
      title: stats.policyTitle,
      description: '',
      source: 'mayor-selected',
    },
    stats,
    sections: {
      title: `${targetYear}年${src.cityName}市人民政府工作报告`,
      review,
      problems,
      outlook,
    },
  };
}
