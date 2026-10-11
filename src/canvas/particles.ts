/**
 * 爆破粒子系统（原创，独立于 React / Zustand）
 *
 * 语义依据 product-identity / 本轮指令：这是"控制爆破"，不是烟花。
 * 效果 = 建筑碎块被炸开 → 向两侧飞散 → 重力下坠 → 消失。
 *   - 粒子初始位置铺满整个建筑矩形（楼体整体被炸碎），而非从单点喷射。
 *   - 水平初速按粒子所在左/右半区偏向两侧（左半偏左飞、右半偏右飞）。
 *   - 垂直初速小幅向上/随机，之后由重力主导下坠。
 * 不做烟花式 360° 均匀喷射、不做音效/震屏/烟雾/火焰。
 *
 * 职责边界（engineering-conventions）：
 * - 本文件只管理粒子数据与 Canvas 绘制，不依赖 React、不读写 Zustand。
 * - 完成回调由调用方（TASK-18）提供，在动画结束时触发以执行 demolishProject。
 *
 * 像素风：粒子为小方块（默认 2px，整数坐标绘制），无圆形/模糊/渐变。
 */

/**
 * 整个爆破动画时长（ms）。
 * 节奏（TASK-18 时序调整）：压缩到约 850ms，强化"爆破→立即坍塌→碎片续落"的因果感：
 *   0ms       爆破开始，建筑仍在
 *   ~200ms    第一波碎块已爆开
 *   ~350ms    建筑主体停止绘制（坍塌，见 COLLAPSE_AT_MS）—— 仅视觉隐藏，Project 仍在 store
 *   350~800ms 碎块继续下落/散开/淡出
 *   850ms     动画结束 → 回调里 demolishProject（此时才真正删除）
 */
/**
 * 整个爆破动画时长（ms）。约 1150ms，四阶段肉眼可依次读出（"脆但看得清"，非慢动作）：
 *   0 ~ 120ms     预震（anticipation）：楼体轻微抖动，尚未爆块
 *   120 ~ 280ms   第一波爆破 + 碎片（碎片初速仍快）
 *   280 ~ 650ms   楼体主要瓦解 + 向下坍塌（坍塌段拉长，位移可读）
 *   650 ~ 950ms   建筑主体隐藏，基座继续瓦解 + 灰尘扩散
 *   950 ~ 1150ms  碎片 / 灰尘收尾
 *   1150ms        onComplete（上层 demolishProject）
 */
export const EXPLOSION_DURATION_MS = 1150;

/**
 * 预震阶段结束时刻（ms）。0~SHAKE_UNTIL_MS 为 anticipation：
 * 楼体轻微抖动、尚未爆块（碎片/灰尘在此刻之后才生成）。
 */
export const SHAKE_UNTIL_MS = 120;

/**
 * 建筑主体停止绘制的时刻（ms）。到此刻建筑"坍塌"消失，碎片/灰尘继续；
 * 但 Project 直到 EXPLOSION_DURATION_MS 结束才由上层删除（视觉消失 ≠ Store 删除）。
 * SHAKE_UNTIL_MS ~ COLLAPSE_AT_MS 之间楼体一边瓦解一边向下位移（下沉坍塌，此段拉长更可读）。
 */
export const COLLAPSE_AT_MS = 650;

/** 粒子数量范围 */
const PARTICLE_MIN = 30;
const PARTICLE_MAX = 50;

/** 物理参数（单位：像素/秒，重力：像素/秒²） */
const GRAVITY = 1100; // 下坠加速度（节奏加快，碎块更快落定）
const H_SPEED_MIN = 70; // 水平飞散最小速度（绝对值）
const H_SPEED_MAX = 300; // 水平飞散最大速度（绝对值）
const V_SPEED_MIN = -260; // 垂直初速上限（负=向上冲起）
const V_SPEED_MAX = -60; // 垂直初速下限（略向上，之后被重力拉下）
const LIFE_MIN_MS = 500; // 单粒子最短生命
const LIFE_MAX_MS = EXPLOSION_DURATION_MS; // 最长不超过总时长

