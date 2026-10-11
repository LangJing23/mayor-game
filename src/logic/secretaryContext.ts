/**
 * 市长办公室 AI 秘书 —— 事实上下文构建（src/logic/secretaryContext.ts）
 *
 * 纯函数，无 UI、无 LLM 调用、无 Zustand 读写（由调用方传入 GameState 切片）。
 * 职责（TASK-16，第 12/13 条）：
 *   GameState → 本地计算事实 → 构造秘书上下文（供 UI 简报、Mock 秘书、真实 AI 共享同一份事实）。
 *
 * 关键原则：
 * - 状态数量、风险排序、项目列表全部由本地逻辑确定性计算，不交给模型去"算"。
 * - 模型只负责理解问题 + 组织语言；事实边界由此模块锁定。
 * - 不虚构：completionEstimate / 财政数字等 GameState 没有的字段，这里一律不产出。
 */

import type {
  AnnualPolicy,
  CitizenFeedback,
  CityContext,
  FeedbackType,
  Project,
  ProjectStatus,
} from '@/store/types';

/* ============================================================
 * 1. 类型
 * ============================================================ */

/** 简报用的分状态计数 */
export interface CityBrief {
  total: number;
  construction: number;
  warning: number;
  halted: number;
  abandoned: number;
  completed: number;
  policyTitle: string | null;
  policyDescription: string | null;
  /** 需重点关注的项目（已按优先级排序，最多 3 项） */
  priority: PriorityProject[];
}

/** 风险项目（含一句话原因，供简报直接展示） */
export interface PriorityProject {
  id: string;
  name: string;
  status: ProjectStatus;
  /** 距最后一次施工的天数（向下取整） */
  stalledDays: number;
  /** 一句话风险说明（本地确定性生成，不虚构数字） */
  reason: string;
}

/** 传给 AI 的轻量项目快照（只含秘书问答真正需要的字段） */
export interface SecretaryProjectBrief {
  id: string;
  name: string;
  type: string;
  status: ProjectStatus;
  goal: string;
  duration?: string;
  progressScheduleText?: string;
  acceptanceCriteria: string;
  /** 距最后施工天数 */
  stalledDays: number;
  restartCount: number;
}

/** 传给 AI 的最近市民热线摘要 */
export interface SecretaryFeedbackBrief {
  type: FeedbackType;
  content: string;
  projectName?: string;
}

/**
 * 秘书事实上下文（本地计算的全部事实）。
 * 比 CityContext 丰富：含逐项目明细、风险排序、最近热线/公告。
 * aiClient.chat 仍接收标准 CityContext（见 toCityContext），本结构额外注入到 user 侧事实块。
 */
export interface SecretaryContext {
  cityName: string;
  currentYear: number;
  currentPolicy: AnnualPolicy | null;
  brief: CityBrief;
  projects: SecretaryProjectBrief[];
  recentFeedbacks: SecretaryFeedbackBrief[];
  recentAnnouncements: string[];
}

/* ============================================================
 * 2. 工具
 * ============================================================ */

const DAY_MS = 86_400_000;

const STATUS_LABEL: Record<ProjectStatus, string> = {
  construction: '在建',
  warning: '施工预警',
  halted: '停工',
  abandoned: '烂尾',
  completed: '竣工',
};

export function statusLabel(s: ProjectStatus): string {
  return STATUS_LABEL[s];
}

/** 风险优先级：abandoned > halted > warning > construction > completed */
const STATUS_PRIORITY: Record<ProjectStatus, number> = {
  abandoned: 4,
  halted: 3,
  warning: 2,
  construction: 1,
  completed: 0,
};

/** 距最后一次施工的天数（向下取整，至少 0） */
export function stalledDaysOf(p: Project, now: number): number {
  return Math.max(0, Math.floor((now - p.lastProgressAt) / DAY_MS));
}

