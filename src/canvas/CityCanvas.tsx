/**
 * CityCanvas —— 城市画布的 React 宿主组件。
 *
 * 职责边界（engineering-conventions）：
 * - 只负责 Canvas 生命周期、尺寸、交互事件与数据传递；不实现城市绘制逻辑（在 cityRenderer）。
 * - 不塞业务规则；点击仅通过 onBuildingClick 把 Project 回调给上层。
 *
 * 数据来源：
 * - 默认从 Zustand（useGameStore）订阅 projects。
 * - 可通过 projectsOverride 注入外部数据（供 ?citytest 等开发页使用），不走 store。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import type { Project } from '@/store/types';
import { useGameLoop } from '@/hooks/useGameLoop';
import {
  CANVAS_W,
  CANVAS_H,
  renderCity,
  hitTest,
  selectCityVisibleProjects,
  type BuildingRenderInfo,
} from './cityRenderer';
import {
  createExplosion,
  createDust,
  updateParticles,
  drawParticles,
  drawDust,
  extractColors,
  EXPLOSION_DURATION_MS,
  COLLAPSE_AT_MS,
  SHAKE_UNTIL_MS,
  type Particle,
  type ExplosionRect,
} from './particles';

interface CityCanvasProps {
  /** 点击建筑回调 */
  onBuildingClick?: (project: Project) => void;
  /** 外部注入项目数据（开发测试用）；不传则从 store 读取 */
  projectsOverride?: Project[];
  /** 是否运行动画循环（年度会议"城市暂停"时传 false） */
  running?: boolean;
}

/** 命令式爆破接口（供 CityScene 通过 ref 调用，TASK-18） */
export interface CityCanvasHandle {
  /**
   * 对指定项目的建筑播放控制爆破动画，并在动画自然结束时调用 onComplete。
   * 若当前帧无法在画布上定位该建筑（rect 未知），返回 false 且不触发任何动画/回调，
   * 由上层据此中止爆破（不删除项目）。成功开始返回 true。
   */
  explode(projectId: string, onComplete: () => void): boolean;
}

/** 爆破建筑取色：烂尾建筑偏灰暗，这里用中性碎块灰（extractColors 的默认兜底）。 */
const DEMOLISH_COLORS = extractColors([]);

/** 当前正在进行的爆破动画状态（叠加进现有 game loop，不另起 rAF）
 *
 * 时间线（总时长 EXPLOSION_DURATION_MS）：
 *   0 ~ SHAKE_UNTIL_MS      预震：楼体左右抖动，尚未爆块
 *   SHAKE_UNTIL_MS          爆块 + 扬尘一次性生成
 *   SHAKE_UNTIL_MS~COLLAPSE 楼体一边瓦解一边向下位移（下沉坍塌）
 *   COLLAPSE_AT_MS          楼体主体停止绘制（hidden）
 *   ...~末尾                碎块落定、灰尘消散
 *   EXPLOSION_DURATION_MS   onComplete（上层 demolishProject）
 */
interface ActiveExplosion {
  projectId: string;
  rect: ExplosionRect; // 建筑包围盒（下沉幅度参考 + 扬尘源）
  particles: Particle[]; // 爆破碎块（SHAKE 之后生成）
  dust: Particle[]; // 灰尘团（SHAKE 之后生成）
  spawned: boolean; // 碎块/灰尘是否已生成（仅在预震结束时生成一次）
  elapsed: number;
  onComplete: () => void;
  done: boolean;
}

/** 坍塌下沉的最大像素位移（随 collapseProgress 增加；不夸张，配合更长坍塌段更可读） */
const SINK_MAX_PX = 14;

