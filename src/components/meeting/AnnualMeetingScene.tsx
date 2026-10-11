/**
 * AnnualMeetingScene —— 年度市政工作会议（TASK-20）。
 *
 * 完整年度闭环：报告生成 → 三段公文展示 → 下一年度 3 方针候选 → 市长三选一 → 归档+年份+1+新方针生效 → 返回城市。
 *
 * 复用：
 *  - TASK-19 buildAnnualReport（不重算统计口径）
 *  - aiClient.generateNextPolicyCandidates（固定 3 条，带 mock + fallback）
 *  - document.module.css 公文样式
 *  - store: addAnnualReport / advanceYear / setCurrentPolicy（年份切换严格顺序由本组件编排）
 *
 * 边界：静态会议厅（无复杂动画/逐字打印），不做档案馆 / KPI / skyline / 经济系统。
 */
import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { buildAnnualReport } from '@/logic/reportBuilder';
import { aiClient } from '@/ai/aiClient';
import type { AnnualPolicy, AnnualReport } from '@/store/types';
import styles from '@/components/panels/document.module.css';

export interface AnnualMeetingSceneProps {
  open: boolean;
  /** 关闭会议（返回城市）。meetingYear/newPolicy 在"完成散会"时提供，供上层发一次通知。 */
  onClose: () => void;
  /**
   * 散会提交：严格顺序由上层执行 advanceYear → setCurrentPolicy → 通知。
   * 传入已归档年份与选定的下一年方针（year 已是下一年）。
   */
  onAdjourn: (archivedYear: number, nextPolicy: AnnualPolicy) => void;
}

type Step = 'preparing' | 'report' | 'policy' | 'done';

const PAGE_TITLES = ['一、本年度建设工作回顾', '二、存在问题与工作不足', '三、下一年度工作展望'];

