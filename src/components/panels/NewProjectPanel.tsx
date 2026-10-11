/**
 * NewProjectPanel —— 申请立项完整链路（TASK-11 + TASK-11.1）。
 *
 * 流程：input（像素 UI 自然语言输入）→ loading → approval（公文批复，AI 起草 + 市长审定）
 *   → 返回修改（回 input，保留输入，不写 Store）
 *   → 批准立项（用市长审定后的值 onApprove → store.addProject）
 *
 * TASK-11.1 要点：
 * - 批复正文为动态 sections（每项目 3–5 个与目标相关的小节），非固定模板。
 * - 关键参数（项目名称/建设目标/验收标准/建设周期/施工频率）可在批准前编辑；
 *   建议值（meta.source==='suggested'）显示"建议"标签。
 * - 批准写入 Store 的是市长审定后的最终值，而非最初 AI Draft。
 */
import { useEffect, useState } from 'react';
import { aiClient } from '@/ai/aiClient';
import { deriveBuildingType } from '@/ai/semantics';
import type { AnnualPolicy, ProgressFrequency, Project, ProjectDraft } from '@/store/types';
import Modal from '@/components/ui/Modal';
import styles from './document.module.css';

export interface NewProjectPanelProps {
  open: boolean;
  cityName: string;
  currentYear: number;
  projectCounter: number;
  currentPolicy: AnnualPolicy | null;
  existingProjects?: Project[];
  /** 批准立项：传入市长审定后的 draft 与原始输入；上层调用 store.addProject */
  onApprove: (draft: ProjectDraft, originalInput: string) => void;
  onClose: () => void;
}

const MAX_INPUT = 200;

const FREQ_LABEL: Record<ProgressFrequency, string> = {
  daily: '每日施工',
  'several-times-weekly': '每周多次施工',
  weekly: '每周施工',
  'long-term': '长期推进',
};
const FREQ_OPTIONS: ProgressFrequency[] = ['daily', 'several-times-weekly', 'weekly', 'long-term'];

type Phase = 'input' | 'loading' | 'approval';

