/**
 * useGameLoop —— requestAnimationFrame 游戏循环 hook。
 *
 * 职责：按帧调用传入的 callback(nowMs, dtMs)，并在卸载/依赖变更时正确清理，
 * 避免重复创建多个 loop。页面卸载后停止。
 */
import { useEffect, useRef } from 'react';

type FrameCallback = (nowMs: number, dtMs: number) => void;

/**
 * @param callback 每帧回调
 * @param running  是否运行（false 时暂停循环，用于年度会议"城市暂停"等场景）
 */
export function useGameLoop(callback: FrameCallback, running = true): void {
  // 用 ref 保存最新 callback，避免因 callback 变化而反复重建 rAF 循环
  const cbRef = useRef<FrameCallback>(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!running) return;

    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const tick = (now: number) => {
      if (stopped) return;
      const dt = now - last;
      last = now;
      cbRef.current(now, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [running]);
}
