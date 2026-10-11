/**
 * 城市渲染器（纯 Canvas 2D，原创）
 *
 * 职责边界（engineering-conventions）：
 * - 只负责把项目数据画成一座像素城市，不依赖 React、不直接读 Zustand。
 * - 调用方（CityCanvas）传入项目快照与渲染参数；本模块不持有 UI 状态。
 *
 * 视觉（visual-style）：深海军蓝基底 + 明亮像素城市 + 玩具感；
 * 用"前排/后排双排 + 远景剪影 + 地面 + 道路"营造基本城市空间感，非单排测试横列。
 * 不做写实透视、不做 3D、不加 NPC/车辆/复杂云层。
 *
 * 状态映射（五态，严禁旧 stalled）：
 *   construction → 在建 sprite + 塔吊（摆动）
 *   warning      → 在建 sprite + 塔吊（摆动） + warning 警戒牌
 *   halted       → 在建 sprite + 塔吊（冻结） + halted 封锁条
 *   abandoned    → 烂尾 sprite
 *   completed    → 竣工 sprite + 旗帜（飘动）
 */

import {
  BUILDING_SPRITES,
  ATTACHMENT_SPRITES,
  OVERLAY_SPRITES,
  CRANE_HEAD_ANCHOR,
  MAST_COLORS,
  drawSprite,
  type Sprite,
  type BuildingSpriteKey,
} from './pixelSprites';
import type { BuildingType, Project, ProjectStatus } from '@/store/types';

/* ============================================================
 * 画布与布局常量
 * ============================================================ */

export const CANVAS_W = 1280;
export const CANVAS_H = 480;

const SCALE = 4; // 像素放大倍数

const GROUND_Y = 360; // 地面线 Y（前排建筑底部坐落处）
const ROAD_H = 60; // 道路高度

// 双排布局：后排（远、小、靠上）在前排之后绘制，前排（近、大、靠下）后绘制覆盖
const BACK_ROW_SLOTS = 6; // 后排槽位数
const FRONT_ROW_SLOTS = 6; // 前排槽位数
export const TOTAL_SLOTS = BACK_ROW_SLOTS + FRONT_ROW_SLOTS; // 12，满足 Demo 8–12

const BACK_SCALE = 3; // 后排用更小缩放，强化前后层次
const FRONT_SCALE = SCALE;

// 后排 / 前排的建筑基线（底部对齐的 Y）
const BACK_BASELINE_Y = 300;
const FRONT_BASELINE_Y = GROUND_Y;

// 槽位水平排布：两排各自均分可用宽度，后排相对前排水平错位，避免正对遮挡。
// 边界安全：每栋建筑以 anchorX 为底部中心、半宽 = (spriteW*scale)/2 向两侧展开，
// 最宽为前排 tower/flat（16px * FRONT_SCALE=4 = 64，半宽 32）；再为塔吊/旗帜等横向探出留冗余。
// 因此每侧预留 EDGE_SAFE，并把后排错位收敛到不越过安全边界，杜绝最右/最左列被裁切。
const EDGE_SAFE = 44; // 单侧安全边距（> 最宽建筑半宽 32，含 crane/flag 横向探出冗余）
// 后排错位量：原为 +cellW*0.25（仅向右），会把最右后排推出边界；改为居中对称的小幅错位。
const BACK_ROW_SHIFT_RATIO = 0.12;

/* ============================================================
 * 槽位 → 坐标映射
 * ------------------------------------------------------------
 * 固定可复用布局：slot 0..5 为后排，6..11 为前排。
 * 返回建筑"底部中心"的锚点坐标与该排的缩放、基线。
 * ============================================================ */

export interface SlotLayout {
  isFront: boolean;
  scale: number;
  /** 建筑底部中心 X */
  anchorX: number;
  /** 建筑底部 Y（基线） */
  baselineY: number;
  /** 该排单格宽度 */
  cellW: number;
}

