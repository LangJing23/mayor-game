/**
 * ArchivePanel —— 城市建设档案馆（TASK-21，历史查看入口，非新玩法）。
 *
 * 三 Tab：工程档案 / 销项档案 / 年度政府工作报告。全部复用现有数据与公文视觉。
 *  - 工程档案：projects（最近立项优先），点击复用现有 ProjectCard（经 onOpenProject 交回 CityScene）。
 *  - 销项档案：demolishedProjects（数组倒序），只读展示快照 + 审计报告/历史，不提供任何治理操作。
 *  - 年度报告：annualReports（年份倒序），直接读已持久化报告，**禁止重算 buildAnnualReport**。
 *
 * 边界：无搜索/筛选/排序设置/分页/导出/图表/统计看板；不改 renderer/slot。
 */
import { useMemo, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import type { AnnualReport, AuditReport, Project, ProjectStatus } from '@/store/types';
import docStyles from './document.module.css';
import styles from './archive.module.css';

export interface ArchivePanelProps {
  open: boolean;
  onClose: () => void;
  /** 点击工程档案条目：交回 CityScene 打开现有 ProjectCard（复用其状态相关行为） */
  onOpenProject: (projectId: string) => void;
}

type Tab = 'projects' | 'demolished' | 'reports';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  construction: '在建',
  warning: '施工预警',
  halted: '停工',
  abandoned: '烂尾',
  completed: '竣工',
};

const CONCLUSION_LABEL: Record<AuditReport['conclusion'], string> = {
  restart: '建议复工',
  downgrade: '建议调整建设规模',
  demolish: '建议爆破销项',
};