const CityCanvas = forwardRef<CityCanvasHandle, CityCanvasProps>(function CityCanvas(
  { onBuildingClick, projectsOverride, running = true },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 从 store 订阅（override 存在时忽略）
  const storeProjects = useGameStore((s) => s.projects);
  const allProjects = projectsOverride ?? storeProjects;

  // 渲染层容量：所有在管（非 completed）项目必显示；剩余展示槽位由最近竣工 completed 补足。
  // 不改 Store：selectCityVisibleProjects 返回浅拷贝 + 展示用 citySlot；档案馆/年报/状态不受影响。
  const projects = selectCityVisibleProjects(allProjects);

  // 用 ref 持有最新可见项目，供 rAF 循环读取，避免闭包捕获旧值
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;

  // 本帧建筑包围盒（命中检测用）
  const infosRef = useRef<BuildingRenderInfo[]>([]);
  // 入场动画起始时间表（id → 首帧 nowMs）
  const enterStartRef = useRef<Map<string, number>>(new Map());

  // hover 状态：用 ref 驱动绘制、用 state 触发指针样式
  const hoveredIdRef = useRef<string | null>(null);
  const [hoverCursor, setHoverCursor] = useState(false);

  // 进行中的爆破动画（叠加进同一 game loop，避免与之竞争的第二个 rAF）
  const explosionRef = useRef<ActiveExplosion | null>(null);

  // 命令式爆破接口（TASK-18）：用当前帧的 infosRef 定位建筑 rect，启动粒子叠加
  useImperativeHandle(
    ref,
    (): CityCanvasHandle => ({
      explode(projectId, onComplete) {
        const DEV = import.meta.env?.DEV;
        // 已有爆破进行中则拒绝再次开始（避免叠加混乱）
        if (explosionRef.current && !explosionRef.current.done) {
          if (DEV) console.log('[demolish] 5! explode rejected: already running');
          return false;
        }
        if (DEV) {
          console.log(
            '[demolish] 6 infosRef ids=',
            infosRef.current.map((i) => i.project.id),
          );
        }
        const info = infosRef.current.find((i) => i.project.id === projectId);
        if (!info) {
          if (DEV) console.log('[demolish] 6! renderInfo NOT found for', projectId, '→ abort (no delete)');
          return false; // 现场定位失败：不动画、不回调，由上层中止
        }
        if (DEV) console.log('[demolish] 6 renderInfo found rect=', info.rect);
        explosionRef.current = {
          projectId,
          rect: info.rect,
          particles: [], // 预震阶段不爆块；到 SHAKE_UNTIL_MS 再生成
          dust: [],
          spawned: false,
          elapsed: 0,
          onComplete,
          done: false,
        };
        if (DEV) console.log('[demolish] 7 explosion started (shake phase)');
        return true;
      },
    }),
    [],
  );

  // 每帧渲染：先推进爆破计时（决定抖动/下沉/隐藏）→ 画城市（含该建筑的爆破偏移）→ 叠加碎块+灰尘
  useGameLoop((nowMs, dtMs) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const ex = explosionRef.current;
    if (ex && !ex.done) ex.elapsed += dtMs;

    // 计算该建筑的爆破视觉状态（预震抖动 / 坍塌下沉 / 隐藏）
    let demolishFx: {
      projectId: string;
      hidden: boolean;
      offsetX: number;
      offsetY: number;
    } | null = null;

    if (ex && !ex.done) {
      const e = ex.elapsed;
      if (e >= COLLAPSE_AT_MS) {
        // 坍塌完成：主体停止绘制（粒子/灰尘继续）
        demolishFx = { projectId: ex.projectId, hidden: true, offsetX: 0, offsetY: 0 };
      } else if (e >= SHAKE_UNTIL_MS) {
        // 坍塌阶段：一边瓦解一边向下位移，offsetY 随 collapseProgress 递增
        const cp = (e - SHAKE_UNTIL_MS) / (COLLAPSE_AT_MS - SHAKE_UNTIL_MS); // 0..1
        demolishFx = {
          projectId: ex.projectId,
          hidden: false,
          offsetX: 0,
          offsetY: Math.round(cp * SINK_MAX_PX),
        };
      } else {
        // 预震阶段：高频小幅左右抖动（anticipation）
        const shake = Math.sin(e / 12) * 2; // 约 ±2px
        demolishFx = { projectId: ex.projectId, hidden: false, offsetX: shake, offsetY: 0 };
      }
    }

    infosRef.current = renderCity({
      ctx,
      projects: projectsRef.current,
      nowMs,
      hoveredId: hoveredIdRef.current,
      enterStartMap: enterStartRef.current,
      demolishFx,
    });

    // 爆破碎块 + 灰尘：预震结束(SHAKE_UNTIL_MS)时一次性生成，之后每帧推进/绘制
    if (ex && !ex.done) {
      if (!ex.spawned && ex.elapsed >= SHAKE_UNTIL_MS) {
        ex.particles = createExplosion(ex.rect, DEMOLISH_COLORS, 3);
        ex.dust = createDust(ex.rect, 4);
        ex.spawned = true;
        if (import.meta.env?.DEV)
          console.log('[demolish] 7b blast+dust spawned, particles=', ex.particles.length, 'dust=', ex.dust.length);
      }
      if (ex.spawned) {
        updateParticles(ex.particles, dtMs);
        updateParticles(ex.dust, dtMs);
        // 先画灰尘（在建筑/碎块之下的承接层感），再画碎块
        drawDust(ctx, ex.dust);
        drawParticles(ctx, ex.particles);
      }
      if (ex.elapsed >= EXPLOSION_DURATION_MS) {
        ex.done = true;
        explosionRef.current = null;
        ex.onComplete();
      }
    }
  }, running);

  // 清理已移除项目的入场记录（避免 Map 无限增长；爆破后项目消失）
  useEffect(() => {
    // 以 Store 真实存在为准清理（而非可见子集）：被容量管理暂隐的 completed 保留入场记录，
    // 再次可见时不重放入场动画。
    const alive = new Set(allProjects.map((p) => p.id));
    for (const id of enterStartRef.current.keys()) {
      if (!alive.has(id)) enterStartRef.current.delete(id);
    }
  }, [allProjects]);

  /** 将鼠标事件坐标换算为画布内部坐标（考虑 CSS 缩放） */
  const toCanvasCoords = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CANVAS_W;
    const y = ((e.clientY - r.top) / r.height) * CANVAS_H;
    return { x, y };
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = toCanvasCoords(e);
      const hit = hitTest(infosRef.current, x, y);
      hoveredIdRef.current = hit?.id ?? null;
      setHoverCursor(hit !== null);
    },
    [toCanvasCoords],
  );

  const handleMouseLeave = useCallback(() => {
    hoveredIdRef.current = null;
    setHoverCursor(false);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const { x, y } = toCanvasCoords(e);
      const hit = hitTest(infosRef.current, x, y);
      if (hit) {
        // 命中建筑打开详情前清除 hover：详情面板会以全屏遮罩覆盖 Canvas，
        // 之后 Canvas 收不到 mousemove/mouseleave，若不清会残留金色 hover 轮廓。
        // 选中态由打开的 ProjectCard 表达，城市画布不保留描边。
        hoveredIdRef.current = null;
        setHoverCursor(false);
        onBuildingClick?.(hit);
      }
      // 空白区域点击不触发
    },
    [toCanvasCoords, onBuildingClick],
  );

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_W}
      height={CANVAS_H}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: `${CANVAS_W}px`,
        height: 'auto',
        imageRendering: 'pixelated',
        cursor: hoverCursor ? 'pointer' : 'default',
      }}
    />
  );
});

export default CityCanvas;