export function getSlotLayout(slot: number): SlotLayout {
  // 可用布局区在两侧安全边距之内；列中心均分其中，保证最右/最左列完整建筑都在 Canvas 内。
  const layoutLeft = EDGE_SAFE;
  const layoutW = CANVAS_W - EDGE_SAFE * 2;
  if (slot < BACK_ROW_SLOTS) {
    const cellW = layoutW / BACK_ROW_SLOTS;
    const col = slot;
    // 后排小幅错位（对称 ±，不越界）：向右错位 BACK_ROW_SHIFT_RATIO*cellW，
    // 但最右列不再额外右移以免越过安全边界 → 用居中锚点 + 受限错位。
    let anchorX = layoutLeft + cellW * col + cellW / 2 + cellW * BACK_ROW_SHIFT_RATIO;
    // 收敛到安全区（半宽按后排 16*BACK_SCALE/2 估算），确保完整 bbox 在界内
    const backHalf = 16 * BACK_SCALE * 0.5;
    anchorX = Math.min(anchorX, CANVAS_W - EDGE_SAFE - backHalf);
    anchorX = Math.max(anchorX, EDGE_SAFE + backHalf);
    return { isFront: false, scale: BACK_SCALE, anchorX, baselineY: BACK_BASELINE_Y, cellW };
  }
  const cellW = layoutW / FRONT_ROW_SLOTS;
  const col = slot - BACK_ROW_SLOTS;
  let anchorX = layoutLeft + cellW * col + cellW / 2;
  // 前排半宽按最宽 16*FRONT_SCALE/2 估算，收敛到安全区
  const frontHalf = 16 * FRONT_SCALE * 0.5;
  anchorX = Math.min(anchorX, CANVAS_W - EDGE_SAFE - frontHalf);
  anchorX = Math.max(anchorX, EDGE_SAFE + frontHalf);
  return { isFront: true, scale: FRONT_SCALE, anchorX, baselineY: FRONT_BASELINE_Y, cellW };
}

/* ============================================================
 * 城市 Canvas 可见项目选择（渲染层容量，纯函数，不改 Store）
 * ------------------------------------------------------------
 * 硬约束：所有"在管"项目（非 completed）必须始终显示且可点击/可治理，绝不隐藏。
 * 剩余展示槽位由"最近竣工"的 completed 补足（completedAt ?? createdAt 倒序）。
 * 较早 completed 未显示时：不删除、不改状态、不写公告、不影响年报，档案馆仍可查。
 *
 * citySlot 为渲染层概念：managed 占据展示槽，completed 仅填补剩余槽；
 * 返回浅拷贝 + 重映射的展示用 citySlot（0..n-1），不改 Store 原 citySlot / 历史数据。
 * ============================================================ */
export function selectCityVisibleProjects(projects: Project[], slotCount: number = TOTAL_SLOTS): Project[] {
  const managed = projects.filter((p) => p.status !== 'completed');
  const completed = projects.filter((p) => p.status === 'completed');

  // managed：按原 citySlot 升序，保持既有位置稳定（避免 completed 增减时整城换位）
  const managedSorted = [...managed].sort((a, b) => a.citySlot - b.citySlot);
  // completed：最近竣工优先（completedAt 缺失回退 createdAt）
  const completedSorted = [...completed].sort(
    (a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt),
  );

  // 硬约束：所有 managed 必显示（即使极端下超过 slotCount 也不隐藏 managed）
  const chosen: Project[] = [...managedSorted];
  // 剩余展示槽位补最近 completed
  const remaining = Math.max(0, slotCount - chosen.length);
  for (let i = 0; i < remaining && i < completedSorted.length; i++) {
    chosen.push(completedSorted[i]);
  }

  // 重映射展示槽位 0..n-1（浅拷贝，不动 Store 原 citySlot）
  return chosen.map((p, i) => (p.citySlot === i ? p : { ...p, citySlot: i }));
}

