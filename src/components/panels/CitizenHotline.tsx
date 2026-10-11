/**
 * CitizenHotline —— 12345 市民热线（TASK-15 展示 UI）。
 *
 * 两个导出：
 *  - HotlineEntry：主界面轻量二级入口按钮（含未读 badge）
 *  - HotlinePanel：右侧抽屉留言板（政务热线风，非聊天气泡）
 *
 * 复用 TASK-14 的 feedbacks 数据与 4 位 Persona，不改生成逻辑。
 * 实时读 Store；项目型反馈可跳转到现有 ProjectCard。
 */
import { useMemo } from 'react';
import { useGameStore } from '@/store/gameStore';
import { getPersona } from '@/logic/citizenFeedback';
import type { CitizenFeedback, FeedbackType, Project } from '@/store/types';
import styles from './hotline.module.css';

const MAX_SHOWN = 20;

const TYPE_LABEL: Record<FeedbackType, string> = {
  complaint: '投诉',
  question: '咨询',
  suggestion: '建议',
  praise: '表扬',
};
const TYPE_TAG_CLASS: Record<FeedbackType, string> = {
  complaint: styles.tagComplaint,
  question: styles.tagQuestion,
  suggestion: styles.tagSuggestion,
  praise: styles.tagPraise,
};
const TYPE_BORDER: Record<FeedbackType, string> = {
  complaint: '#e17055',
  question: '#1f4e79',
  suggestion: '#e4c98a',
  praise: '#00b894',
};

// 4 位 persona 的简单色块头像（不做 sprite，保持轻量）
const AVATAR_COLOR = ['#e8c14c', '#55efc4', '#74b9ff', '#fab1c0'];

/** 未读数：createdAt > lastViewedFeedbackAt 的反馈数 */
export function useUnreadFeedbackCount(): number {
  const feedbacks = useGameStore((s) => s.feedbacks);
  const lastViewed = useGameStore((s) => s.lastViewedFeedbackAt);
  return useMemo(() => feedbacks.filter((f) => f.createdAt > lastViewed).length, [feedbacks, lastViewed]);
}

/* ---------- 主界面入口按钮 ---------- */
export function HotlineEntry({ onOpen }: { onOpen: () => void }) {
  const unread = useUnreadFeedbackCount();
  return (
    <button className={styles.entryBtn} onClick={onOpen} aria-label="12345 市民热线">
      12345 市民热线
      {unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

/* ---------- 时间格式化 ---------- */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${mm}月${dd}日 ${hh}:${mi}`;
}

/* ---------- 单条来信 ---------- */
function FeedbackItem({
  fb,
  projectName,
  onViewProject,
}: {
  fb: CitizenFeedback;
  projectName?: string;
  onViewProject?: (projectId: string) => void;
}) {
  const persona = getPersona(fb.personaId);
  const avatarColor = persona ? AVATAR_COLOR[persona.avatarIndex % 4] : '#999';
  return (
    <div className={styles.item} style={{ borderLeftColor: TYPE_BORDER[fb.type] }}>
      <span className={`${styles.typeTag} ${TYPE_TAG_CLASS[fb.type]}`}>{TYPE_LABEL[fb.type]}</span>
      <div className={styles.sender}>
        <div className={styles.avatar} style={{ background: avatarColor }} />
        <div className={styles.senderInfo}>
          <span className={styles.senderName}>{persona?.name ?? '市民'}</span>
          <span className={styles.senderTitle}>{persona?.title ?? ''}</span>
        </div>
      </div>
      <div className={styles.content}>{fb.content}</div>
      <div className={styles.meta}>
        {fb.projectId && projectName ? (
          <span className={styles.relatedProject}>
            涉及工程：{projectName}
            {onViewProject && (
              <>
                {'　'}
                <button className={styles.relatedLink} onClick={() => onViewProject(fb.projectId!)}>
                  查看相关工程
                </button>
              </>
            )}
          </span>
        ) : (
          <span className={styles.relatedProject} />
        )}
        <span className={styles.time}>{fmtTime(fb.createdAt)}</span>
      </div>
      <div className={styles.docNo}>{fb.docNumber}</div>
    </div>
  );
}

/* ---------- 热线面板（右侧抽屉） ---------- */
export function HotlinePanel({
  open,
  onClose,
  onViewProject,
  feedbacks: feedbacksProp,
  projects: projectsProp,
}: {
  open: boolean;
  onClose: () => void;
  /** 查看相关工程：关面板 + 开 ProjectCard */
  onViewProject: (projectId: string) => void;
  /**
   * 可选 fixture 注入：仅供组件视觉测试（?hotlinetest）传入，完全不经过正式 Store。
   * 正式产品不传，组件照常订阅 Zustand。
   */
  feedbacks?: CitizenFeedback[];
  projects?: Project[];
}) {
  // 始终调用 hook（保持 hook 顺序稳定）；传入 prop 时以 prop 为准，否则用 Store。
  const feedbacksStore = useGameStore((s) => s.feedbacks);
  const projectsStore = useGameStore((s) => s.projects);
  const feedbacks = feedbacksProp ?? feedbacksStore;
  const projects = projectsProp ?? projectsStore;

  const projectNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  // 倒序，取最近 MAX_SHOWN
  const shown = useMemo(
    () => [...feedbacks].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_SHOWN),
    [feedbacks],
  );

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="12345 市民热线">
        <div className={styles.titleBar}>
          <div className={styles.titleWrap}>
            <span className={styles.titleMain}>12345 市民热线</span>
            <span className={styles.titleSub}>群众诉求与城市建设意见</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            X
          </button>
        </div>

        <div className={styles.list}>
          {shown.length === 0 ? (
            <div className={styles.empty}>
              当前暂无新的群众诉求。
              <br />
              <span className={styles.emptySub}>城市建设工作总体平稳。</span>
            </div>
          ) : (
            <>
              {shown.map((fb) => (
                <FeedbackItem
                  key={fb.id}
                  fb={fb}
                  projectName={fb.projectId ? projectNameById.get(fb.projectId) : undefined}
                  onViewProject={fb.projectId ? onViewProject : undefined}
                />
              ))}
              {feedbacks.length > MAX_SHOWN && (
                <div className={styles.listFoot}>
                  共 {feedbacks.length} 条群众诉求，展示最近 {MAX_SHOWN} 条
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
