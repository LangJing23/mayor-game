/**
 * 临时爆破粒子测试页（TASK-05 验证用）。
 * 通过 URL ?particletest 挂载。点击"控制爆破"按钮触发一次爆破动画。
 * 验证：碎块铺满楼体 → 向两侧飞散 → 重力下坠 → 消失 → 完成回调。
 * 验证后此文件连同 App.tsx 分支一并移除，不进入最终产品。
 */
import { useEffect, useRef, useState } from 'react';
import { BUILDING_SPRITES, drawSprite } from './pixelSprites';
import { extractColors, runExplosion, type ExplosionRect } from './particles';

const SCALE = 6;
const CANVAS_W = 480;
const CANVAS_H = 360;

export default function ParticleTestPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('就绪：点击按钮触发控制爆破');
  const [exploding, setExploding] = useState(false);

  const sprite = BUILDING_SPRITES.tower_abandoned; // 用烂尾高楼作被炸对象
  const bx = Math.round((CANVAS_W - sprite.w * SCALE) / 2);
  const by = CANVAS_H - sprite.h * SCALE - 20;

  const drawScene = (ctx: CanvasRenderingContext2D, withBuilding: boolean) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    // 地面线
    ctx.fillStyle = '#3d4347';
    ctx.fillRect(0, CANVAS_H - 20, CANVAS_W, 20);
    if (withBuilding) drawSprite(ctx, sprite, bx, by, SCALE);
  };

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) drawScene(ctx, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExplode = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || exploding) return;
    setExploding(true);
    setStatus('爆破中……');

    const rect: ExplosionRect = {
      x: bx,
      y: by,
      w: sprite.w * SCALE,
      h: sprite.h * SCALE,
    };
    const colors = extractColors(sprite.palette);

    const start = performance.now();
    runExplosion({
      ctx,
      rect,
      colors,
      onFrameClear: () => drawScene(ctx, false), // 每帧重绘背景（无建筑），避免拖影
      onComplete: () => {
        const ms = Math.round(performance.now() - start);
        drawScene(ctx, false); // 建筑已销项，地块清空
        setExploding(false);
        setStatus(`爆破完成（耗时 ${ms}ms）→ onComplete 已触发（此处将执行 demolishProject）`);
      },
    });
  };

  return (
    <div style={{ padding: 20 }}>
      <h2 className="pixel-font" style={{ color: '#e8c14c', fontSize: 14, marginBottom: 12 }}>
        PARTICLE TEST — 控制爆破
      </h2>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ imageRendering: 'pixelated', border: '2px solid #e8c14c', display: 'block' }}
      />
      <button
        onClick={handleExplode}
        disabled={exploding}
        style={{
          marginTop: 12,
          padding: '8px 16px',
          background: '#d63031',
          color: '#fff',
          border: 'none',
          cursor: exploding ? 'default' : 'pointer',
          fontFamily: 'sans-serif',
        }}
      >
        实施控制爆破
      </button>
      <p style={{ marginTop: 10, color: '#f0e6c8', fontSize: 13 }}>{status}</p>
    </div>
  );
}