/* ============================================================
 * 五态 → 精灵映射
 * ============================================================ */

function baseSpriteKey(buildingType: BuildingType, status: ProjectStatus): BuildingSpriteKey {
  // 仅 tower / flat 两种基础形态；其它 buildingType 回退到 tower（MVP 阶段）
  const form: 'tower' | 'flat' = buildingType === 'flat' ? 'flat' : 'tower';
  switch (status) {
    case 'completed':
      return `${form}_completed` as BuildingSpriteKey;
    case 'abandoned':
      return `${form}_abandoned` as BuildingSpriteKey;
    case 'construction':
    case 'warning':
    case 'halted':
    default:
      // 在建/预警/停工 共用在建本体，差异由附件/overlay 表达
      return `${form}_construction` as BuildingSpriteKey;
  }
}

/* ============================================================
 * 单栋建筑绘制（含附件、overlay、入场动画、阴影、hover 高亮）
 * ============================================================ */

export interface BuildingRenderInfo {
  project: Project;
  /** 建筑本体在画布上的包围盒（用于命中检测与高亮） */
  rect: { x: number; y: number; w: number; h: number };
}

interface DrawBuildingArgs {
  ctx: CanvasRenderingContext2D;
  project: Project;
  layout: SlotLayout;
  nowMs: number;
  /** 入场动画进度 0..1（1 = 完全落位） */
  enterProgress: number;
  hovered: boolean;
  /** 爆破视觉偏移（像素）：预震左右抖动 offsetX、坍塌下沉 offsetY。默认 0。 */
  offsetX?: number;
  offsetY?: number;
}

