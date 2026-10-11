/**
 * Notification —— 顶部滑入通知条（像素风）。
 *
 * - 单条 NotificationItem：从顶部滑入，默认 5 秒后自动关闭，支持手动关闭（[X]）。
 * - NotificationStack：固定在顶部居中的容器，渲染一组通知。
 *
 * 用于市民反馈、系统公告等（文案由调用方按 copywriting Steering 提供）。
 * 本组件只负责展示与自动消失，不持有业务数据来源。
 */
import { useEffect, useRef, useState } from 'react';
import styles from './ui.module.css';

export type NotificationKind = 'info' | 'success' | 'warning' | 'danger';

export interface NotificationData {
  id: string;
  title?: string;
  message: string;
  kind?: NotificationKind;
  /** 自动关闭毫秒；<=0 表示不自动关闭。默认 5000 */
  duration?: number;
}

interface ItemProps {
  data: NotificationData;
  onClose: (id: string) => void;
}

function NotificationItem({ data, onClose }: ItemProps) {
  const { id, title, message, kind = 'info', duration = 5000 } = data;
  const [leaving, setLeaving] = useState(false);
  const closedRef = useRef(false);

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    setLeaving(true);
    // 等滑出动画结束再真正移除
    window.setTimeout(() => onClose(id), 200);
  };

  useEffect(() => {
    if (duration <= 0) return;
    const t = window.setTimeout(close, duration);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  return (
    <div className={`${styles.notify} ${leaving ? styles.leaving : ''}`} role="status">
      <div className={`${styles.notifyBar} ${styles[kind]}`} />
      <div className={styles.notifyBody}>
        {title && <div className={styles.notifyTitle}>{title}</div>}
        <div>{message}</div>
      </div>
      <button className={styles.notifyClose} onClick={close} aria-label="关闭通知">
        X
      </button>
    </div>
  );
}

export interface NotificationStackProps {
  items: NotificationData[];
  onClose: (id: string) => void;
  /** 顶部偏移（px），用于避开 HUD TopBar；不改通知本身视觉。默认 14 */
  topOffset?: number;
}

export default function NotificationStack({ items, onClose, topOffset = 14 }: NotificationStackProps) {
  if (items.length === 0) return null;
  return (
    <div className={styles.notifyLayer} style={{ top: topOffset }}>
      {items.map((it) => (
        <NotificationItem key={it.id} data={it} onClose={onClose} />
      ))}
    </div>
  );
}