function todayCn(): string {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 批复页内可编辑的审定字段（从 draft 初始化，批准时写回 draft） */
interface EditState {
  name: string;
  goal: string;
  acceptanceCriteria: string;
  duration: string;
  progressScheduleText: string;
  progressFrequency: ProgressFrequency;
}

export default function NewProjectPanel({
  open,
  cityName,
  currentYear,
  projectCounter,
  currentPolicy,
  existingProjects = [],
  onApprove,
  onClose,
}: NewProjectPanelProps) {
  const [phase, setPhase] = useState<Phase>('input');
  const [input, setInput] = useState('');
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);

  // draft 到达后，用其值初始化可编辑表单
  useEffect(() => {
    if (draft) {
      setEdit({
        name: draft.name,
        goal: draft.goal,
        acceptanceCriteria: draft.acceptanceCriteria,
        duration: draft.duration ?? '',
        progressScheduleText: draft.progressScheduleText ?? '',
        progressFrequency: draft.progressFrequency,
      });
    }
  }, [draft]);

  const trimmed = input.trim();
  const valid = trimmed.length > 0;

  const reset = () => {
    setPhase('input');
    setInput('');
    setTouched(false);
    setDraft(null);
    setEdit(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setTouched(true);
    if (!valid || phase === 'loading') return;
    setPhase('loading');
    try {
      const d = await aiClient.createProject(trimmed, currentYear, projectCounter + 1, {
        currentPolicy,
        cityName,
        existingProjects,
      });
      setDraft(d);
      setPhase('approval');
    } catch {
      setPhase('input');
    }
  };

  const backToEdit = () => {
    setDraft(null);
    setEdit(null);
    setPhase('input'); // 保留 input，不写 Store
  };

  const approve = () => {
    if (!draft || !edit) return;
    // 用市长审定后的值覆盖 draft 关键字段，再写入 Store
    const base: ProjectDraft = {
      ...draft,
      name: edit.name.trim() || draft.name,
      goal: edit.goal.trim() || draft.goal,
      acceptanceCriteria: edit.acceptanceCriteria.trim() || draft.acceptanceCriteria,
      duration: edit.duration.trim() || draft.duration,
      progressScheduleText: edit.progressScheduleText.trim() || draft.progressScheduleText,
      progressFrequency: edit.progressFrequency,
      // 市长改过的字段来源视为 user（已审定）
      meta: {
        ...draft.meta,
        duration: edit.duration.trim() !== (draft.duration ?? '') ? 'user' : draft.meta.duration,
        progressFrequency:
          edit.progressFrequency !== draft.progressFrequency ? 'user' : draft.meta.progressFrequency,
      },
    };
    // 批准瞬间按最终审定值确定性推导楼型（不沿用 AI 初稿 buildingType，避免 1 个月仍是 tower）
    const finalDraft: ProjectDraft = { ...base, buildingType: deriveBuildingType(base) };
    onApprove(finalDraft, trimmed);
    reset();
  };

  if (!open) return null;

  /* ---------- 输入 / loading：像素 Modal ---------- */
  if (phase === 'input' || phase === 'loading') {
    const loading = phase === 'loading';
    return (
      <Modal
        open
        title="XX 市重点建设项目申报"
        onClose={handleClose}
        closeOnOverlay={!loading}
        showClose={!loading}
        actions={
          loading
            ? []
            : [
                { label: '取消', onClick: handleClose },
                { label: '提交立项申请', onClick: submit, variant: 'primary' },
              ]
        }
      >
        {loading ? (
          <div style={{ padding: '10px 0', lineHeight: 2 }}>
            市建设管理部门正在审核立项申请……
            <br />
            <span style={{ color: 'var(--pixel-abandoned)', fontSize: 13 }}>
              （正在将市长的目标转化为市政建设项目）
            </span>
          </div>
        ) : (
          <div>
            <label htmlFor="projectInput" style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              拟建设事项（必填）
            </label>
            <textarea
              id="projectInput"
              autoFocus
              value={input}
              maxLength={MAX_INPUT}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：考公 / 准备明年省考，每周学习5天 / 我想减脂 / 做一个个人博客"
              rows={3}
              style={textareaStyle}
            />
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                minHeight: 16,
                color: touched && !valid ? 'var(--pixel-halted)' : '#6f7590',
              }}
            >
              {touched && !valid
                ? '申报材料不完整，请填写拟建设事项方可呈报。'
                : `直接说明你的目标即可，最多 ${MAX_INPUT} 字。`}
            </div>
          </div>
        )}
      </Modal>
    );
  }

  /* ---------- 批复：公文轨（动态 sections + 可审定字段） ---------- */
  if (phase === 'approval' && draft && edit) {
    const docNo = `${cityName.replace(/\s/g, '')}建批〔${currentYear}〕第 ${String(
      projectCounter + 1,
    ).padStart(3, '0')} 号`;
    const durSuggested = draft.meta.duration === 'suggested';
    const freqSuggested = draft.meta.progressFrequency === 'suggested';

    return (
      <div className={styles.docOverlay}>
        <div className={styles.docPaper} role="dialog" aria-modal="true" aria-label="立项批复">
          <div className={styles.docInner}>
            <div className={styles.docOrg}>{cityName}建设管理局</div>
            <div className={styles.docRule} />
            <div className={styles.docDocNo}>{docNo}</div>

            <div className={styles.docTitle}>关于「{edit.name}」的立项批复</div>

            <div className={styles.docBody}>
              <p>市长于近期提交的建设申请，经本局审核，现予以正式批复如下：</p>
            </div>

            <div className={styles.docQuote}>市长原始申请事项：{trimmed}</div>

            <div className={styles.docReviewHint}>
              以下关键参数由本局起草，<strong>请市长审定后批准</strong>；标注"建议"者为本局拟定值，可修改。
            </div>

            {/* 可审定字段 */}
            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>项目名称</label>
              <input
                className={styles.docInput}
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </div>

            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>建设目标</label>
              <textarea
                className={`${styles.docInput} ${styles.docTextarea}`}
                rows={2}
                value={edit.goal}
                onChange={(e) => setEdit({ ...edit, goal: e.target.value })}
              />
            </div>

            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>
                建设周期
                {durSuggested && <span className={styles.docSuggestTag}>建议</span>}
              </label>
              <input
                className={styles.docInput}
                value={edit.duration}
                placeholder="如：3个月"
                onChange={(e) => setEdit({ ...edit, duration: e.target.value })}
              />
            </div>

            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>精确施工安排</label>
              <input
                className={styles.docInput}
                value={edit.progressScheduleText}
                placeholder="如：每周5天"
                onChange={(e) => setEdit({ ...edit, progressScheduleText: e.target.value })}
              />
            </div>

            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>
                施工频率（用于工程进度监管）
                {freqSuggested && <span className={styles.docSuggestTag}>建议</span>}
              </label>
              <select
                className={styles.docSelect}
                value={edit.progressFrequency}
                onChange={(e) =>
                  setEdit({ ...edit, progressFrequency: e.target.value as ProgressFrequency })
                }
              >
                {FREQ_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {FREQ_LABEL[f]}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.docEditRow}>
              <label className={styles.docEditLabel}>验收标准</label>
              <textarea
                className={`${styles.docInput} ${styles.docTextarea}`}
                rows={2}
                value={edit.acceptanceCriteria}
                onChange={(e) => setEdit({ ...edit, acceptanceCriteria: e.target.value })}
              />
            </div>

            {/* 动态正文小节 */}
            {draft.sections.map((s, i) => (
              <div key={i} className={styles.docSection}>
                <div className={styles.docSectionTitle}>{s.title}</div>
                <div className={styles.docSectionBody}>{s.content}</div>
              </div>
            ))}

            <div className={styles.docBody}>
              <p>{draft.approvalNote}</p>
            </div>

            {currentPolicy && (
              <div className={styles.docNotice}>
                <span className={styles.docNoticeLabel}>年度方针提示：</span>
                本年度全市坚持"{currentPolicy.title}"的建设方针，请市长在推进本项目时予以统筹。
              </div>
            )}

            <div className={styles.docSign}>
              <div>{cityName}建设管理局</div>
              <div className={styles.docSignDate}>{todayCn()}</div>
            </div>

            <div className={styles.docSeal}>
              {cityName}
              <br />
              建设管理局
            </div>
          </div>

          <div className={styles.docActions}>
            <button className={styles.docBtn} onClick={backToEdit}>
              返回修改
            </button>
            <button className={`${styles.docBtn} ${styles.docBtnPrimary}`} onClick={approve}>
              批准立项
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#10121f',
  border: '2px solid var(--pixel-ui-border)',
  color: 'var(--pixel-ui-text)',
  fontSize: 14,
  lineHeight: 1.7,
  padding: '10px 12px',
  fontFamily: 'inherit',
  resize: 'vertical',
};
