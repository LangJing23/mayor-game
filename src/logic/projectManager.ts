/**
 * 烂尾工程治理编排（src/logic/projectManager.ts）—— TASK-18。
 *
 * 职责：编排复工 / 规划降级 / 爆破销项三条治理路径的业务流，复用既有 store actions 与 aiClient，
 * 不含 UI、不自行渲染、不直接发起 Canvas 动画。
 *
 * 治理前置：三条路径都建立在"已完成专项审计"（project.auditReport != null）之后，由治理 UI 保证入口可见性。
 *
 * 边界（city-lifecycle steering）：
 * - 只有 TASK-18 真正改变项目状态；审计（TASK-17）保持只读。
 * - 爆破必须先播放 TASK-05 动画，动画完成回调里才 demolishProject —— 本模块只提供"执行删除"函数，
 *   动画编排在 CityScene/CityCanvas，不在此处直接删除。
 * - demolishProject 仅由爆破治理调用，不被任何自动流程调用。
 */

import { aiClient } from '@/ai/aiClient';
import { deriveBuildingType } from '@/ai/semantics';
import { useGameStore } from '@/store/gameStore';
import type { Project, ProjectDraft } from '@/store/types';

/* ============================================================
 * 1. 复工
 * ============================================================ */

/**
 * 复工：对已审计的 abandoned 项目调用 store.restartProject。
 * store 内部：status→construction、lastProgressAt=now、restartCount+1、当前 auditReport 归档并清空。
 * @returns 复工后的项目快照（供上层发通知/反馈），项目不存在时返回 null。
 */
export function restartProjectAction(id: string): Project | null {
  const store = useGameStore.getState();
  const before = store.projects.find((p) => p.id === id);
  if (!before) return null;
  store.restartProject(id);
  return useGameStore.getState().projects.find((p) => p.id === id) ?? null;
}

/* ============================================================
 * 2. 规划降级（两步：生成草案 → 市长审定批准）
 * ============================================================ */

/**
 * 第一步：根据市长输入的缩减要求，调用 aiClient.downgradeProject 生成缩减版草案。
 * 仅生成供审定，不写 Store。aiClient 内部已带 mock/降级兜底，不会抛错。
 */
export async function generateDowngradeDraft(project: Project, newInput: string): Promise<ProjectDraft> {
  return aiClient.downgradeProject(project, newInput);
}

/**
 * 第二步：市长审定后批准降级。
 * 用市长审定后的字段覆盖草案关键项，并在批准瞬间按最终草案确定性重算 buildingType
 * （不信任 AI 初稿 buildingType），再写入 store.downgradeProject。
 * store 内部：覆盖档案 + 生成新 ProjectPlan、status→construction、归档当前 auditReport。
 * @returns 降级后的项目快照，项目不存在时返回 null。
 */
export function approveDowngrade(
  id: string,
  reviewedDraft: ProjectDraft,
  newOriginalInput: string,
): Project | null {
  const store = useGameStore.getState();
  if (!store.projects.find((p) => p.id === id)) return null;
  // 批准瞬间重算楼型，保证规模收缩反映到建筑外观（规划降级通常收缩为更矮楼型）
  const finalDraft: ProjectDraft = { ...reviewedDraft, buildingType: deriveBuildingType(reviewedDraft) };
  store.downgradeProject(id, finalDraft, newOriginalInput);
  return useGameStore.getState().projects.find((p) => p.id === id) ?? null;
}

/* ============================================================
 * 3. 爆破销项（删除与动画分离）
 * ============================================================ */

/**
 * 爆破前获取项目快照（在删除之前调用）。
 * 爆破会把项目移出 projects，之后无法再从 active projects 查到；
 * 通知/市民反馈必须基于此快照，不能依赖删除后的 store。
 */
export function getDemolishSnapshot(id: string): Project | null {
  const p = useGameStore.getState().projects.find((proj) => proj.id === id);
  return p ? { ...p } : null;
}

/**
 * 执行爆破销项删除。**必须在爆破动画完成回调里调用**，不得先于动画。
 * store.demolishProject：从 projects 移除（释放 citySlot）→ 完整快照进 demolishedProjects。
 */
export function demolishProjectAction(id: string): void {
  useGameStore.getState().demolishProject(id);
}
