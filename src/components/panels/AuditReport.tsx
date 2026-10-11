/**
 * AuditReport —— 烂尾工程专项审计报告（TASK-17，只读）。
 *
 * 公文风大弹窗（复用 document.module.css 外壳 + auditReport.module.css 补充）。
 * 五段结构：
 *   一、项目基本情况      —— 本地真实台账（buildAuditFacts）
 *   二、施工及停工事实    —— 本地真实台账（含最近施工备案）
 *   三、项目沉没投入与情绪发票 —— 本地真实台账（buildEmotionalInvoice）
 *   四、烂尾原因分析      —— AI 判断（report.background + report.stopReasons）
 *   五、审计意见          —— AI 判断（completionEstimate 估算 + conclusion 建议）
 *
 * 严格边界：
 * - 一/二/三 全部由真实 Project/ProgressRecord 确定性计算，标注为"真实台账"。
 * - 四/五 为审计判断（AI/mock），completionEstimate 明示为"审计估算"，非真实进度。
 * - conclusion 仅以文字呈现"审计建议：…"，**不渲染任何可执行治理按钮**（复工/降规/爆破属 TASK-18）。
 * - 底部只有"关闭"。
 */
import { useMemo } from 'react';
import type { AuditReport as AuditReportData, AuditConclusion, Project } from '@/store/types';
import { buildAuditFacts, buildEmotionalInvoice } from '@/logic/auditFacts';
import docStyles from './document.module.css';
import styles from './auditReport.module.css';

export interface AuditReportProps {
  open: boolean;
  cityName: string;
  project: Project | null;
  report: AuditReportData | null;
  onClose: () => void;
}

/** conclusion → 只读审计建议文案（不是可执行动作） */
const CONCLUSION_LABEL: Record<AuditConclusion, string> = {
  restart: '建议复工',
  downgrade: '建议调整建设规模',
  demolish: '建议爆破销项',
};