/** 一句话风险说明（本地确定性，不虚构硬数字；completed 不作为风险项） */
function riskReason(p: Project, stalledDays: number): string {
  switch (p.status) {
    case 'abandoned':
      return `已进入烂尾状态，处置优先级高于普通停工与预警项目`;
    case 'halted':
      return `已停工，累计约 ${stalledDays} 天无有效施工记录`;
    case 'warning':
      return `已进入施工预警，近期施工频率明显下降`;
    case 'construction':
      return `在建中，当前施工节奏基本正常`;
    case 'completed':
      return `已竣工`;
  }
}

/* ============================================================
 * 3. 城市简报（确定性，不依赖 LLM）
 * ============================================================ */

/**
 * 统计分状态数量 + 施政方针 + 风险项目列表。
 * 用户一打开办公室即可用本函数本地渲染，无需任何 AI 请求。
 */
export function buildCityBrief(
  projects: Project[],
  currentPolicy: AnnualPolicy | null,
  now: number = Date.now(),
): CityBrief {
  const counts = { construction: 0, warning: 0, halted: 0, abandoned: 0, completed: 0 };
  for (const p of projects) counts[p.status] += 1;

  return {
    total: projects.length,
    construction: counts.construction,
    warning: counts.warning,
    halted: counts.halted,
    abandoned: counts.abandoned,
    completed: counts.completed,
    policyTitle: currentPolicy?.title ?? null,
    policyDescription: currentPolicy?.description ?? null,
    priority: getPriorityProjects(projects, now),
  };
}

/**
 * 需重点关注的项目（最多 3 项），排序规则：
 *   1. 状态优先级 abandoned > halted > warning（construction/completed 不进入风险列表）；
 *   2. 同状态按停滞天数降序（停得越久越靠前）。
 */
export function getPriorityProjects(projects: Project[], now: number = Date.now()): PriorityProject[] {
  return projects
    .filter((p) => p.status === 'abandoned' || p.status === 'halted' || p.status === 'warning')
    .map((p) => {
      const stalledDays = stalledDaysOf(p, now);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        stalledDays,
        reason: riskReason(p, stalledDays),
      };
    })
    .sort((a, b) => {
      const d = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
      if (d !== 0) return d;
      return b.stalledDays - a.stalledDays;
    })
    .slice(0, 3);
}

/* ============================================================
 * 4. 简报文本（纯函数，Mock 与 UI 空态复用）
 * ============================================================ */

/**
 * 把简报渲染为一句正式市政汇报文本。
 * 供 Mock 秘书的"城市概况"回答，以及无 AI 时的兜底回答复用。
 */
export function briefToText(brief: CityBrief): string {
  if (brief.total === 0) {
    return `市长，当前本市台账暂无建设项目记录。可通过「申请立项」启动首个城市建设项目。`;
  }
  const head =
    `市长，目前全市共有建设项目 ${brief.total} 项，其中在建 ${brief.construction} 项、` +
    `施工预警 ${brief.warning} 项、停工 ${brief.halted} 项、烂尾 ${brief.abandoned} 项、` +
    `已竣工 ${brief.completed} 项。`;

  if (brief.priority.length === 0) {
    return head + `当前各项目推进总体平稳，暂无需紧急处置的存量工程。`;
  }
  const names = brief.priority.map((p) => `「${p.name}」`).join('、');
  return head + `当前建议重点关注${names}等存量项目。`;
}

/* ============================================================
 * 5. 构造秘书上下文（供 AI user 侧事实块 + Mock）
 * ============================================================ */

const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  complaint: '投诉',
  suggestion: '建议',
  praise: '表扬',
  question: '咨询',
};

export function feedbackTypeLabel(t: FeedbackType): string {
  return FEEDBACK_TYPE_LABEL[t];
}

/**
 * 构造完整秘书事实上下文。
 * recentFeedbacks / recentAnnouncements 做轻量裁剪（最近若干条），不把全量历史塞给模型。
 */
