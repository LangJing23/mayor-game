/**
 * TopBar —— 城市主界面顶部 HUD（像素游戏风，非 SaaS dashboard）。
 *
 * 信息层级：城市名（主） > 年份 > 五态统计 ；施政方针为第二层弱信息，不抢城市名。
 * isDemoMode 时显示明显但不过度抢眼的 [演示模式] 标识。
 *
 * 纯展示组件：数据与 isDemoMode 由上层传入，不自读 Zustand（便于测试页注入与统一接线）。
 */
import styles from './hud.module.css';

export interface StatusCounts {
  construction: number;
  warning: number;
  halted: number;
  abandoned: number;
  completed: number;
}

export interface TopBarProps {
  cityName: string;
  year: number;
  /** 当年施政方针标题；无方针（引导未完成）传 null */
  policyTitle: string | null;
  counts: StatusCounts;
  isDemoMode: boolean;
  /** 在册项目数 / 城市承载上限（容量提示，可选） */
  total?: number;
  capacity?: number;
}

export default function TopBar({ cityName, year, policyTitle, counts, isDemoMode, total, capacity }: TopBarProps) {
  return (
    <div className={styles.topbar}>
      <div className={styles.topLeft}>
        <span className={styles.cityName}>
          {cityName}人民政府 <span className={styles.cityYear}>· {year} 年</span>
        </span>
        {policyTitle && (
          <span className={styles.policyLine}>
            <span className={styles.policyLabel}>本年度施政方针：</span>
            {policyTitle}
          </span>
        )}
      </div>

      <div className={styles.stats}>
        {isDemoMode && <span className={styles.demoBadge}>演示模式</span>}
        <Stat dot="dotConstruction" label="在建" value={counts.construction} />
        <Stat dot="dotWarning" label="预警" value={counts.warning} />
        <Stat dot="dotHalted" label="停工" value={counts.halted} />
        <Stat dot="dotAbandoned" label="烂尾" value={counts.abandoned} />
        <Stat dot="dotCompleted" label="竣工" value={counts.completed} />
        {total != null && capacity != null && (
          <span className={styles.statItem}>
            <span className={styles.statLabel}>在管</span>
            <span className={styles.statValue}>
              {total}/{capacity}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className={styles.statItem}>
      <span className={`${styles.statDot} ${styles[dot]}`} />
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </span>
  );
}