export interface Particle {
  x: number; // 当前位置（画布坐标，像素）
  y: number;
  vx: number; // 速度（像素/秒）
  vy: number;
  gravity: number; // 重力加速度（像素/秒²）
  color: string; // 像素色（#rrggbb）
  life: number; // 剩余生命（ms）
  maxLife: number; // 初始生命（ms）
  size: number; // 方块边长（像素）
}

/** 爆破区域（被炸建筑在画布上的矩形） */
export interface ExplosionRect {
  x: number; // 左上角
  y: number;
  w: number;
  h: number;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

/**
 * 从建筑调色板中抽取可用颜色（过滤透明），用于粒子着色。
 * 传入的是 Sprite.palette（palette[0] 通常是 'transparent'）。
 * 若无有效颜色则回退到一组中性碎块灰。
 */
export function extractColors(palette: string[]): string[] {
  const colors = palette.filter((c) => c && c !== 'transparent');
  return colors.length > 0 ? colors : ['#8a8f94', '#636e72', '#a9b0b5'];
}

/**
 * 生成一次控制爆破的粒子集合。
 * @param rect    被炸建筑在画布上的矩形（粒子铺满此区域）
 * @param colors  粒子取色来源（优先用建筑自身调色板，见 extractColors）
 * @param size    粒子方块边长，默认 2
 * @returns       粒子数组（由调用方持有并在每帧 update/draw）
 */
export function createExplosion(
  rect: ExplosionRect,
  colors: string[],
  size = 2,
): Particle[] {
  const count = randInt(PARTICLE_MIN, PARTICLE_MAX);
  const palette = colors.length > 0 ? colors : extractColors([]);
  const centerX = rect.x + rect.w / 2;
  const particles: Particle[] = [];

  for (let i = 0; i < count; i++) {
    // 初始位置：铺满整个建筑矩形（楼体整体被炸碎）
    const px = rand(rect.x, rect.x + rect.w);
    const py = rand(rect.y, rect.y + rect.h);

    // 水平方向：按所在左/右半区偏向对应侧飞散（控制爆破向两边塌散）
    const dir = px < centerX ? -1 : 1;
    const vx = dir * rand(H_SPEED_MIN, H_SPEED_MAX);

    // 垂直方向：小幅向上冲起，随后被重力拉下
    const vy = rand(V_SPEED_MIN, V_SPEED_MAX);

    const maxLife = rand(LIFE_MIN_MS, LIFE_MAX_MS);

    particles.push({
      x: px,
      y: py,
      vx,
      vy,
      gravity: GRAVITY,
      color: palette[randInt(0, palette.length - 1)],
      life: maxLife,
      maxLife,
      size,
    });
  }
  return particles;
}

/* ============================================================
 * 灰尘 / 烟尘（控制爆破承接效果）
 * ============================================================ */

/** 灰尘团数量范围（2~4 团，符合指令） */
const DUST_MIN = 2;
const DUST_MAX = 4;
/** 灰尘颜色：偏灰 / 土黄，像素城市风 */
const DUST_COLORS = ['#9a948a', '#b3a98f', '#8a857c', '#c7bca0'];
/** 灰尘物理：缓慢向两侧 + 略向上扩散，几乎不受重力，生命较长以承接到建筑消失后 */
const DUST_H_SPEED = 70; // 水平扩散速度（绝对值上限）
const DUST_V_SPEED_MIN = -40; // 略向上
const DUST_V_SPEED_MAX = -8;
const DUST_GRAVITY = 60; // 很弱的重力（缓慢回落）
// 灰尘在爆块时（SHAKE_UNTIL_MS≈120ms）生成，需承接到动画收尾（≈1150ms）：
// 生命 850~1030ms → 死亡约在 970~1150ms，正好覆盖"基座瓦解 + 收尾"两阶段并自然淡出。
const DUST_LIFE_MIN_MS = 850;
const DUST_LIFE_MAX_MS = 1030;

/**
 * 在建筑底部与地面交界处生成 2~4 团灰尘。
 * 每团由若干大像素块组成，向两侧和略向上扩散后缓慢消散。
 * @param rect 被炸建筑矩形（取其底边中心一带作为扬尘源）
 */
export function createDust(rect: ExplosionRect, size = 4): Particle[] {
  const clouds = randInt(DUST_MIN, DUST_MAX);
  const baseY = rect.y + rect.h; // 楼底（接近地面交界）
  const centerX = rect.x + rect.w / 2;
  const out: Particle[] = [];

  for (let c = 0; c < clouds; c++) {
    // 每团一个大致方向（偏左 / 偏右），团内多个像素块
    const side = c % 2 === 0 ? -1 : 1;
    const cloudX = centerX + side * rand(0, rect.w * 0.6);
    const blocks = randInt(4, 7);
    for (let i = 0; i < blocks; i++) {
      const maxLife = rand(DUST_LIFE_MIN_MS, DUST_LIFE_MAX_MS);
      out.push({
        x: cloudX + rand(-rect.w * 0.25, rect.w * 0.25),
        y: baseY + rand(-6, 4),
        vx: side * rand(10, DUST_H_SPEED),
        vy: rand(DUST_V_SPEED_MIN, DUST_V_SPEED_MAX),
        gravity: DUST_GRAVITY,
        color: DUST_COLORS[randInt(0, DUST_COLORS.length - 1)],
        life: maxLife,
        maxLife,
        size: size + randInt(0, 2),
      });
    }
  }
  return out;
}

/**
 * 按时间步推进粒子物理（就地修改数组元素）。
 * @param particles 粒子数组
 * @param dtMs      本帧时间步（ms）
 */
export function updateParticles(particles: Particle[], dtMs: number): void {
  const dt = dtMs / 1000; // 转秒
  for (const p of particles) {
    p.vy += p.gravity * dt; // 重力加速
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dtMs;
  }
}

/** 是否仍有存活粒子（life > 0） */
export function hasAliveParticles(particles: Particle[]): boolean {
  return particles.some((p) => p.life > 0);
}

/**
 * 绘制当前帧所有存活粒子（像素小方块）。
 * 坐标取整，保持像素风，无圆形/模糊/渐变。
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
): void {
  for (const p of particles) {
    if (p.life <= 0) continue;
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
  }
}

/**
 * 绘制灰尘：随生命衰减淡出（globalAlpha），营造"扬尘后消散"的承接效果。
 * 仍为像素方块，无模糊/渐变；仅整体透明度随时间降低。
 */
export function drawDust(ctx: CanvasRenderingContext2D, dust: Particle[]): void {
  const prev = ctx.globalAlpha;
  for (const p of dust) {
    if (p.life <= 0) continue;
    // 生命后 60% 开始淡出，前 40% 保持较实
    const r = p.life / p.maxLife;
    ctx.globalAlpha = r > 0.6 ? 0.85 : Math.max(0, (r / 0.6) * 0.85);
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
  }
  ctx.globalAlpha = prev;
}

/**
 * 爆破动画控制器：封装一次完整爆破的生命周期。
 * 用 requestAnimationFrame 自驱动，到时（EXPLOSION_DURATION_MS）调用 onComplete。
 * 与 React/Zustand 解耦；调用方（TASK-18）在 onComplete 中执行 demolishProject。
 */
export interface ExplosionController {
  /** 立即结束动画（不触发 onComplete，用于卸载清理） */
  cancel(): void;
}

export interface RunExplosionOptions {
  ctx: CanvasRenderingContext2D;
  rect: ExplosionRect;
  colors: string[];
  /** 每帧绘制前的回调：用于重绘背景/其它建筑（避免拖影）。可选。 */
  onFrameClear?: () => void;
  /** 动画自然结束时触发（供执行 demolishProject） */
  onComplete: () => void;
  size?: number;
}

/**
 * 启动一次爆破动画并自驱动到结束。
 * 返回控制器以便需要时取消。
 */
export function runExplosion(opts: RunExplosionOptions): ExplosionController {
  const { ctx, rect, colors, onFrameClear, onComplete, size = 2 } = opts;
  const particles = createExplosion(rect, colors, size);

  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let cancelled = false;

  const tick = (now: number) => {
    if (cancelled) return;
    const dt = now - last;
    last = now;
    elapsed += dt;

    updateParticles(particles, dt);
    onFrameClear?.();
    drawParticles(ctx, particles);

    if (elapsed >= EXPLOSION_DURATION_MS) {
      // 到时结束：清掉残余粒子一帧，触发完成回调
      onFrameClear?.();
      onComplete();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    cancel() {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
