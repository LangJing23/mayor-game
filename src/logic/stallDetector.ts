/**
 * 停工判定（src/logic/stallDetector.ts）—— 纯逻辑，无 React / 无副作用。
 *
 * 职责（TASK-13 唯一职责）：根据项目距最近一次有效施工的真实 elapsed time，
 * 自动判定目标状态 construction → warning → halted → abandoned。
 *
 * 复用现有：FREQUENCY_THRESHOLDS、progressFrequency、lastProgressAt（见 TASK-12/26）。
 * 不重新实现施工备案；状态写入仍走 Store 既有状态机守卫（见 useStallDetection）。
 *
 * 基准：优先 lastProgressAt；新立项无施工记录时回退 createdAt（保证最终仍会停工）。
 * 判定仅用粗粒度 progressFrequency；progressScheduleText 仅用于展示，不参与判定。
 */

import type { Project, ProjectStatus } from '@/store/types';
import { FREQUENCY_THRESHOLDS } from '@/store/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 参与自动检测的状态（completed/abandoned 不参与） */
const DETECTABLE: ProjectStatus[] = ['construction', 'warning', 'halted'];

export interface StallEvaluation {
  id: string;
  currentStatus: ProjectStatus;
  /** 按 inactiveDays 推导出的真实目标状态 */
  targetStatus: ProjectStatus;
  /** 距最近一次有效施工的完整未施工天数（>=0） */
  inactiveDays: number;
  /** 目标状态是否与当前不同（需要推进） */
  changed: boolean;
}

/** 最近施工时间基准：lastProgressAt 优先，缺失/为 0 时回退 createdAt */
function referenceTime(project: Project): number {
  return project.lastProgressAt > 0 ? project.lastProgressAt : project.createdAt;
}

/** 完整未施工天数；未来时间（now < 基准）钳为 0，避免负数 */
export function computeInactiveDays(project: Project, now: number): number {
  const elapsed = now - referenceTime(project);
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / DAY_MS);
}

/**
 * 评估单个项目的目标状态（纯函数）。
 * completed / abandoned 不参与检测：targetStatus === currentStatus，changed=false。
 */
export function evaluateProjectStatus(project: Project, now: number): StallEvaluation {
  const currentStatus = project.status;
  const inactiveDays = computeInactiveDays(project, now);

  if (!DETECTABLE.includes(currentStatus)) {
    return { id: project.id, currentStatus, targetStatus: currentStatus, inactiveDays, changed: false };
  }

  const [warn, halt, aband] = FREQUENCY_THRESHOLDS[project.progressFrequency];

  // 从最高严重程度向下判断
  let targetStatus: ProjectStatus;
  if (inactiveDays >= aband) targetStatus = 'abandoned';
  else if (inactiveDays >= halt) targetStatus = 'halted';
  else if (inactiveDays >= warn) targetStatus = 'warning';
  else targetStatus = 'construction';

  return {
    id: project.id,
    currentStatus,
    targetStatus,
    inactiveDays,
    changed: targetStatus !== currentStatus,
  };
}

/** 批量评估，仅返回需要变化的项目 */
export function detectStalls(projects: Project[], now: number): StallEvaluation[] {
  return projects.map((p) => evaluateProjectStatus(p, now)).filter((e) => e.changed);
}

/** 状态严重级别排序（用于判断 target 是否"更严重"，决定推进方向） */
const SEVERITY: Record<ProjectStatus, number> = {
  construction: 0,
  warning: 1,
  halted: 2,
  abandoned: 3,
  completed: 0, // 不参与
};

/**
 * 计算从 current 到 target 需要顺序执行的状态推进序列（尊重状态机守卫，逐级推进）。
 * 仅支持"更严重"方向（construction→warning→halted→abandoned）；
 * 若 target 不比 current 严重（如施工备案已恢复），返回空数组（不由本模块回退）。
 */
export function statusTransitionPath(
  current: ProjectStatus,
  target: ProjectStatus,
): Array<'warning' | 'halted' | 'abandoned'> {
  if (SEVERITY[target] <= SEVERITY[current]) return [];
  const order: Array<'warning' | 'halted' | 'abandoned'> = ['warning', 'halted', 'abandoned'];
  // 取严重级别位于 (current, target] 区间的所有状态，逐级推进
  return order.filter((s) => SEVERITY[s] > SEVERITY[current] && SEVERITY[s] <= SEVERITY[target]);
}