export function buildSecretaryContext(args: {
  cityName: string;
  currentYear: number;
  currentPolicy: AnnualPolicy | null;
  projects: Project[];
  feedbacks: CitizenFeedback[];
  announcements: string[];
  now?: number;
  maxFeedbacks?: number;
  maxAnnouncements?: number;
}): SecretaryContext {
  const {
    cityName,
    currentYear,
    currentPolicy,
    projects,
    feedbacks,
    announcements,
    now = Date.now(),
    maxFeedbacks = 5,
    maxAnnouncements = 5,
  } = args;

  const projectNameById = new Map(projects.map((p) => [p.id, p.name] as const));

  const projBriefs: SecretaryProjectBrief[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    status: p.status,
    goal: p.plan?.goal ?? p.originalInput,
    duration: p.plan?.duration,
    progressScheduleText: p.plan?.progressScheduleText,
    acceptanceCriteria: p.plan?.acceptanceCriteria ?? '',
    stalledDays: stalledDaysOf(p, now),
    restartCount: p.restartCount,
  }));

  const recentFeedbacks: SecretaryFeedbackBrief[] = [...feedbacks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxFeedbacks)
    .map((f) => ({
      type: f.type,
      content: f.content,
      projectName: f.projectId ? projectNameById.get(f.projectId) : undefined,
    }));

  const recentAnnouncements = [...announcements].slice(-maxAnnouncements).reverse();

  return {
    cityName,
    currentYear,
    currentPolicy,
    brief: buildCityBrief(projects, currentPolicy, now),
    projects: projBriefs,
    recentFeedbacks,
    recentAnnouncements,
  };
}

/* ============================================================
 * 6. CityContext 适配（复用 aiClient.chat 既有签名）
 * ============================================================ */

/** 把秘书上下文的计数部分转为 aiClient.chat 需要的标准 CityContext。 */
export function toCityContext(ctx: SecretaryContext): CityContext {
  return {
    cityName: ctx.cityName,
    year: ctx.currentYear,
    construction: ctx.brief.construction,
    warning: ctx.brief.warning,
    halted: ctx.brief.halted,
    completed: ctx.brief.completed,
    abandoned: ctx.brief.abandoned,
    currentPolicyTitle: ctx.currentPolicy?.title ?? '（暂未选定施政方针）',
    currentPolicyDescription: ctx.currentPolicy?.description ?? '',
  };
}

/* ============================================================
 * 7. 项目识别（自然语言简称 → 真实 Project；简单关键词匹配，不做向量检索）
 * ============================================================ */

/** 问题文本里剔除的通用词，避免"项目/工程/怎么样"等干扰匹配 */
const STOPWORDS = /项目|工程|怎么样|如何|进展|情况|状态|那个|这个|一下|现在|最近|的|了|吗|呢|啊/g;

/**
 * 在用户问题中尝试关联一个真实项目。
 * 策略（MVP）：
 *   1. 先按 name / goal / originalInput 的子串命中；
 *   2. 再按去停用词后的关键字符片段命中；
 *   3. 命中多个时取"问题中出现位置最靠前 + 名称最长"的一个，返回最相关项目；无命中返回 null。
 * 仅做轻量匹配，项目数量少，不过度工程化。
 */
export function matchProject(question: string, projects: Project[]): Project | null {
  if (!question.trim() || projects.length === 0) return null;
  const q = question.toLowerCase();

  // 1) 直接子串：项目名 / 目标 / 原始输入出现在问题里，或问题关键片段出现在它们里
  const cleaned = question.replace(STOPWORDS, '').trim();
  const fragments = cleaned
    .split(/[\s，。、,.?？!！;；:：]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  let best: { project: Project; score: number } | null = null;
  for (const p of projects) {
    const hay = `${p.name} ${p.plan?.goal ?? ''} ${p.originalInput}`.toLowerCase();
    let score = 0;

    // 项目名整体出现在问题里（最强信号）
    if (q.includes(p.name.toLowerCase())) score += 100 + p.name.length;

    // 问题关键片段命中项目文本
    for (const frag of fragments) {
      const f = frag.toLowerCase();
      if (f.length >= 2 && hay.includes(f)) score += Math.min(f.length, 8);
    }

    if (score > 0 && (!best || score > best.score)) best = { project: p, score };
  }
  return best ? best.project : null;
}