function drawBuilding(args: DrawBuildingArgs): BuildingRenderInfo {
  const { ctx, project, layout, nowMs, enterProgress, hovered, offsetX = 0, offsetY = 0 } = args;
  const sprite: Sprite = BUILDING_SPRITES[baseSpriteKey(project.buildingType, project.status)];
  const s = layout.scale;
  const bw = sprite.w * s;
  const bh = sprite.h * s;

  // 底部中心对齐；入场动画：从基线下方升起。叠加爆破偏移（预震抖动 / 坍塌下沉）。
  const baseX = Math.round(layout.anchorX - bw / 2) + Math.round(offsetX);
  const riseOffset = Math.round((1 - enterProgress) * bh);
  const baseY = Math.round(layout.baselineY - bh + riseOffset) + Math.round(offsetY);

  // 1. 阴影（地面上的深色椭圆近似：用扁矩形，像素风）
  if (enterProgress > 0.9) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const shW = bw * 0.8;
    ctx.fillRect(Math.round(layout.anchorX - shW / 2), layout.baselineY - 3, Math.round(shW), 4);
  }

  // 2. hover 高亮：金色外轮廓（在建筑本体后画一圈）
  if (hovered) {
    ctx.fillStyle = '#e8c14c';
    ctx.fillRect(baseX - 2, baseY - 2, bw + 4, bh + 4);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(baseX - 1, baseY - 1, bw + 2, bh + 2);
  }

  // 3. 建筑本体
  drawSprite(ctx, sprite, baseX, baseY, s);

  // 4. 附件 + overlay（按状态）
  const st = project.status;

  // 塔吊：construction / warning / halted 都有；halted 冻结（固定帧），其余双帧摆动。
  // 拆分实现：mast 主塔身程序化平铺（可变高、不变形）+ crane head（吊臂/吊索/吊钩）等比绘制（固定比例）。
  if (st === 'construction' || st === 'warning' || st === 'halted') {
    const head = ATTACHMENT_SPRITES.craneHead;
    const swing =
      st === 'halted' ? 0 : (Math.floor(nowMs / 420) % 2 === 0 ? -1 : 1) * 2;

    const headScale = s; // crane head 用建筑同等比例（rear=3 / front=4），不纵向拉伸
    const baselineY = layout.baselineY; // 地面基线（统一来源）
    const roofY = baseY; // 本栋楼顶
    // 吊臂顶明显高于楼顶：净空与楼高成比例，flat 也能明显高出；至少 8*s。
    const clearance = Math.max(8 * s, Math.round(bh * 0.28));
    const jibTopY = roofY - clearance; // 吊臂上弦 Y（楼顶上方）

    // crane head 水平：塔身接入列紧贴建筑左侧外缘，整体略偏左让吊臂探向楼顶
    const headW = head.w * headScale;
    const headX = baseX - headW + 3 * headScale + swing;
    const headY = jibTopY;

    // 塔身接入点（head 内的顶座列/底行）在画布上的坐标
    const mastX = Math.round(headX + CRANE_HEAD_ANCHOR.col * headScale);
    const mastTopY = Math.round(headY + (CRANE_HEAD_ANCHOR.bottomRow + 1) * headScale);
    const mastWpx = 2 * headScale; // 塔身宽固定 2 像素格（等比），细而不是棚架

    // 程序化平铺 mast：从接入点一路画到地面基线；每格 headScale×headScale，不拉伸单格。
    for (let y = mastTopY; y < baselineY; y += headScale) {
      const cellH = Math.min(headScale, baselineY - y);
      // 左右两条竖杆（金黄）+ 中间横撑（暗部）交替，呈桁架感
      ctx.fillStyle = MAST_COLORS.light;
      ctx.fillRect(mastX, y, headScale, cellH); // 左竖杆
      ctx.fillRect(mastX + headScale, y, headScale, cellH); // 右竖杆
      // 每隔一格画一道暗部横撑
      if (Math.floor((y - mastTopY) / headScale) % 2 === 1) {
        ctx.fillStyle = MAST_COLORS.dark;
        ctx.fillRect(mastX, y, mastWpx, Math.max(1, Math.round(headScale / 3)));
      }
    }

    // crane head 等比绘制在顶端（固定比例，吊臂/吊索/吊钩不变形）
    drawSprite(ctx, head, Math.round(headX), Math.round(headY), headScale);
  }

  // 旗帜：completed，插在楼顶居中偏左，旗杆贴楼顶、不伸进楼身、不超出右边缘。
  // flag 精灵 12×8：第 0 列为旗杆（贯穿 8 行），右侧为三角旗面。
  // 定位：旗杆落在楼顶中线稍偏左，整面旗位于楼顶之上（flagY + 旗高 == 楼顶 baseY）。
  if (st === 'completed') {
    const flag = ATTACHMENT_SPRITES.flag;
    const wave = Math.round(Math.sin(nowMs / 300) * 1) * s; // ±1px * scale（仅旗面轻摆）
    const flagX = baseX + Math.round(bw / 2) - 2 * s + wave; // 楼顶中线稍偏左
    const flagY = baseY - flag.h * s; // 旗整体在楼顶之上，旗杆底正好接楼顶
    drawSprite(ctx, flag, Math.round(flagX), Math.round(flagY), s);
  }

  // warning / halted overlay（挂建筑右侧中上部 / 右上角）
  if (st === 'warning') {
    const ov = OVERLAY_SPRITES.warning;
    const ovX = baseX + bw - ov.w * s + 2 * s;
    const ovY = baseY + Math.round(sprite.h * 0.3) * s;
    drawSprite(ctx, ov, Math.round(ovX), Math.round(ovY), s);
  } else if (st === 'halted') {
    const ov = OVERLAY_SPRITES.halted;
    const ovX = baseX + bw - ov.w * s - 1 * s;
    const ovY = baseY + 2 * s;
    drawSprite(ctx, ov, Math.round(ovX), Math.round(ovY), s);
  }

  return { project, rect: { x: baseX, y: baseY, w: bw, h: bh } };
}

