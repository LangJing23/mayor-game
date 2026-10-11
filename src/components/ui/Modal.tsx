/**
 * Modal —— 通用像素风弹窗（城市世界/HUD 轨道）。
 *
 * 结构：遮罩 + 弹窗体（标题栏 / 内容区 / 底部 action 区）。
 * 可用性：Escape 关闭；打开时锁定背景滚动；聚焦到弹窗。
 * 视觉：方形金边、深海军蓝底，无圆角、无 UI 库默认样式。
 *
 * 注意：这是像素游戏弹窗，不是公文模板（公文/审计/年报在后续任务另做）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './ui.module.css';

export interface ModalAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
}

export interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** 底部按钮；为空则不渲染 action 区 */
  actions?: ModalAction[];
  /** 关闭回调（Escape / 点关闭按钮 / 点遮罩触发） */
  onClose: () => void;
  /** 是否允许点击遮罩关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 是否显示右上角关闭按钮，默认 true */
  showClose?: boolean;
}

function actionClass(variant: ModalAction['variant']): string {
  if (variant === 'primary') return `${styles.btn} ${styles.btnPrimary}`;
  if (variant === 'danger') return `${styles.btn} ${styles.btnDanger}`;
  return styles.btn;
}

export default function Modal({
  open,
  title,
  children,
  actions,
  onClose,
  closeOnOverlay = true,
  showClose = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // 用 ref 持有最新 onClose，避免因 onClose 引用每次渲染变化而反复重建 effect（会打断输入焦点）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape 关闭 + 锁背景滚动：仅依赖 open，输入过程中不重跑
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // 聚焦弹窗容器：仅在打开瞬间执行一次。若内容里已有元素自动聚焦（如带 autoFocus 的输入框），
  // 则不抢它的焦点，避免打断中文输入法组字。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    // 延到下一帧，让子元素的 autoFocus 先生效
    const id = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      const hasInnerFocus = active && panel.contains(active) && active !== panel;
      if (!hasInnerFocus) panel.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        // 仅当按下点在遮罩本身（非弹窗内）时关闭
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles.titleBar}>
          <div className={styles.titleLeft}>
            <span className={styles.titleIcon} />
            <span className={styles.titleText}>{title}</span>
          </div>
          {showClose && (
            <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
              X
            </button>
          )}
        </div>

        <div className={styles.content}>{children}</div>

        {actions && actions.length > 0 && (
          <div className={styles.actions}>
            {actions.map((a, i) => (
              <button key={i} className={actionClass(a.variant)} onClick={a.onClick}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