function fmtGeneratedAt(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function AuditReport({ open, cityName, project, report, onClose }: AuditReportProps) {
  const now = Date.now();
  const facts = useMemo(() => (project ? buildAuditFacts(project, now) : null), [project, now]);
  const invoice = useMemo(() => (project ? buildEmotionalInvoice(project, now) : null), [project, now]);

  if (!open || !project || !report || !facts || !invoice) return null;

  const est = Math.max(0, Math.min(99, Math.round(report.completionEstimate)));

  return (
    <div className={docStyles.docOverlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={docStyles.docPaper} role="dialog" aria-modal="true" aria-label="烂尾工程专项审计报告">
        <div className={docStyles.docInner}>
          {/* 页眉 */}
          <div className={docStyles.docOrg}>
            {cityName}人生建设管理局
          </div>
          <div className={docStyles.docRule} />
          <div className={docStyles.docDocNo}>
            烂审〔{new Date(report.generatedAt).getFullYear()}〕第 {project.id} 号
          </div>
          <div className={docStyles.docTitle}>烂尾工程专项审计报告</div>

          {/* 一、项目基本情况（真实台账） */}
          <div className={styles.sectionHead}>一、项目基本情况</div>
          <div className={styles.factNote}>（以下为项目真实建设台账，可核验）</div>
          <div className={styles.factGrid}>
            <span className={styles.factLabel}>项目名称</span>
            <span className={styles.factValue}>{project.name}</span>
            <span className={styles.factLabel}>项目编号</span>
            <span className={styles.factValue}>{project.id}</span>
            <span className={styles.factLabel}>项目类型</span>
            <span className={styles.factValue}>{project.type}</span>
            <span className={styles.factLabel}>建设目标</span>
            <span className={styles.factValue}>{facts.goal}</span>
            <span className={styles.factLabel}>立项时间</span>
            <span className={styles.factValue}>{facts.createdAtText}</span>
            {facts.plannedDuration && (
              <>
                <span className={styles.factLabel}>原计划周期</span>
                <span className={styles.factValue}>{facts.plannedDuration}</span>
              </>
            )}
            <span className={styles.factLabel}>施工频率</span>
            <span className={styles.factValue}>
              {facts.frequencyLabel}
              {facts.scheduleText ? `（${facts.scheduleText}）` : ''}
            </span>
          </div>

          {/* 二、施工及停工事实（真实台账） */}
          <div className={styles.sectionHead}>二、施工及停工事实</div>
          <div className={styles.factNote}>（以下为项目真实施工台账，可核验）</div>
          <div className={styles.factGrid}>
            <span className={styles.factLabel}>实际施工备案</span>
            <span className={styles.factValue}>{facts.progressCount} 次</span>
            <span className={styles.factLabel}>最近施工时间</span>
            <span className={styles.factValue}>{facts.lastProgressText}</span>
            <span className={styles.factLabel}>连续未施工</span>
            <span className={styles.factValue}>{facts.idleDays} 天</span>
            <span className={styles.factLabel}>项目已存续</span>
            <span className={styles.factValue}>{facts.ageDays} 天</span>
            <span className={styles.factLabel}>正式复工次数</span>
            <span className={styles.factValue}>{facts.restartCount} 次</span>
            {facts.abandonedAtText && (
              <>
                <span className={styles.factLabel}>认定烂尾时间</span>
                <span className={styles.factValue}>{facts.abandonedAtText}</span>
              </>
            )}
          </div>
          <div className={styles.factTags}>
            {facts.everWarned && <span className={styles.factTag}>曾进入施工预警</span>}
            {facts.everHalted && <span className={styles.factTag}>曾进入停工</span>}
            <span className={styles.factTag}>现为烂尾状态</span>
          </div>

          <div className={styles.recordList}>
            {facts.recentRecords.length === 0 ? (
              <div className={styles.recordEmpty}>自立项以来无任何施工备案记录。</div>
            ) : (
              facts.recentRecords.map((r, i) => (
                <div key={i} className={styles.recordRow}>
                  <span className={styles.recordDate}>{r.dateLabel}</span>
                  <span className={styles.recordNote}>
                    {r.note}
                    {r.isDemo && <span className={styles.recordDemoTag}>[演示数据]</span>}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* 三、项目沉没投入与情绪发票（真实台账 + 定性意见） */}
          <div className={styles.sectionHead}>三、项目沉没投入与情绪发票</div>
          <div className={styles.invoice}>
            <div className={styles.invoiceHead}>项目沉没投入与情绪发票</div>
            {invoice.lines.map((l) => (
              <div key={l.label} className={styles.invoiceLine}>
                <span className={styles.invoiceKey}>{l.label}</span>
                <span className={styles.invoiceVal}>{l.value}</span>
              </div>
            ))}
            <div className={styles.invoiceVerdict}>{invoice.verdict}</div>
          </div>

          {/* 四、烂尾原因分析（AI 判断） */}
          <div className={styles.sectionHead}>四、烂尾原因分析</div>
          <div className={docStyles.docBody}>
            <p>{report.background}</p>
            <p>{report.stopReasons}</p>
          </div>

          {/* 五、审计意见（AI 判断：估算完成度 + 建议） */}
          <div className={styles.sectionHead}>五、审计意见</div>
          <div className={styles.estimateWrap}>
            <div className={styles.estimateLabel}>
              审计估算完成度：<b>{est}%</b>
            </div>
            <div className={styles.estimateBarTrack}>
              <div className={styles.estimateBarFill} style={{ width: `${est}%` }} />
            </div>
            <div className={styles.estimateHint}>
              注：该比例为审计模型研判估算，非真实施工进度台账。
            </div>
          </div>

          <div className={styles.conclusionBox}>
            <div className={styles.conclusionTitle}>审计建议：{CONCLUSION_LABEL[report.conclusion]}</div>
            <div className={styles.conclusionReason}>{report.conclusionReason}</div>
            <div className={styles.conclusionFoot}>
              本报告仅为审计意见，不代表已执行任何处置。相关治理措施需由市长在专项治理程序中另行决定。
            </div>
          </div>

          {/* 像素红色公章 */}
          <div className={docStyles.docSeal}>
            {cityName}
            <br />
            人生建设
            <br />
            管理局
          </div>

          {/* 落款 */}
          <div className={docStyles.docSign}>
            {cityName}人生建设管理局
            <br />
            <span className={docStyles.docSignDate}>{fmtGeneratedAt(report.generatedAt)}</span>
          </div>
        </div>

        {/* 底部仅"关闭"；无任何治理按钮（复工/降规/爆破属 TASK-18） */}
        <div className={docStyles.docActions}>
          <button className={docStyles.docBtn} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