export default function AnnualMeetingScene({ open, onClose, onAdjourn }: AnnualMeetingSceneProps) {
  const cityName = useGameStore((s) => s.cityName);
  const currentYear = useGameStore((s) => s.currentYear);

  const [step, setStep] = useState<Step>('preparing');
  const [report, setReport] = useState<AnnualReport | null>(null);
  const [page, setPage] = useState(0);
  const [candidates, setCandidates] = useState<AnnualPolicy[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [loadingPolicy, setLoadingPolicy] = useState(false);

  // 防止 StrictMode / 重复进入导致重复生成/归档
  const startedRef = useRef(false);

  // 进入会议：生成（或复用）本年度报告并归档一次
  useEffect(() => {
    if (!open) {
      // 关闭时复位，便于下次重新进入
      startedRef.current = false;
      setStep('preparing');
      setReport(null);
      setPage(0);
      setCandidates([]);
      setSelectedIdx(null);
      setLoadingPolicy(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const st = useGameStore.getState();
      // 去重归档：同一年已有报告则直接复用，不重新生成、不重复归档
      const existing = st.annualReports.find((r) => r.year === st.currentYear);
      if (existing) {
        setReport(existing);
        setStep('report');
        return;
      }
      const built = await buildAnnualReport(
        {
          cityName: st.cityName,
          projects: st.projects,
          demolishedProjects: st.demolishedProjects,
          feedbacks: st.feedbacks,
          policyHistory: st.policyHistory,
          currentPolicy: st.currentPolicy,
          currentYear: st.currentYear,
        },
        st.currentYear,
      );
      // 二次确认未被并发归档（保险），再归档
      if (!useGameStore.getState().annualReports.find((r) => r.year === built.year)) {
        useGameStore.getState().addAnnualReport(built);
      }
      setReport(built);
      setStep('report');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const enterPolicyStep = async () => {
    setStep('policy');
    setLoadingPolicy(true);
    const st = useGameStore.getState();
    // generateNextPolicyCandidates 已带 mock + 失败 fallback，始终返回 3 条（year = stats.year+1）
    const cands = await aiClient.generateNextPolicyCandidates(
      report!.stats,
      st.projects,
      st.currentPolicy ?? { year: st.currentYear, title: report!.stats.policyTitle, description: '', source: 'mayor-selected' },
      st.policyHistory,
      st.feedbacks,
    );
    setCandidates(cands.slice(0, 3));
    setLoadingPolicy(false);
  };

  const confirmPolicy = () => {
    if (selectedIdx == null || !report) return;
    const chosen = candidates[selectedIdx];
    // 市长最终选定：标记来源，year 由候选携带（= 本年度+1）
    const nextPolicy: AnnualPolicy = { ...chosen, source: 'mayor-selected' };
    setStep('done');
    // 严格顺序交由上层：advanceYear → setCurrentPolicy(nextPolicy) → 通知 → 关闭
    onAdjourn(report.year, nextPolicy);
    onClose();
  };

  const lastPage = page >= PAGE_TITLES.length - 1;
  const pageBody = report
    ? [report.sections.review, report.sections.problems, report.sections.outlook][page]
    : '';

  return (
    <div className={styles.docOverlay}>
      <div className={styles.docPaper} role="dialog" aria-modal="true" aria-label="年度市政工作会议">
        {/* 会议厅横幅（静态，无届次编号） */}
        <div
          style={{
            background: 'var(--doc-title, #c0392b)',
            color: '#fff',
            textAlign: 'center',
            padding: '12px 16px',
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: 1,
            fontFamily: "'SimHei','Microsoft YaHei',var(--font-doc-sans)",
          }}
        >
          {currentYear}年{cityName}市年度市政工作会议
        </div>

        <div className={styles.docInner}>
          {step === 'preparing' && (
            <div style={{ padding: '32px 0', textAlign: 'center', lineHeight: 2, color: '#555' }}>
              正在准备本年度政府工作报告……
            </div>
          )}

          {step === 'report' && report && (
            <>
              <div className={styles.docOrg}>{report.sections.title}</div>
              <div className={styles.docRule} />
              <div className={styles.docTitle}>{PAGE_TITLES[page]}</div>
              <div className={styles.docBody}>
                {pageBody.split('\n').map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </>
          )}

          {step === 'policy' && (
            <>
              <div className={styles.docOrg}>下一年度施政方针研究</div>
              <div className={styles.docRule} />
              {loadingPolicy ? (
                <div style={{ padding: '28px 0', textAlign: 'center', color: '#555', lineHeight: 2 }}>
                  AI 秘书正在研究下一年度施政方针……
                </div>
              ) : (
                <>
                  <div className={styles.docReviewHint}>
                    请市长从以下 3 个候选方针中<strong>选定一个</strong>作为下一年度施政方针（不可跳过）。
                  </div>
                  {candidates.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedIdx(i)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        margin: '0 0 12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        background: selectedIdx === i ? '#fdece6' : '#fff',
                        border: `2px solid ${selectedIdx === i ? 'var(--doc-title,#c0392b)' : '#d9d4c8'}`,
                        borderRadius: 2,
                        fontFamily: 'var(--font-doc-sans)',
                      }}
                    >
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a', marginBottom: 4 }}>
                        {c.title}
                      </div>
                      <div style={{ fontSize: 13, color: '#555', lineHeight: 1.7 }}>{c.description}</div>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* 底部操作区 */}
        <div className={styles.docActions}>
          {step === 'report' && (
            <>
              <button className={styles.docBtn} onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                上一页
              </button>
              {!lastPage ? (
                <button
                  className={`${styles.docBtn} ${styles.docBtnPrimary}`}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              ) : (
                <button className={`${styles.docBtn} ${styles.docBtnPrimary}`} onClick={enterPolicyStep}>
                  进入下一年度施政方针研究
                </button>
              )}
            </>
          )}
          {step === 'policy' && !loadingPolicy && (
            <button
              className={`${styles.docBtn} ${styles.docBtnPrimary}`}
              onClick={confirmPolicy}
              disabled={selectedIdx == null}
            >
              确立为下一年度施政方针
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
