/**
 * 临时精灵测试页（TASK-04 视觉验证用）。
 * 通过 URL ?spritetest 挂载，渲染全部建筑本体、附件、叠加层组合。
 * 验证通过后此文件连同 App.tsx 中的挂载分支一并移除，不进入最终产品。
 */
import { useEffect, useRef } from 'react';
import {
  BUILDING_SPRITES,
  ATTACHMENT_SPRITES,
  OVERLAY_SPRITES,
  drawSprite,
  type Sprite,
} from './pixelSprites';

const SCALE = 5;
const CELL_W = 16 * SCALE + 40; // 单元格宽
const CELL_H = 24 * SCALE + 60; // 单元格高（按高楼算）

interface Combo {
  label: string;
  base: Sprite;
  overlay?: Sprite;
  attachment?: { sprite: Sprite; dx: number; dy: number };
}

export default function SpriteTestPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // tower 五态 + flat 五态
    const towerC = BUILDING_SPRITES.tower_construction;
    const towerCom = BUILDING_SPRITES.tower_completed;
    const towerAb = BUILDING_SPRITES.tower_abandoned;
    const flatC = BUILDING_SPRITES.flat_construction;
    const flatCom = BUILDING_SPRITES.flat_completed;
    const flatAb = BUILDING_SPRITES.flat_abandoned;
    const crane = ATTACHMENT_SPRITES.crane;
    const flag = ATTACHMENT_SPRITES.flag;

    const towerRow: Combo[] = [
      { label: '高楼·在建', base: towerC, attachment: { sprite: crane, dx: 16 * SCALE, dy: -2 * SCALE } },
      { label: '高楼·预警', base: towerC, overlay: OVERLAY_SPRITES.warning, attachment: { sprite: crane, dx: 16 * SCALE, dy: -2 * SCALE } },
      { label: '高楼·停工', base: towerC, overlay: OVERLAY_SPRITES.halted, attachment: { sprite: crane, dx: 16 * SCALE, dy: -2 * SCALE } },
      { label: '高楼·烂尾', base: towerAb },
      { label: '高楼·竣工', base: towerCom, attachment: { sprite: flag, dx: 16 * SCALE, dy: -4 * SCALE } },
    ];
    const flatRow: Combo[] = [
      { label: '矮楼·在建', base: flatC, attachment: { sprite: crane, dx: 16 * SCALE, dy: 0 } },
      { label: '矮楼·预警', base: flatC, overlay: OVERLAY_SPRITES.warning, attachment: { sprite: crane, dx: 16 * SCALE, dy: 0 } },
      { label: '矮楼·停工', base: flatC, overlay: OVERLAY_SPRITES.halted, attachment: { sprite: crane, dx: 16 * SCALE, dy: 0 } },
      { label: '矮楼·烂尾', base: flatAb },
      { label: '矮楼·竣工', base: flatCom, attachment: { sprite: flag, dx: 14 * SCALE, dy: -2 * SCALE } },
    ];

    const drawRow = (row: Combo[], originY: number) => {
      row.forEach((combo, i) => {
        const ox = 24 + i * CELL_W;
        const baseX = ox;
        const baseY = originY + (24 - combo.base.h) * SCALE; // 底部对齐
        drawSprite(ctx, combo.base, baseX, baseY, SCALE);
        if (combo.attachment) {
          drawSprite(ctx, combo.attachment.sprite, baseX + combo.attachment.dx, baseY + combo.attachment.dy, SCALE);
        }
        if (combo.overlay) {
          // 叠加层偏置到建筑右上角，不遮挡主体
          const ovX = baseX + (combo.base.w - combo.overlay.w - 1) * SCALE;
          const ovY = baseY + 2 * SCALE;
          drawSprite(ctx, combo.overlay, ovX, ovY, SCALE);
        }
        // 标签
        ctx.fillStyle = '#f0e6c8';
        ctx.font = '12px sans-serif';
        ctx.fillText(combo.label, ox, originY + 24 * SCALE + 20);
      });
    };

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawRow(towerRow, 40);
    drawRow(flatRow, 40 + CELL_H + 20);
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h2 className="pixel-font" style={{ color: '#e8c14c', fontSize: 16, marginBottom: 16 }}>
        SPRITE TEST — 建筑五态 × 高/矮楼 + 塔吊/旗帜/叠加层
      </h2>
      <canvas
        ref={canvasRef}
        width={5 * CELL_W + 48}
        height={2 * CELL_H + 100}
        style={{ imageRendering: 'pixelated', border: '2px solid #e8c14c' }}
      />
    </div>
  );
}
