/**
 * ProjectCard —— 项目建设档案（TASK-12）。
 *
 * 施工档案风（像素外框 + 米白档案纸），比立项批复轻。
 * 关键：传入 projectId，内部实时订阅 Store 中该项目，保证 recordProgress / completeProject 后立即刷新
 * （不复制长期不更新的旧 Project 对象）。
 *
 * 操作权限矩阵：
 *   construction / warning / halted → 今日有施工 + 申请竣工验收
 *   abandoned → 只读 + 启动/查看专项审计（TASK-17，仅生成只读报告，不含治理动作）
 *   completed → 只读
 * 本任务不实现：复工/降规/爆破（TASK-18）、停工检测（TASK-13）。
 * 审计（TASK-17）：仅 abandoned 开放；生成只读报告写入 project.auditReport，不触发任何治理。
 */
import { useMemo, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { aiClient } from '@/ai/aiClient';
import { submitProgress, injectDemoProgressHistory } from '@/logic/progressTracker';
import { restartProjectAction, generateDowngradeDraft, approveDowngrade } from '@/logic/projectManager';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Modal from '@/components/ui/Modal';
import AuditReport from '@/components/panels/AuditReport';
import type { AuditConclusion, ProgressFrequency, Project, ProjectDraft, ProjectStatus } from '@/store/types';
import { FREQUENCY_THRESHOLDS } from '@/store/types';
import styles from './projectCard.module.css';

export interface ProjectCardProps {
  projectId: string | null;
  onClose: () => void;
  /** 备案/竣工成功后对外抛通知（文案由上层统一经 NotificationStack 展示） */
  onNotify: (kind: 'info' | 'success', title: string, message: string) => void;
  /** 竣工完成后回调（供上层生成市民反馈等） */
  onProjectCompleted?: (projectId: string) => void;
  /** 专项审计报告生成后回调（TASK-20 公告）：仅在新报告生成时触发一次，不含"查看已有报告" */
  onAuditGenerated?: (projectId: string) => void;
  /** 复工成功回调（TASK-18）：供上层发通知 + 生成市民正面反馈 */
  onProjectRestarted?: (project: Project) => void;
  /** 规划降级成功回调（TASK-18）：供上层发通知 + 生成市民中性反馈 */
  onProjectDowngraded?: (project: Project) => void;
  /**
   * 请求爆破销项（TASK-18）：上层（持有 Canvas）负责存快照 → 播放动画 → 完成后 demolish + 通知/反馈，
   * 或在现场定位失败时提示并中止。ProjectCard 仅在最强确认后发起请求，不直接删除。
   */
  onRequestDemolish?: (projectId: string) => void;
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  construction: '在建',
  warning: '施工预警',
  halted: '停工',
  abandoned: '烂尾',
  completed: '竣工',
};

/** 审计建议（conclusion）→ 只读文案；与 AuditReport 一致（突出推荐，不强制服从） */
const CONCLUSION_LABEL: Record<AuditConclusion, string> = {
  restart: '建议复工',
  downgrade: '建议调整建设规模',
  demolish: '建议爆破销项',
};

const STATUS_BADGE: Record<ProjectStatus, string> = {
  construction: styles.badgeConstruction,
  warning: styles.badgeWarning,
  halted: styles.badgeHalted,
  abandoned: styles.badgeAbandoned,
  completed: styles.badgeCompleted,
};

const FREQ_LABEL: Record<ProgressFrequency, string> = {
  daily: '每日施工',
  'several-times-weekly': '每周多次施工',
  weekly: '每周施工',
  'long-term': '长期推进',
};

const MAX_NOTE = 120;
const RECENT_RECORDS = 5;

/** 时间戳 → "2026年10月8日 22:30" */
function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${mm}月${dd}日 ${hh}:${mi}`;
}

/** "2026-10-08" → "10月8日" */
function fmtRecordDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

export default function ProjectCard({
  projectId,
  onClose,
  onNotify,
  onProjectCompleted,
  onAuditGenerated,
  onProjectRestarted,
  onProjectDowngraded,
  onRequestDemolish,
}: ProjectCardProps) {
  // 实时订阅：始终反映 Store 中最新的该项目
  const project = useGameStore((s) => s.projects.find((p) => p.id === projectId) ?? null);

  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);

  // 专项审计（TASK-17）
  const [auditing, setAuditing] = useState(false);
  const [auditPhase, setAuditPhase] = useState<'idle' | 'reading' | 'drafting'>('idle');
  const [auditOpen, setAuditOpen] = useState(false);

  // 烂尾工程治理（TASK-18）
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDemolish, setConfirmDemolish] = useState(false);
  // 规划降级：input（输入缩减要求）→ loading → review（审定新方案）
  const [downgradePhase, setDowngradePhase] = useState<'closed' | 'input' | 'loading' | 'review'>('closed');
  const [downgradeInput, setDowngradeInput] = useState('');
  const [downgradeDraft, setDowngradeDraft] = useState<ProjectDraft | null>(null);

  const completeProject = useGameStore((s) => s.completeProject);
  const isDemoMode = useGameStore((s) => s.isDemoMode);
  const cityName = useGameStore((s) => s.cityName);
  const saveAuditReport = useGameStore((s) => s.saveAuditReport);
  const markWarning = useGameStore((s) => s.markWarning);
  const markHalted = useGameStore((s) => s.markHalted);
  const markAbandoned = useGameStore((s) => s.markAbandoned);

  const recentRecords = useMemo(() => {
    if (!project) return [];
    return [...project.progressRecords].reverse().slice(0, RECENT_RECORDS);
  }, [project]);

  if (!projectId || !project) return null;

  const status = project.status;
  const canRecord = status === 'construction' || status === 'warning' || status === 'halted';
  const isAbandoned = status === 'abandoned';
  const isCompleted = status === 'completed';

  const handleSubmitProgress = async () => {
    if (!canRecord || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitProgress(project.id, note);
      if (result) {
        setNote('');
        const msg = result.recovered
          ? '施工记录已备案。项目已恢复正常施工。'
          : `施工记录已备案。「${project.name}」今日正常施工。`;
        onNotify('success', '施工备案', msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const doComplete = () => {
    setConfirmComplete(false);
    const pid = project.id;
    completeProject(pid);
    onNotify('success', '竣工验收', `「${project.name}」已通过竣工验收。`);
    onProjectCompleted?.(pid);
  };

  // 仅 Demo：注入历史施工记录（35/25/15/5 天前），用于演示停滞链路（配合 TASK-13 检测）
  const handleDemoInject = () => {
    injectDemoProgressHistory(project.id, [35, 25, 15, 5]);
    onNotify('info', '演示数据', '已注入历史施工记录（最近施工为 5 天前），可用于演示停滞判定。');
  };

  // 仅 Demo：一键模拟烂尾，便于验收 TASK-17 专项审计（不必等每小时停工检测）。
  // 按该项目频率的 abandoned 阈值注入足够久远的最近施工时间，再逐级推进状态机到 abandoned。
  const handleDemoAbandon = () => {
    if (!canRecord) return;
    const abandonDays = FREQUENCY_THRESHOLDS[project.progressFrequency][2];
    // 最近施工设为超过烂尾阈值 2 天，确保确为烂尾口径
    injectDemoProgressHistory(project.id, [abandonDays + 10, abandonDays + 2]);
    // 逐级推进（尊重 store 状态机守卫：construction→warning→halted→abandoned）
    markWarning(project.id);
    markHalted(project.id);
    markAbandoned(project.id);
    onNotify('info', '演示数据', `已将「${project.name}」模拟推进为烂尾工程，可启动专项审计。`);
  };

  // 专项审计（TASK-17）：仅 abandoned 可发起；已有报告直接查看，不重复调用 AI。
  const handleAudit = async () => {
    if (!isAbandoned || auditing) return;
    // 已有报告 → 直接查看（不调用 AI，避免同一项目报告反复变化）
    if (project.auditReport) {
      setAuditOpen(true);
      return;
    }
    // 两阶段加载文案（非动画系统）：调阅台账 → 形成审计意见
    setAuditing(true);
    setAuditPhase('reading');
    onNotify('info', '专项审计', '人生建设管理局正在调阅施工台账……');
    // 轻微停顿让第一阶段文案可见
    await new Promise((r) => setTimeout(r, 500));
    setAuditPhase('drafting');
    onNotify('info', '专项审计', '正在形成专项审计意见……');
    // aiClient.auditProject 内部已有 sanitize + mock 兜底，不会抛错
    const report = await aiClient.auditProject(project);
    saveAuditReport(project.id, report);
    setAuditing(false);
    setAuditPhase('idle');
    setAuditOpen(true);
    // 仅"新生成报告"时播审计完成公告（查看已有报告的分支在上方 early-return，不会到这里）
    onAuditGenerated?.(project.id);
  };

  const auditBtnLabel = auditing
    ? auditPhase === 'reading'
      ? '调阅施工台账…'
      : '形成审计意见…'
    : project.auditReport
      ? '查看专项审计报告'
      : '启动专项审计';

  /* ---------- 烂尾工程治理（TASK-18，仅 isAbandoned && auditReport 存在时可用） ---------- */

  // 复工
  const doRestart = () => {
    setConfirmRestart(false);
    const pid = project.id;
    const updated = restartProjectAction(pid);
    if (updated) onProjectRestarted?.(updated);
  };

  // 规划降级：第一步生成缩减草案
  const submitDowngrade = async () => {
    const trimmed = downgradeInput.trim();
    if (!trimmed || downgradePhase === 'loading') return;
    setDowngradePhase('loading');
    const draft = await generateDowngradeDraft(project, trimmed);
    setDowngradeDraft(draft);
    setDowngradePhase('review');
  };

  // 规划降级：第二步市长审定批准
  const doApproveDowngrade = () => {
    if (!downgradeDraft) return;
    const pid = project.id;
    const updated = approveDowngrade(pid, downgradeDraft, downgradeInput.trim());
    closeDowngrade();
    if (updated) onProjectDowngraded?.(updated);
  };

  const closeDowngrade = () => {
    setDowngradePhase('closed');
    setDowngradeInput('');
    setDowngradeDraft(null);
  };

  // 爆破销项：最强确认后交由上层（持有 Canvas）执行动画 → demolish
  const doDemolish = () => {
    if (import.meta.env?.DEV) console.log('[demolish] 1 confirm');
    const pid = project.id;
    setConfirmDemolish(false);
    if (import.meta.env?.DEV) console.log('[demolish] 2 request projectId=', pid, 'onRequestDemolish?', !!onRequestDemolish);
    onRequestDemolish?.(pid);
  };

  const canGovern = isAbandoned && project.auditReport != null;
  const auditConclusionLabel = project.auditReport
    ? CONCLUSION_LABEL[project.auditReport.conclusion]
    : '';

  return (
    <div className={styles.overlay}>
      <div className={styles.frame} role="dialog" aria-modal="true" aria-label="项目建设档案">
        <div className={styles.titleBar}>
          <span className={styles.titleText}>项目建设档案</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            X
          </button>
        </div>

        <div className={styles.paper}>
          {/* 名称 + 状态 */}
          <div className={styles.header}>
            <div>
              <div className={styles.projName}>{project.name}</div>
              <div className={styles.projId}>项目编号 {project.id}</div>
            </div>
            <span className={`${styles.badge} ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
          </div>

          {/* 元信息 */}
          <div className={styles.metaGrid}>
            <span className={styles.metaLabel}>项目类型</span>
            <span className={styles.metaValue}>{project.type}</span>
            <span className={styles.metaLabel}>立项年份</span>
            <span className={styles.metaValue}>{project.year} 年</span>
            <span className={styles.metaLabel}>立项时间</span>
            <span className={styles.metaValue}>{fmtDateTime(project.createdAt)}</span>
            <span className={styles.metaLabel}>建设目标</span>
            <span className={styles.metaValue}>{project.plan.goal}</span>
            {project.plan.duration && (
              <>
                <span className={styles.metaLabel}>建设周期</span>
                <span className={styles.metaValue}>{project.plan.duration}</span>
              </>
            )}
            {project.plan.progressScheduleText && (
              <>
                <span className={styles.metaLabel}>精确施工安排</span>
                <span className={styles.metaValue}>{project.plan.progressScheduleText}</span>
              </>
            )}
            <span className={styles.metaLabel}>施工频率</span>
            <span className={styles.metaValue}>{FREQ_LABEL[project.progressFrequency]}</span>
            <span className={styles.metaLabel}>验收标准</span>
            <span className={styles.metaValue}>{project.plan.acceptanceCriteria}</span>
            <span className={styles.metaLabel}>最近施工</span>
            <span className={styles.metaValue}>{fmtDateTime(project.lastProgressAt)}</span>
            {project.restartCount > 0 && (
              <>
                <span className={styles.metaLabel}>复工次数</span>
                <span className={styles.metaValue}>{project.restartCount} 次</span>
              </>
            )}
            {isCompleted && project.completedAt && (
              <>
                <span className={styles.metaLabel}>竣工时间</span>
                <span className={styles.metaValue}>{fmtDateTime(project.completedAt)}</span>
              </>
            )}
          </div>

          {/* 建设方案（动态 sections） */}
          {project.plan.sections.length > 0 && (
            <>
              <div className={styles.sectionTitle}>建设方案</div>
              {project.plan.sections.map((s, i) => (
                <div key={i} className={styles.planSection}>
                  <div className={styles.planSectionTitle}>{s.title}</div>
                  <div className={styles.planSectionBody}>{s.content}</div>
                </div>
              ))}
            </>
          )}

          {/* 烂尾提示 */}
          {isAbandoned && (
            <div className={styles.statusNotice}>
              该项目已认定为烂尾工程，需启动专项治理程序。
            </div>
          )}

          {/* 烂尾工程治理区（TASK-18）：仅在已完成专项审计后出现 */}
          {canGovern && (
            <div className={styles.governBox}>
              <div className={styles.governTitle}>烂尾工程治理</div>
              <div className={styles.governRow}>
                专项审计：<b>已完成</b>
              </div>
              <div className={styles.governRow}>
                审计建议：<span className={styles.governAdvice}>{auditConclusionLabel}</span>
              </div>
              <div className={styles.governHint}>
                审计建议仅供参考，最终处置由市长决定。请选择治理方式：
              </div>
              <div className={styles.governActions}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setConfirmRestart(true)}>
                  复工
                </button>
                <button className={styles.btn} onClick={() => setDowngradePhase('input')}>
                  规划降级
                </button>
                <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => setConfirmDemolish(true)}>
                  爆破销项
                </button>
              </div>
            </div>
          )}

          {/* 施工记录 */}
          <div className={styles.sectionTitle}>施工备案记录</div>
          {recentRecords.length === 0 ? (
            <div className={styles.recordEmpty}>暂无施工备案记录。</div>
          ) : (
            recentRecords.map((r) => (
              <div key={r.id} className={styles.recordItem}>
                <div className={styles.recordDate}>
                  {fmtRecordDate(r.date)}
                  {r.source === 'demo' && <span className={styles.recordDemoTag}>[演示数据]</span>}
                </div>
                <div className={styles.recordNote}>{r.note || '（未填写施工内容）'}</div>
              </div>
            ))
          )}

          {/* 施工备案表单（仅可备案状态） */}
          {canRecord && (
            <div className={styles.recordForm}>
              <label className={styles.recordFormLabel} htmlFor="progressNote">
                今日施工内容（选填）
              </label>
              <textarea
                id="progressNote"
                className={styles.recordInput}
                value={note}
                maxLength={MAX_NOTE}
                rows={2}
                placeholder="例如：刷了两套行测题（留空也可直接备案）"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className={styles.actions}>
          {canRecord && (
            <>
              {isDemoMode && (
                <>
                  <button className={styles.btn} onClick={handleDemoInject}>
                    [演示] 注入历史施工记录
                  </button>
                  <button className={styles.btn} onClick={handleDemoAbandon}>
                    [演示] 模拟烂尾
                  </button>
                </>
              )}
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={handleSubmitProgress}
                disabled={submitting}
              >
                {submitting ? '备案中…' : '今日有施工'}
              </button>
              <button className={styles.btn} onClick={() => setConfirmComplete(true)}>
                申请竣工验收
              </button>
            </>
          )}
          {isAbandoned && (
            <button
              className={`${styles.btn} ${project.auditReport ? '' : styles.btnPrimary}`}
              onClick={handleAudit}
              disabled={auditing}
            >
              {auditBtnLabel}
            </button>
          )}
          <button className={styles.btn} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmComplete}
        title="竣工验收确认"
        message="确认该项目已达到既定验收标准并申请竣工？"
        confirmLabel="确认竣工"
        cancelLabel="再想想"
        confirmVariant="primary"
        onConfirm={doComplete}
        onCancel={() => setConfirmComplete(false)}
      />

      {/* 专项审计报告（TASK-17，只读；实时读取 project.auditReport） */}
      <AuditReport
        open={auditOpen}
        cityName={cityName}
        project={project}
        report={project.auditReport ?? null}
        onClose={() => setAuditOpen(false)}
      />

      {/* 复工确认（TASK-18） */}
      <ConfirmDialog
        open={confirmRestart}
        title="复工确认"
        message={`确认对「${project.name}」办理复工？项目将恢复为在建状态，并记入正式复工次数。`}
        confirmLabel="确认复工"
        cancelLabel="再想想"
        confirmVariant="primary"
        onConfirm={doRestart}
        onCancel={() => setConfirmRestart(false)}
      />

      {/* 爆破销项确认（TASK-18，最强确认） */}
      <ConfirmDialog
        open={confirmDemolish}
        title="控制爆破确认"
        message={`本操作将对「${project.name}」实施控制爆破，操作不可撤销，请市长慎重决策。`}
        confirmLabel="确认爆破销项"
        cancelLabel="取消"
        confirmVariant="danger"
        onConfirm={doDemolish}
        onCancel={() => setConfirmDemolish(false)}
      />

      {/* 规划降级：输入缩减要求（TASK-18） */}
      {downgradePhase === 'input' || downgradePhase === 'loading' ? (
        <Modal
          open
          title="规划降级申请"
          onClose={closeDowngrade}
          closeOnOverlay={downgradePhase !== 'loading'}
          showClose={downgradePhase !== 'loading'}
          actions={
            downgradePhase === 'loading'
              ? []
              : [
                  { label: '取消', onClick: closeDowngrade },
                  { label: '提交降级申请', onClick: submitDowngrade, variant: 'primary' },
                ]
          }
        >
          {downgradePhase === 'loading' ? (
            <div style={{ padding: '10px 0', lineHeight: 2 }}>
              市建设管理部门正在重新评估建设规模……
            </div>
          ) : (
            <div>
              <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
                缩减后的建设目标（请说明收缩后的范围）
              </label>
              <textarea
                className={styles.downgradeInput}
                rows={3}
                autoFocus
                value={downgradeInput}
                maxLength={200}
                placeholder={`例如：由「${project.plan.goal}」收缩为更小、更可执行的目标`}
                onChange={(e) => setDowngradeInput(e.target.value)}
              />
            </div>
          )}
        </Modal>
      ) : null}

      {/* 规划降级：审定新方案（TASK-18，市长批准后才落库） */}
      {downgradePhase === 'review' && downgradeDraft ? (
        <Modal
          open
          title="规划降级方案审定"
          onClose={closeDowngrade}
          actions={[
            { label: '返回修改', onClick: () => setDowngradePhase('input') },
            { label: '批准调整', onClick: doApproveDowngrade, variant: 'primary' },
          ]}
        >
          <div style={{ lineHeight: 1.9 }}>
            <div className={styles.downgradeField}>
              <span className="dfLabel">调整后项目名称</span>
              <span className="dfValue">{downgradeDraft.name}</span>
            </div>
            <div className={styles.downgradeField}>
              <span className="dfLabel">建设目标</span>
              <span className="dfValue">{downgradeDraft.goal}</span>
            </div>
            <div className={styles.downgradeField}>
              <span className="dfLabel">建设周期</span>
              <span className="dfValue">{downgradeDraft.duration || '（按新方案推进）'}</span>
            </div>
            <div className={styles.downgradeField}>
              <span className="dfLabel">施工频率</span>
              <span className="dfValue">{FREQ_LABEL[downgradeDraft.progressFrequency]}</span>
            </div>
            <div className={styles.downgradeField}>
              <span className="dfLabel">精确施工安排</span>
              <span className="dfValue">{downgradeDraft.progressScheduleText || '（未指定）'}</span>
            </div>
            <div className={styles.downgradeField}>
              <span className="dfLabel">验收标准</span>
              <span className="dfValue">{downgradeDraft.acceptanceCriteria}</span>
            </div>
            <div style={{ fontSize: 12, color: '#9aa0b5', marginTop: 8, lineHeight: 1.7 }}>
              批准后将按上述缩减方案更新项目档案，并恢复为在建状态。
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
