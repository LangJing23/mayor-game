/**
 * 烂尾工程专项审计 —— 台账事实与情绪发票（src/logic/auditFacts.ts）
 *
 * 纯函数，无 UI、无 LLM、无 Zustand。全部数据来自真实 Project / ProgressRecord / 当前时间，
 * 属于 derived data（展示时确定性计算），**不写入持久化、不扩展 AuditReport 契约**。
 *
 * 职责边界（TASK-17）：
 * - 本模块只产出"台账事实"（可核验的真实数据）。
 * - completionEstimate / stopReasons / conclusion 属于"审计判断"，由 aiClient.auditProject 产出，不在此。
 * - 情绪发票是市政隐喻，不是财务核算：不虚构金钱、不虚构工时、不做心理诊断、不伪造情绪。
 */

import type { ProgressRecord, Project, ProgressFrequency } from '@/store/types';

const DAY_MS = 86_400_000;

const FREQ_LABEL: Record<ProgressFrequency, string> = {
  daily: '每日施工',
  'several-times-weekly': '每周多次施工',
  weekly: '每周施工',
  'long-term': '长期推进',
};

/** 天数（向下取整，至少 0） */
function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

/** 'YYYY-MM-DD' → '10月8日'；非法输入原样返回 */
function fmtRecordDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 'YYYY-MM-DD' → 当天 00:00 的毫秒时间戳；非法返回 null（不参与比较） */
function recordDateMs(date: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 时间戳 → 当天 00:00 毫秒（用于与仅精确到日的施工记录做同口径比较） */
function startOfDayMs(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 时间戳 → 'YYYY年M月D日' */
function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 判断建设目标是否明显无效（空、过短、或仅由助词/标点构成）。
 * 用于审计报告的安全 fallback —— 审计报告标注"可核验"，不应展示"建设目标：的"这类脏数据。
 */
function isInvalidGoal(goal: string | undefined | null): boolean {
  const g = (goal ?? '').trim();
  if (g.length < 2) return true; // 空或单字（如"的"）视为无效
  // 仅由中文助词/连词/标点构成的也视为无效
  const onlyParticles = /^[的了吗呢啊呀和与及或者、，。,.\s]+$/;
  return onlyParticles.test(g);
}

/**
 * 解析用于展示的建设目标，带安全 fallback：
 *   plan.goal 有效 → goal
 *   否则 originalInput 有效 → originalInput
 *   否则 → 项目名称 / 「按原立项方案推进」
 */
function resolveGoal(project: Project): string {
  const goal = project.plan?.goal;
  if (!isInvalidGoal(goal)) return goal!.trim();
  const orig = project.originalInput;
  if (!isInvalidGoal(orig)) return orig.trim();
  const name = project.name?.trim();
  return name && name.length >= 2 ? name : '按原立项方案推进';
}

/* ============================================================
 * 1. 审计台账事实（真实、可核验）
 * ============================================================ */

/** 单条施工备案摘要（供"二、施工及停工事实"折叠展示最近几条） */
export interface AuditFactRecord {
  dateLabel: string; // '10月8日'
  note: string; // 施工内容或占位
  isDemo: boolean;
}

export interface AuditFacts {
  /** 立项时间文本 */
  createdAtText: string;
  /** 建设目标（来自 plan.goal，退回 originalInput） */
  goal: string;
  /** 原计划建设周期（plan.duration，可能缺省） */
  plannedDuration?: string;
  /** 精确施工安排原文（plan.progressScheduleText，可能缺省） */
  scheduleText?: string;
  /** 施工频率标签 */
  frequencyLabel: string;
  /** 实际施工备案次数（真实 progressRecords 长度） */
  progressCount: number;
  /** 最近一次施工时间文本 */
  lastProgressText: string;
  /** 当前连续未施工天数（now - lastProgressAt） */
  idleDays: number;
  /** 项目已历时天数（now - createdAt） */
  ageDays: number;
  /** 正式复工次数（restartCount） */
  restartCount: number;
  /**
   * 是否曾经历预警 / 停工阶段。
   * 依据冻结后的核心状态链：construction→warning→halted→abandoned，
   * abandoned 必然经过 warning 与 halted（这是状态机事实，而非虚构）。
   */
  everWarned: boolean;
  everHalted: boolean;
  /** 认定烂尾时间（abandonedAt，可能缺省） */
  abandonedAtText?: string;
  /** 最近若干条施工备案（倒序，最多 maxRecords 条） */
  recentRecords: AuditFactRecord[];
}

/**
 * 从真实 Project + 当前时间构造审计台账事实。
 * 全部字段可核验，不含任何 AI 判断或估算。
 */
export function buildAuditFacts(project: Project, now: number = Date.now(), maxRecords = 5): AuditFacts {
  const allRecords: ProgressRecord[] = project.progressRecords ?? [];

  // Defensive guard：剔除早于立项日期的异常记录（不可能"立项前已施工"）。
  // 这类记录视为脏数据，不作为"可核验施工事实"展示；开发环境提示一次。
  const createdDayStart = startOfDayMs(project.createdAt);
  const records = allRecords.filter((r) => {
    const ts = recordDateMs(r.date);
    const valid = ts === null || ts >= createdDayStart;
    if (!valid && import.meta.env?.DEV) {
      console.warn(
        `[auditFacts] 丢弃异常施工记录（早于立项）：project=${project.id} record.date=${r.date} createdAt=${new Date(project.createdAt).toISOString().slice(0, 10)}`,
      );
    }
    return valid;
  });

  const recentRecords: AuditFactRecord[] = [...records]
    .reverse()
    .slice(0, maxRecords)
    .map((r) => ({
      dateLabel: fmtRecordDate(r.date),
      note: r.note?.trim() || '（未填写施工内容）',
      isDemo: r.source === 'demo',
    }));

  // abandoned 必经 warning/halted；若还有复工记录，更能佐证曾经停滞后恢复过
  const isAbandoned = project.status === 'abandoned';
  const everWarned = isAbandoned || project.restartCount > 0 || project.status === 'warning' || project.status === 'halted';
  const everHalted = isAbandoned || project.restartCount > 0 || project.status === 'halted';

  return {
    createdAtText: fmtDate(project.createdAt),
    goal: resolveGoal(project),
    plannedDuration: project.plan?.duration?.trim() || undefined,
    scheduleText: project.plan?.progressScheduleText?.trim() || undefined,
    frequencyLabel: FREQ_LABEL[project.progressFrequency],
    progressCount: records.length,
    lastProgressText: fmtDate(project.lastProgressAt),
    idleDays: daysBetween(project.lastProgressAt, now),
    ageDays: daysBetween(project.createdAt, now),
    restartCount: project.restartCount,
    everWarned,
    everHalted,
    abandonedAtText: project.abandonedAt ? fmtDate(project.abandonedAt) : undefined,
    recentRecords,
  };
}

/* ============================================================
 * 2. 情绪发票（市政隐喻，非财务核算）
 * ============================================================ */

/** 情绪发票的一行条目（左标签 + 右数值文本），全部来自真实台账 */
export interface InvoiceLine {
  label: string;
  value: string;
}

export interface EmotionalInvoice {
  lines: InvoiceLine[];
  /** 一条克制的定性审计意见（基于真实数据分档，不含虚构数字） */
  verdict: string;
}

/**
 * 构造"项目沉没投入与情绪发票"。
 * 数字全部来自真实 Project / ProgressRecord / 当前时间：
 *   已备案施工次数 / 项目存续天数 / 距最近施工天数 / 正式复工次数 / 占用心理建设用地（固定 1 宗）。
 * 不出现金钱、工时、完成百分比等无数据依据的量；verdict 为定性措辞，按真实数据分档。
 */
export function buildEmotionalInvoice(project: Project, now: number = Date.now()): EmotionalInvoice {
  const f = buildAuditFacts(project, now);

  const lines: InvoiceLine[] = [
    { label: '已备案施工', value: `${f.progressCount} 次` },
    { label: '项目存续', value: `${f.ageDays} 天` },
    { label: '距最近施工', value: `${f.idleDays} 天` },
    { label: '正式复工次数', value: `${f.restartCount} 次` },
    { label: '当前占用心理建设用地', value: '1 宗' },
  ];

  // 定性意见分档（仅依据真实数据，不虚构具体金额/工时）
  let verdict: string;
  if (f.progressCount === 0) {
    verdict =
      '该项目自立项以来未形成有效施工备案，已构成实质性空转，长期维持停摆状态将持续占用注意力与心理建设用地。';
  } else if (f.idleDays >= f.ageDays / 2) {
    verdict =
      '该项目已形成一定沉没投入，但停摆时间已接近其存续周期的较大比例，继续长期维持将持续占用注意力与心理建设用地。';
  } else {
    verdict =
      '该项目已形成一定沉没投入，当前处于长期停摆状态，继续维持将持续占用注意力与心理建设用地，建议纳入专项处置评估。';
  }

  return { lines, verdict };
}