/* ============================================================
 * 背景分层绘制
 * ============================================================ */

function drawSky(ctx: CanvasRenderingContext2D): void {
  // 像素风分段渐变天空（深海军蓝基底 → 上浅下深几段纯色带，避免真渐变的模糊感）
  const bands = [
    { y: 0, h: 90, c: '#2a2a52' },
    { y: 90, h: 90, c: '#3a3a6e' },
    { y: 180, h: 60, c: '#4a5a86' },
  ];
  for (const b of bands) {
    ctx.fillStyle = b.c;
    ctx.fillRect(0, b.y, CANVAS_W, b.h);
  }
  // 几朵静态像素云（不做复杂动画）
  ctx.fillStyle = '#5566aa';
  const clouds = [
    [160, 50],
    [520, 90],
    [900, 60],
    [1120, 110],
  ];
  for (const [cx, cy] of clouds) {
    ctx.fillRect(cx, cy, 48, 10);
    ctx.fillRect(cx + 10, cy - 8, 28, 10);
  }
}

function drawDistantSkyline(ctx: CanvasRenderingContext2D): void {
  // 远景城市剪影：所有背景楼共享同一底部基线（= 后排地面基线），高度各异形成天际线。
  // 底部向草地区多延伸 SKYLINE_SINK px，由其后绘制的 ground 层遮住，形成远景遮挡关系、消除像素缝。
  const skylineBaseline = BACK_BASELINE_Y; // 单一来源：与后排建筑同一地面基线
  const SKYLINE_SINK = 8; // 底部沉入草地区的像素量（被 ground 覆盖）
  // 仅定义 [x, width, height]，y 由基线推导：顶部 = baseline - height
  const buildings: Array<[number, number, number]> = [
    [40, 50, 70],
    [120, 40, 92],
    [210, 60, 54],
    [430, 46, 82],
    [500, 54, 60],
    [700, 42, 88],
    [780, 60, 62],
    [980, 48, 76],
    [1070, 56, 54],
    [1160, 44, 86],
  ];
  for (const [x, w, h] of buildings) {
    const top = skylineBaseline - h;
    const drawH = h + SKYLINE_SINK; // 向下多延伸，底部进入草地区
    ctx.fillStyle = '#2f3560';
    ctx.fillRect(x, top, w, drawH);
    // 剪影上的零星窗点（仅在楼体可见部分）
    ctx.fillStyle = '#444a80';
    for (let wy = top + 8; wy < skylineBaseline - 6; wy += 14) {
      ctx.fillRect(x + 6, wy, 4, 4);
      ctx.fillRect(x + w - 12, wy, 4, 4);
    }
  }
}

function drawGroundAndRoad(ctx: CanvasRenderingContext2D): void {
  // 地面（后排与前排之间的地块）
  ctx.fillStyle = '#3b4a3a';
  ctx.fillRect(0, 300, CANVAS_W, GROUND_Y - 300);

  // 前排地块
  ctx.fillStyle = '#4a3f2a';
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);

  // 道路（横贯前排底部）
  const roadY = GROUND_Y + 8;
  ctx.fillStyle = '#5a5f66';
  ctx.fillRect(0, roadY, CANVAS_W, ROAD_H);
  // 路缘
  ctx.fillStyle = '#7a818a';
  ctx.fillRect(0, roadY, CANVAS_W, 3);
  ctx.fillRect(0, roadY + ROAD_H - 3, CANVAS_W, 3);
  // 道路中线虚线（像素虚线）
  ctx.fillStyle = '#d9c45a';
  const midY = roadY + Math.floor(ROAD_H / 2) - 2;
  for (let x = 10; x < CANVAS_W; x += 48) {
    ctx.fillRect(x, midY, 24, 4);
  }
}

/* ============================================================
 * 入场动画时长
 * ============================================================ */
export const BUILDING_ENTER_MS = 500;

