/**
 * 施工备案逻辑（src/logic/progressTracker.ts）
 *
 * 职责：封装"今日有施工"的完整数据流——AI 正式化（可选）→ 创建 ProgressRecord → 写 Store。
 * 不含 UI；由 ProjectCard 调用。AI 调用集中在 aiClient，本模块只编排。
 *
 * 规则（TASK-12）：
 * - 用户填了备注 → 调 aiClient.formalizeProgressNote 正式化；失败则保存原始文本，不阻塞备案。
 * - 用户留空 → 不调用 AI，直接备案。
 * - recordProgress 由 store 负责更新 lastProgressAt / 追加记录 / warning·halted 恢复 construction。
 */

import { aiClient } from '@/ai/aiClient';
import { useGameStore, genId } from '@/store/gameStore';
import type { ProgressRecord } from '@/store/types';

function todayDate(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface RecordProgressResult {
  record: ProgressRecord;
  /** 备案前项目是否处于 warning/halted（用于"已恢复正常施工"文案判断） */
  recovered: boolean;
}

/**
 * 提交一次施工备案。
 * @param projectId 目标项目
 * @param rawNote   市长填写的今日施工内容（可空）
 * @returns 结果，含生成的记录与是否由预警/停工恢复
 */
export async function submitProgress(
  projectId: string,
  rawNote: string,
): Promise<RecordProgressResult | null> {
  const store = useGameStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;

  // 仅 construction/warning/halted 可备案（与 store.recordProgress 守卫一致；此处提前拦截）
  if (!['construction', 'warning', 'halted'].includes(project.status)) return null;

  const recovered = project.status === 'warning' || project.status === 'halted';
  const trimmed = rawNote.trim();

  // 可选 AI 正式化：填了才调用；失败/留空都不阻塞
  let note: string | undefined;
  let rawStored: string | undefined;
  if (trimmed) {
    rawStored = trimmed;
    try {
      const formal = await aiClient.formalizeProgressNote(trimmed, project.name);
      note = formal || trimmed; // 失败/空 → 用原始文本
    } catch {
      note = trimmed; // 异常也不阻塞，保存原始文本
    }
  }

  const record: ProgressRecord = {
    id: genId('pr'),
    projectId,
    date: todayDate(),
    note,
    rawNote: rawStored,
    source: 'manual',
  };

  // 写 Store：更新 lastProgressAt、追加记录、warning/halted → construction
  useGameStore.getState().recordProgress(projectId, record);

  return { record, recovered };
}

/**
 * 仅 Demo 演示用：为项目注入若干历史施工记录，并把 lastProgressAt 设为最近一条记录的日期。
 * 用于快速演示 施工→预警→停工→烂尾 链路（配合 TASK-13 的停滞检测）。
 *
 * 时间一致性（修复 Demo 台账时间悖论）：
 *   注入时同时把立项时间前移到早于最早一条施工记录（最早记录再往前约 7 天），
 *   保证 createdAt ≤ 最早施工记录 ≤ 最近施工记录(lastProgressAt) ≤ now 单调一致，
 *   杜绝"尚未立项就已施工""项目存续 0 天却停工 62 天"等矛盾。
 *
 * @param projectId 目标项目
 * @param daysBack  各历史记录距今天数（如 [35,25,15,5]）
 */
export function injectDemoProgressHistory(projectId: string, daysBack: number[]): void {
  const store = useGameStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project || daysBack.length === 0) return;

  const dayMs = 86_400_000;
  const now = Date.now();
  // 从早到晚排序（降序 daysBack：数值越大越早），生成记录
  const sorted = [...daysBack].sort((a, b) => b - a);
  const records: ProgressRecord[] = sorted.map((d, i) => {
    const ts = now - d * dayMs;
    const dt = new Date(ts);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    return {
      id: genId('pr'),
      projectId,
      date,
      note: `（演示）第 ${i + 1} 次历史施工备案。`,
      source: 'demo',
    };
  });
  // 最后一条（最近）的时间作为 lastProgressAt，模拟"此后再无施工"
  const latestTs = now - sorted[sorted.length - 1] * dayMs;
  // 立项时间：早于最早一条施工记录约 7 天（最早记录 = sorted[0]，距今天数最大）
  const earliestDays = sorted[0];
  const demoCreatedAt = now - (earliestDays + 7) * dayMs;
  useGameStore.getState().injectDemoProgress(projectId, records, latestTs, demoCreatedAt);
}
