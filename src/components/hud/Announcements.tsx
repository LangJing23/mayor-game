/**
 * Announcements —— 底部市政公告滚动栏（像素游戏风，单行低干扰跑马灯）。
 *
 * 恒定阅读速度：按内容实际像素宽度动态计算动画时长，锁定 ~27px/s，不随条数加速。
 * 无缝循环：内容复制一份，滚动至恰好一份宽度（-50%）即无缝衔接。
 * 多条公告之间有清晰分隔符与间距，依次出现。文案由上层传入（遵守 copywriting）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './hud.module.css';

export interface AnnouncementsProps {
  items: string[];
  /** 滚动速度（像素/秒），默认 27（约 25–30 的阅读速度） */
  speedPxPerSec?: number;
}

export default function Announcements({ items, speedPxPerSec = 27 }: AnnouncementsProps) {
  const list = items.length > 0 ? items : ['本市各项重点工程建设正在有序推进中。'];

  // 测量"单份内容"（第一份）的宽度，用于计算恒速时长
  const singleRef = useRef<HTMLSpanElement>(null);
  const [duration, setDuration] = useState(30);

  const recalc = () => {
    const w = singleRef.current?.offsetWidth ?? 0;
    if (w > 0) setDuration(Math.max(8, w / speedPxPerSec));
  };

  useLayoutEffect(() => {
    recalc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.join('|'), speedPxPerSec]);

  // 窗口尺寸变化时重算（字体/布局可能变）
  useEffect(() => {
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItems = (keyPrefix: string, measure: boolean) => (
    <span ref={measure ? singleRef : undefined} className={styles.marqueeGroup}>
      {list.map((text, i) => (
        <span key={`${keyPrefix}-${i}`}>
          <span className={styles.marqueeItem}>{text}</span>
          <span className={styles.marqueeSep}>◆</span>
        </span>
      ))}
    </span>
  );

  return (
    <div className={styles.announceBar}>
      <span className={styles.announceTag}>市政公告</span>
      <div className={styles.marquee}>
        <div className={styles.marqueeTrack} style={{ animationDuration: `${duration}s` }}>
          {/* 第一份：被测量 */}
          {renderItems('a', true)}
          {/* 第二份：复制，保证 -50% 处无缝循环 */}
          {renderItems('b', false)}
        </div>
      </div>
    </div>
  );
}