/** easeOutCubic：入场升起的缓动 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/* ============================================================
 * 顶层渲染入口
 * ============================================================ */

export interface RenderParams {
  ctx: CanvasRenderingContext2D;
  projects: Project[];
  nowMs: number;
  /** 当前 hover 的项目 id（null 表示无） */
  hoveredId: string | null;
  /** 各项目入场动画起始时间戳（id → 首次渲染的 nowMs），用于计算 enterProgress */
  enterStartMap: Map<string, number>;
  /**
   * 爆破视觉状态（TASK-18，仅影响该建筑的绘制，不改 store）：
   * - hidden：建筑主体停止绘制（坍塌后 + Project 仍在 store，删除在动画结束回调里）
   * - offsetX / offsetY：预震左右抖动 / 坍塌向下位移（像素）
   * 用于"预震→爆块→一边瓦解一边下沉→隐藏→动画结束才删除"的解耦。
   */
  demolishFx?: { projectId: string; hidden: boolean; offsetX: number; offsetY: number } | null;
}

/**
 * 渲染一帧完整城市。返回本帧所有建筑的包围盒信息（供命中检测）。
 * 绘制顺序（分层）：天空 → 远景剪影 → 地面 → 道路 → 后排建筑 → 前排建筑。
 */
export function renderCity(params: RenderParams): BuildingRenderInfo[] {
  const { ctx, projects, nowMs, hoveredId, enterStartMap, demolishFx } = params;

  ctx.imageSmoothingEnabled = false;

  // 每帧从干净画布开始：先清屏 + 全画布底色填充，保证本帧结果完全由当前 state 决定，
  // 任何上一帧残留（如 hover 金色 outline 的竖边像素）都被底色覆盖，无需手动擦除。
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = '#4a5a86'; // 与天空最下一段同色，兜底覆盖所有分层之间的缝隙
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 背景分层
  drawSky(ctx);
  drawDistantSkyline(ctx);
  drawGroundAndRoad(ctx);

  // 建筑：按 slot 分到后排/前排；后排先画（被前排覆盖产生层次）
  const back: Project[] = [];
  const front: Project[] = [];
  for (const p of projects) {
    const layout = getSlotLayout(p.citySlot);
    (layout.isFront ? front : back).push(p);
  }

  const infos: BuildingRenderInfo[] = [];

  const drawList = (list: Project[]) => {
    for (const project of list) {
      const isDemolishing = demolishFx != null && demolishFx.projectId === project.id;
      // 爆破坍塌后：隐藏的项目主体停止绘制（粒子/灰尘由 CityCanvas 叠加），不参与命中
      if (isDemolishing && demolishFx!.hidden) continue;
      const layout = getSlotLayout(project.citySlot);
      // 入场进度
      let start = enterStartMap.get(project.id);
      if (start === undefined) {
        start = nowMs;
        enterStartMap.set(project.id, start);
      }
      const raw = Math.min(1, (nowMs - start) / BUILDING_ENTER_MS);
      const enterProgress = easeOutCubic(raw);

      infos.push(
        drawBuilding({
          ctx,
          project,
          layout,
          nowMs,
          enterProgress,
          hovered: project.id === hoveredId,
          offsetX: isDemolishing ? demolishFx!.offsetX : 0,
          offsetY: isDemolishing ? demolishFx!.offsetY : 0,
        }),
      );
    }
  };

  drawList(back);
  drawList(front);

  return infos;
}

/* ============================================================
 * 命中检测（供 hover / click）
 * ------------------------------------------------------------
 * 前排建筑在后排之后绘制、视觉在上，故命中优先前排：从 infos 末尾向前找。
 * ============================================================ */

export function hitTest(infos: BuildingRenderInfo[], x: number, y: number): Project | null {
  for (let i = infos.length - 1; i >= 0; i--) {
    const { rect, project } = infos[i];
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      return project;
    }
  }
  return null;
}
