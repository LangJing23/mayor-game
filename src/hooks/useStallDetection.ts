/**
 * useStallDetection —— 停工自动检测接入（TASK-13）。
 *
 * 时机：
 *  A. 挂载后（hydration 完成）立即执行一次全项目检查 —— 隔多天回来状态立即正确。
 *  B. 运行期每小时低频检查一次（阈值以"天"为单位，无需高频）。Timer 正确 cleanup。
 *
 * 推进：对每个需变化的项目，按 statusTransitionPath 顺序调用 store 的
 *       markWarning / markHalted / markAbandoned（尊重既有状态机守卫，逐级推进），
 *       一次检查即可跨级到达真实目标。不绕过状态机直接 patch。
 *
 * 通知：仅在"本次检查真正发生状态变化"时触发一次，且只报最高级别最终结果
 *       （跨级 construction→abandoned 只弹一条 abandoned，不连弹三条）。
 */
import { useEffect, useRef } from 'react';
import { useGameStore } from '@/store/gameStore';
import { detectStalls, statusTransitionPath } from '@/logic/stallDetector';
import type { ProjectStatus } from '@/store/types';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时

export interface StallChange {
  id: string;
  name: string;
  targetStatus: ProjectStatus; // 最终（最高级别）结果
}

export function useStallDetection(onChanges?: (changes: StallChange[]) => void): void {
  // ref 持有最新回调，避免回调引用变化重建 timer
  const cbRef = useRef(onChanges);
  cbRef.current = onChanges;

  useEffect(() => {
    const runCheck = () => {
      const store = useGameStore.getState();
      const now = Date.now();
      const evals = detectStalls(store.projects, now);
      if (evals.length === 0) return;

      const changes: StallChange[] = [];
      for (const ev of evals) {
        const path = statusTransitionPath(ev.currentStatus, ev.targetStatus);
        if (path.length === 0) continue;
        // 逐级推进（走 store 守卫）；重新取 getState 以引用最新 actions
        const s = useGameStore.getState();
        for (const step of path) {
          if (step === 'warning') s.markWarning(ev.id);
          else if (step === 'halted') s.markHalted(ev.id);
          else if (step === 'abandoned') s.markAbandoned(ev.id);
        }
        // 读取推进后项目真实名称 + 最终状态（最高级别）
        const proj = useGameStore.getState().projects.find((p) => p.id === ev.id);
        if (proj) {
          changes.push({ id: ev.id, name: proj.name, targetStatus: ev.targetStatus });
        }
      }
      if (changes.length > 0) cbRef.current?.(changes);
    };

    // A. 挂载即查一次
    runCheck();
    // B. 低频轮询
    const timer = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // onChanges 用 ref 语义：这里有意只在挂载时建立，避免因回调引用变化重建 timer。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
