/**
 * ActionBar —— 城市主界面操作入口（像素游戏风）。
 *
 * MVP 仅保留四个核心入口：申请立项（主 CTA）/ 市长办公室 / 档案馆 / 年度会议。
 * 不含任务中心、设置、成就、商店等额外入口。
 *
 * 纯展示组件：回调由上层传入。
 */
import styles from './hud.module.css';

export interface ActionBarProps {
  onNewProject: () => void;
  onSecretary: () => void;
  onArchive: () => void;
  onAnnualMeeting: () => void;
}

export default function ActionBar({
  onNewProject,
  onSecretary,
  onArchive,
  onAnnualMeeting,
}: ActionBarProps) {
  return (
    <div className={styles.actionbar}>
      {/* 主 CTA */}
      <button className={`${styles.actionBtn} ${styles.actionCta}`} onClick={onNewProject}>
        申请立项
      </button>
      <button className={styles.actionBtn} onClick={onSecretary}>
        市长办公室
      </button>
      <button className={styles.actionBtn} onClick={onArchive}>
        档案馆
      </button>
      <button className={styles.actionBtn} onClick={onAnnualMeeting}>
        年度会议
      </button>
    </div>
  );
}