export default function ArchivePanel({ open, onClose, onOpenProject }: ArchivePanelProps) {
  const cityName = useGameStore((s) => s.cityName);
  const projects = useGameStore((s) => s.projects);
  const demolishedProjects = useGameStore((s) => s.demolishedProjects);
  const annualReports = useGameStore((s) => s.annualReports);

  const [tab, setTab] = useState<Tab>('projects');
  // 销项/年报的只读详情（在档案馆内就地展开，不复用会带治理按钮的组件）
  const [demolishedId, setDemolishedId] = useState<string | null>(null);
  const [reportYear, setReportYear] = useState<number | null>(null);

  // 工程档案：最近立项优先
  const engineeringList = useMemo(
    () => [...projects].sort((a, b) => b.createdAt - a.createdAt),
    [projects],
  );
  // 销项档案：数组倒序（最近爆破在前）
  const demolishedList = useMemo(() => [...demolishedProjects].reverse(), [demolishedProjects]);
  // 年度报告：年份倒序
  const reportList = useMemo(() => [...annualReports].sort((a, b) => b.year - a.year), [annualReports]);

  const demolished = demolishedId ? demolishedProjects.find((p) => p.id === demolishedId) ?? null : null;
  const report = reportYear != null ? annualReports.find((r) => r.year === reportYear) ?? null : null;

  if (!open) return null;

  const switchTab = (t: Tab) => {
    setTab(t);
    setDemolishedId(null);
    setReportYear(null);
  };

  return (
    <div className={docStyles.docOverlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${docStyles.docPaper} ${styles.archivePaper}`} role="dialog" aria-modal="true" aria-label="城市建设档案">
        <div className={docStyles.docInner}>
          <div className={docStyles.docOrg}>{cityName}人生建设管理局</div>
          <div className={docStyles.docRule} />
          <div className={docStyles.docTitle}>城市建设档案</div>

          {/* Tab 切换 */}
          <div className={styles.tabs}>
            <button className={`${styles.tab} ${tab === 'projects' ? styles.tabActive : ''}`} onClick={() => switchTab('projects')}>
              工程档案
            </button>
            <button className={`${styles.tab} ${tab === 'demolished' ? styles.tabActive : ''}`} onClick={() => switchTab('demolished')}>
              销项档案
            </button>
            <button className={`${styles.tab} ${tab === 'reports' ? styles.tabActive : ''}`} onClick={() => switchTab('reports')}>
              年度报告
            </button>
          </div>

          {/* 工程档案 */}
          {tab === 'projects' && (
            <div className={styles.list}>
              {engineeringList.length === 0 ? (
                <div className={styles.empty}>暂无工程档案。</div>
              ) : (
                engineeringList.map((p) => (
                  <button key={p.id} className={styles.row} onClick={() => onOpenProject(p.id)}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>{p.name}</span>
                      <span className={`${styles.badge} ${styles[`badge_${p.status}`]}`}>{STATUS_LABEL[p.status]}</span>
                    </div>
                    <div className={styles.rowMeta}>
                      {p.year} 年立项 · {p.plan?.goal ?? p.originalInput}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* 销项档案 */}
          {tab === 'demolished' && !demolished && (
            <div className={styles.list}>
              {demolishedList.length === 0 ? (
                <div className={styles.empty}>暂无销项档案。</div>
              ) : (
                demolishedList.map((p) => (
                  <button key={p.id} className={styles.row} onClick={() => setDemolishedId(p.id)}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>{p.name}</span>
                      <span className={`${styles.badge} ${styles.badge_demolished}`}>已爆破销项</span>
                    </div>
                    <div className={styles.rowMeta}>
                      {p.year} 年立项 · {p.type}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* 销项只读详情 */}
          {tab === 'demolished' && demolished && (
            <DemolishedDetail project={demolished} onBack={() => setDemolishedId(null)} />
          )}

          {/* 年度报告列表 */}
          {tab === 'reports' && !report && (
            <div className={styles.list}>
              {reportList.length === 0 ? (
                <div className={styles.empty}>
                  暂无年度政府工作报告。
                  <br />
                  <span className={styles.emptySub}>年度会议召开后，报告将在此归档。</span>
                </div>
              ) : (
                reportList.map((r) => (
                  <button key={r.year} className={styles.row} onClick={() => setReportYear(r.year)}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>{r.year} 年政府工作报告</span>
                    </div>
                    <div className={styles.rowMeta}>年度建设方针：{r.policy?.title ?? r.stats.policyTitle}</div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* 年报只读详情 */}
          {tab === 'reports' && report && <ReportDetail report={report} onBack={() => setReportYear(null)} />}
        </div>

        <div className={docStyles.docActions}>
          <button className={docStyles.docBtn} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 销项只读详情（不提供任何治理操作） ---------- */
function DemolishedDetail({ project, onBack }: { project: Project; onBack: () => void }) {
  const audits: AuditReport[] = [
    ...(project.auditReport ? [project.auditReport] : []),
    ...(project.auditHistory ?? []),
  ];
  return (
    <div>
      <button className={styles.backBtn} onClick={onBack}>
        ← 返回销项档案
      </button>
      <div className={styles.detailName}>{project.name}</div>
      <div className={styles.detailMetaGrid}>
        <span className={styles.detailLabel}>项目类型</span>
        <span className={styles.detailValue}>{project.type}</span>
        <span className={styles.detailLabel}>立项年份</span>
        <span className={styles.detailValue}>{project.year} 年</span>
        <span className={styles.detailLabel}>建设目标</span>
        <span className={styles.detailValue}>{project.plan?.goal ?? project.originalInput}</span>
        <span className={styles.detailLabel}>档案状态</span>
        <span className={styles.detailValue}>已爆破销项</span>
      </div>

      {project.plan?.sections?.length ? (
        <>
          <div className={styles.detailSectionTitle}>原项目计划</div>
          {project.plan.sections.map((s, i) => (
            <div key={i} className={styles.detailSection}>
              <div className={styles.detailSectionHead}>{s.title}</div>
              <div className={styles.detailSectionBody}>{s.content}</div>
            </div>
          ))}
        </>
      ) : null}

      {audits.length > 0 ? (
        <>
          <div className={styles.detailSectionTitle}>审计记录（共 {audits.length} 次）</div>
          {audits.map((a, i) => (
            <div key={i} className={styles.detailSection}>
              <div className={styles.detailSectionHead}>
                审计估算完成度 {Math.max(0, Math.min(99, Math.round(a.completionEstimate)))}% · {CONCLUSION_LABEL[a.conclusion]}
              </div>
              <div className={styles.detailSectionBody}>{a.conclusionReason}</div>
            </div>
          ))}
        </>
      ) : (
        <div className={styles.detailNote}>本项目销项前无专项审计记录。</div>
      )}
    </div>
  );
}

/* ---------- 年报只读详情（直接读已持久化报告，不重算） ---------- */
function ReportDetail({ report, onBack }: { report: AnnualReport; onBack: () => void }) {
  const s = report.stats;
  return (
    <div>
      <button className={styles.backBtn} onClick={onBack}>
        ← 返回年度报告
      </button>
      <div className={docStyles.docTitle} style={{ marginTop: 8 }}>
        {report.sections.title}
      </div>
      <div className={styles.detailNote}>
        年度建设方针：{report.policy?.title ?? s.policyTitle} · 新立项 {s.totalProjects} · 竣工 {s.completed} ·
        年内完工率 {s.completionRate}% · 烂尾存量 {s.abandoned} · 累计销项 {s.demolished}
      </div>
      <div className={docStyles.docBody}>
        <div className={styles.reportHead}>一、本年度建设工作回顾</div>
        {report.sections.review.split('\n').map((t, i) => (
          <p key={`r${i}`}>{t}</p>
        ))}
        <div className={styles.reportHead}>二、存在问题与工作不足</div>
        {report.sections.problems.split('\n').map((t, i) => (
          <p key={`p${i}`}>{t}</p>
        ))}
        <div className={styles.reportHead}>三、下一年度工作展望</div>
        {report.sections.outlook.split('\n').map((t, i) => (
          <p key={`o${i}`}>{t}</p>
        ))}
      </div>
    </div>
  );
}
