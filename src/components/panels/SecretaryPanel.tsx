/**
 * SecretaryPanel —— 市长办公室 / AI 秘书面板（TASK-16）。
 *
 * 定位：市长办公室内部工作台，不是 ChatGPT。
 * 结构（上→下）：
 *   1. 今日简报（本地确定性计算，打开即显示，无需任何 AI 请求）
 *   2. 请示 / 回复 往来记录（非聊天气泡）
 *   3. 快捷提问 + 请示录入框
 *
 * AI 调用：仅市长主动提交问题时调用 aiClient.chat，一次问题最多一次请求。
 * 未发送问题时：零 AI 请求。
 * Demo / 无 Key / 失败：aiClient 内部已降级为 secretaryMockReply（基于真实 GameState），不白屏、不崩。
 *
 * 对话窗口：仅保留本次打开期间最近约 10 条消息；不写入持久化 Store（不做长期聊天记忆）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';
import { aiClient } from '@/ai/aiClient';
import {
  buildSecretaryContext,
  statusLabel,
  type PriorityProject,
} from '@/logic/secretaryContext';
import type { Message, ProjectStatus } from '@/store/types';
import styles from './secretary.module.css';

/** 本次会话保留的最大消息条数（市长 + 秘书合计），超出丢弃最早的 */
const WINDOW = 10;

const LOADING_TEXT = 'AI秘书正在查阅项目台账……';

const FOCUS_BADGE_CLASS: Partial<Record<ProjectStatus, string>> = {
  abandoned: styles.badgeAbandoned,
  halted: styles.badgeHalted,
  warning: styles.badgeWarning,
};

const QUICK_QUESTIONS = [
  '现在城市建设情况怎么样？',
  '哪些项目需要我优先处理？',
  '哪些项目已经完成了？',
  '按现在的施政方针，我应该先做什么？',
];

let seq = 0;
function nextId(): string {
  seq += 1;
  return `sec_${Date.now()}_${seq}`;
}

function Brief({
  cityName,
  counts,
  policyTitle,
  policyDescription,
  priority,
}: {
  cityName: string;
  counts: { label: string; n: number; cls: string }[];
  policyTitle: string | null;
  policyDescription: string | null;
  priority: PriorityProject[];
}) {
  return (
    <div className={styles.brief}>
      <div className={styles.briefTitle}>今日简报 · {cityName}城市建设情况</div>

      <div className={styles.counts}>
        {counts.map((c) => (
          <div key={c.label} className={styles.countCell}>
            <div className={`${styles.countNum} ${c.cls}`}>{c.n}</div>
            <div className={styles.countLabel}>{c.label}</div>
          </div>
        ))}
      </div>

      <div className={styles.policyRow}>
        当前施政方针：
        {policyTitle ? (
          <>
            <span className={styles.policyName}>「{policyTitle}」</span>
            {policyDescription ? ` ${policyDescription}` : ''}
          </>
        ) : (
          '暂未选定'
        )}
      </div>

      <div className={styles.focusTitle}>当前需重点关注：</div>
      {priority.length === 0 ? (
        <div className={styles.focusEmpty}>各项目推进总体平稳，暂无需紧急处置的存量工程。</div>
      ) : (
        priority.map((p) => (
          <div key={p.id} className={styles.focusItem}>
            <span className={`${styles.focusBadge} ${FOCUS_BADGE_CLASS[p.status] ?? ''}`}>
              {statusLabel(p.status)}
            </span>
            <span>
              「{p.name}」{p.reason}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export default function SecretaryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cityName = useGameStore((s) => s.cityName);
  const currentYear = useGameStore((s) => s.currentYear);
  const currentPolicy = useGameStore((s) => s.currentPolicy);
  const projects = useGameStore((s) => s.projects);
  const feedbacks = useGameStore((s) => s.feedbacks);
  const announcements = useGameStore((s) => s.announcements);

  // 本次会话对话窗口（不写持久化）
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 实时构造秘书事实上下文（打开期间随 Store 变化刷新）
  const ctx = useMemo(
    () =>
      buildSecretaryContext({
        cityName,
        currentYear,
        currentPolicy,
        projects,
        feedbacks,
        announcements,
      }),
    [cityName, currentYear, currentPolicy, projects, feedbacks, announcements],
  );

  const counts = useMemo(
    () => [
      { label: '在建', n: ctx.brief.construction, cls: styles.dotConstruction },
      { label: '施工预警', n: ctx.brief.warning, cls: styles.dotWarning },
      { label: '停工', n: ctx.brief.halted, cls: styles.dotHalted },
      { label: '烂尾', n: ctx.brief.abandoned, cls: styles.dotAbandoned },
      { label: '已竣工', n: ctx.brief.completed, cls: styles.dotCompleted },
      { label: '项目总数', n: ctx.brief.total, cls: '' },
    ],
    [ctx.brief],
  );

  // 滚动到底部（新消息 / 加载态出现时）
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  if (!open) return null;

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setDraft('');

    const mayorMsg: Message = { id: nextId(), role: 'mayor', content: q, createdAt: Date.now() };
    // 追加市长消息并裁剪窗口
    const afterMayor = [...messages, mayorMsg].slice(-WINDOW);
    setMessages(afterMayor);
    setLoading(true);

    let reply: string;
    try {
      // 仅发送非 system 的往来消息；事实块由 aiClient 内部注入
      reply = await aiClient.chat(afterMayor, ctx);
    } catch {
      // aiClient 内部已降级；此处为极端兜底，绝不把异常堆栈抛给市长
      reply = '市长，当前智能秘书服务暂不可用，已根据本地项目台账为您提供基础信息。';
    }

    const secMsg: Message = {
      id: nextId(),
      role: 'secretary',
      content: reply,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, secMsg].slice(-WINDOW));
    setLoading(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="市长办公室">
        <div className={styles.titleBar}>
          <div className={styles.titleWrap}>
            <span className={styles.titleMain}>市长办公室</span>
            <span className={styles.titleSub}>AI 秘书 · 城市建设内部工作台</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            X
          </button>
        </div>

        <div className={styles.body} ref={bodyRef}>
          <Brief
            cityName={cityName}
            counts={counts}
            policyTitle={ctx.brief.policyTitle}
            policyDescription={ctx.brief.policyDescription}
            priority={ctx.brief.priority}
          />

          <div className={styles.divider} />

          <div className={styles.record}>
            {messages.length === 0 && !loading && (
              <div className={styles.recordHint}>
                市长可就城市建设情况、具体工程进展或治理方向向 AI 秘书提出询问。
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={styles.turn}>
                <div
                  className={`${styles.turnRole} ${m.role === 'mayor' ? styles.roleMayor : styles.roleSecretary}`}
                >
                  {m.role === 'mayor' ? '市长：' : 'AI秘书：'}
                </div>
                <div className={styles.turnText}>{m.content}</div>
              </div>
            ))}
            {loading && <div className={styles.loading}>{LOADING_TEXT}</div>}
          </div>
        </div>

        <div className={styles.quickRow}>
          {QUICK_QUESTIONS.map((qq) => (
            <button
              key={qq}
              className={styles.quickBtn}
              disabled={loading}
              onClick={() => void send(qq)}
            >
              {qq}
            </button>
          ))}
        </div>

        <div className={styles.inputBar}>
          <textarea
            className={styles.input}
            rows={2}
            placeholder="向 AI 秘书询问……"
            value={draft}
            disabled={loading}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="向 AI 秘书询问"
          />
          <button
            className={styles.sendBtn}
            disabled={loading || !draft.trim()}
            onClick={() => void send(draft)}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
