/**
 * AI 客户端抽象层（src/ai/aiClient.ts）
 *
 * 依据 design.md 第 6 节 + engineering-conventions：
 * - 全项目唯一发起 LLM 请求的模块；其它模块只调用这里的方法，不自行 fetch。
 * - 不读写 Zustand；运行所需配置（apiKey / cityName / 当前方针等）由调用方经 init / 参数传入。
 * - Demo/Mock 模式与真实模式对外接口签名完全一致（走同一 UI 流程）。
 * - 每个方法都有降级方案：超时 / 网络失败 / JSON 解析失败 → 返回 mock 兜底，不抛错中断演示。
 *
 * 配置：OpenAI Chat Completions 兼容接口。apiKey 为空视为 Demo 模式。
 */

import type {
  AnnualPolicy,
  AnnualReportStats,
  AuditReport,
  CitizenFeedback,
  FieldSource,
  Message,
  Project,
  ProjectDraft,
  ProjectType,
  BuildingType,
  ProgressFrequency,
} from '@/store/types';
import type { SecretaryContext } from '@/logic/secretaryContext';
import {
  auditPrompt,
  formalizeProgressPrompt,
  nextPolicyPrompt,
  projectCreationPrompt,
  projectDowngradePrompt,
  reportPolishPrompt,
  secretaryPrompt,
  secretaryFactsBlock,
  PROJECT_TYPES,
} from './prompts';
import {
  annualReportMock,
  downgradeDraftMock,
  MOCK_INITIAL_POLICIES,
  MOCK_NEXT_POLICIES,
  pickAuditMock,
  pickProjectDraftMock,
} from './mockData';
import { secretaryMockReply } from './secretaryMock';
import { buildDraftFromSemantics } from './semantics';

/* ============================================================
 * 配置与常量
 * ============================================================ */

/**
 * 前端只请求同域 serverless 代理 /api/ai（服务端持有 provider 密钥）。
 * 浏览器永不接触 API Key / provider secret。
 */
const AI_PROXY_ENDPOINT = '/api/ai';
// 前端超时需 > 服务端 provider 超时(75s)，让推理型模型有足够时间返回结构化结果。
// 超时后仍会走 deterministic fallback，但正常复杂 Prompt 不应因短硬截止被误判失败。
const TIMEOUT_MS = 85000;
const MOCK_DELAY_MS = 800;

interface AIConfig {
  /**
   * 显式强制 Mock 开关：仅开发/比赛应急（?mock=1 / DEV）置 true。
   * production 正常路径默认 false → 真实 AI 优先，失败再 deterministic fallback。
   * 不再依据 apiKey 是否为空推断（前端本就不应持有 key）。
   */
  forceMock: boolean;
  cityName: string;
}

const config: AIConfig = {
  forceMock: false,
  cityName: '梦想市',
};

/**
 * 是否走 Mock（而非真实 /api/ai 请求）。
 * 仅当显式 forceMock 时为 true；否则一律真实 AI 优先（失败由各方法 catch 走 fallback）。
 */
function shouldUseMock(): boolean {
  return config.forceMock;
}

/* ============================================================
 * 工具
 * ============================================================ */

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const VALID_BUILDING: BuildingType[] = ['tower', 'flat', 'dome', 'industrial', 'park'];
const VALID_FREQ: ProgressFrequency[] = ['daily', 'several-times-weekly', 'weekly', 'long-term'];

/** 年报评论段的事实上下文；统计数字仍由 reportBuilder 负责拼入正文。 */
export interface ReportCommentaryContext {
  policy?: AnnualPolicy | null;
  completedProjectNames?: string[];
  troubledProjectNames?: string[];
  demolishedProjectNames?: string[];
  feedbackSummary?: string[];
}

/** 从模型文本中稳健提取 JSON（容忍包裹的 markdown / 前后噪声） */
function parseJsonLoose<T>(text: string): T {
  let s = text.trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 截取首个 { 或 [ 到最后一个 } 或 ]
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const start =
    firstArr !== -1 && (firstArr < firstObj || firstObj === -1) ? firstArr : firstObj;
  if (start > 0) s = s.slice(start);
  const lastObj = s.lastIndexOf('}');
  const lastArr = s.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (end !== -1 && end < s.length - 1) s = s.slice(0, end + 1);
  return JSON.parse(s) as T;
}

type WireMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * 统一向同域 serverless 代理 /api/ai 发一次请求，返回模型文本。
 * 85s 前端超时；非 2xx / 空内容 / 超时均抛错（由各上层方法 catch 后走 deterministic fallback）。
 * 前端不传 model / apiKey / baseUrl —— 由服务端环境变量决定。
 */
async function callAi(
  messages: WireMessage[],
  opts?: { responseFormat?: 'text' | 'json'; temperature?: number; maxTokens?: number },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(AI_PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        responseFormat: opts?.responseFormat,
        temperature: opts?.temperature ?? 0.8,
        maxTokens: opts?.maxTokens,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`AI proxy HTTP ${resp.status}`);
    const data = (await resp.json()) as { content?: string };
    const content = data?.content;
    if (!content || !content.trim()) throw new Error('AI empty content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单轮（system + user）。JSON 类接口传 responseFormat:'json'（服务端映射 response_format）。
 * 失败抛错（由各方法 catch 后走降级）。
 */
async function chatCompletion(
  system: string,
  user: string,
  responseFormat: 'text' | 'json' = 'text',
  temperature = 0.8,
): Promise<string> {
  return callAi(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { responseFormat, temperature },
  );
}

/** 多轮对话版（秘书用，带历史 messages） */
async function chatCompletionWithHistory(system: string, history: Message[], temperature = 0.8): Promise<string> {
  const msgs: WireMessage[] = [
    { role: 'system', content: system },
    ...history.map(
      (m): WireMessage => ({
        role: m.role === 'mayor' ? 'user' : m.role === 'secretary' ? 'assistant' : 'system',
        content: m.content,
      }),
    ),
  ];
  return callAi(msgs, { temperature });
}

/* ============================================================
 * 校验/规整：把模型输出修正为合法枚举，避免脏数据进 store
 * ============================================================ */

const str = (v: unknown, fb: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fb;

const asSource = (v: unknown, fb: FieldSource): FieldSource =>
  v === 'user' || v === 'suggested' ? v : fb;

function textValue(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(textValue).filter(Boolean).join('；');
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([key, value]) => `${key}：${textValue(value)}`)
      .filter((line) => !line.endsWith('：'))
      .join('；');
  }
  return '';
}

function normalizeProjectType(value: unknown, fallback: ProjectType): ProjectType {
  if ((PROJECT_TYPES as string[]).includes(value as string)) return value as ProjectType;
  const text = typeof value === 'string' ? value : '';
  const aliases: Array<[RegExp, ProjectType]> = [
    [/民生|公共服务|社会服务/, '民生工程'],
    [/文化|文旅/, '文化工程'],
    [/基础设施|市政|交通/, '基础设施'],
    [/经济|产业|开发区/, '经济开发'],
    [/教育|培训|学校/, '教育工程'],
    [/生态|环保|绿化/, '生态工程'],
    [/治理|政务|社区服务/, '社会治理'],
  ];
  return aliases.find(([pattern]) => pattern.test(text))?.[1] ?? fallback;
}

function normalizeBuildingType(value: unknown, fallback: BuildingType): BuildingType {
  if (VALID_BUILDING.includes(value as BuildingType)) return value as BuildingType;
  const text = typeof value === 'string' ? value : '';
  if (/塔|高层/.test(text)) return 'tower';
  if (/平房|低层|板楼/.test(text)) return 'flat';
  if (/穹顶|体育馆|展馆/.test(text)) return 'dome';
  if (/工业|厂房|园区/.test(text)) return 'industrial';
  if (/公园|绿地|生态/.test(text)) return 'park';
  return fallback;
}

function normalizeProgressFrequency(value: unknown, fallback: ProgressFrequency): ProgressFrequency {
  if (VALID_FREQ.includes(value as ProgressFrequency)) return value as ProgressFrequency;
  const text = typeof value === 'string' ? value : '';
  if (/每天|每日|日度/.test(text)) return 'daily';
  if (/每周[2-9]|每周多次|周度/.test(text)) return 'several-times-weekly';
  if (/每周|每月|月度|按月/.test(text)) return 'weekly';
  if (/长期|持续|阶段性|季度/.test(text)) return 'long-term';
  return fallback;
}

/**
 * 规整立项草案：把模型输出修正为合法结构，缺失/非法字段回退到 fallback（语义解析结果）。
 * fallback 本身由 buildDraftFromSemantics 产生，保证即便模型只回半截也有合理兜底。
 */
function sanitizeDraft(raw: Partial<ProjectDraft> | undefined, fallback: ProjectDraft): ProjectDraft {
  if (!raw || typeof raw !== 'object') return fallback;

  const type = normalizeProjectType(raw.type, fallback.type);
  const buildingType = normalizeBuildingType(raw.buildingType, fallback.buildingType);
  const progressFrequency = normalizeProgressFrequency(raw.progressFrequency, fallback.progressFrequency);

  // sections：数组且元素含 title/content 才采用，否则用 fallback 的
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const sections = rawSections
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const item = s as { title?: unknown; name?: unknown; content?: unknown };
      return { title: textValue(item.title ?? item.name), content: textValue(item.content) };
    })
    .filter((s) => s.title && s.content)
    .slice(0, 5);

  const rawMeta = (raw.meta ?? {}) as Partial<ProjectDraft['meta']>;

  return {
    name: str(raw.name, fallback.name),
    type,
    buildingType,
    progressFrequency,
    approvalNote: str(raw.approvalNote, fallback.approvalNote),
    goal: str(raw.goal, fallback.goal),
    acceptanceCriteria: textValue(raw.acceptanceCriteria) || fallback.acceptanceCriteria,
    duration: str(raw.duration, fallback.duration ?? ''),
    progressScheduleText: str(raw.progressScheduleText, fallback.progressScheduleText ?? ''),
    scale: textValue(raw.scale) || fallback.scale,
    sections: sections.length >= 1 ? sections : fallback.sections,
    meta: {
      duration: asSource(rawMeta.duration, fallback.meta.duration),
      progressFrequency: asSource(rawMeta.progressFrequency, fallback.meta.progressFrequency),
      goalNumbers: asSource(rawMeta.goalNumbers, fallback.meta.goalNumbers),
    },
  };
}

function sanitizeAudit(raw: Partial<AuditReport> | undefined): AuditReport {
  const fallback = pickAuditMock();
  if (!raw || typeof raw !== 'object') return fallback;
  const conclusion =
    raw.conclusion === 'restart' || raw.conclusion === 'downgrade' || raw.conclusion === 'demolish'
      ? raw.conclusion
      : fallback.conclusion;
  let est = typeof raw.completionEstimate === 'number' ? Math.round(raw.completionEstimate) : fallback.completionEstimate;
  est = Math.max(0, Math.min(99, est));
  return {
    generatedAt: Date.now(),
    background: typeof raw.background === 'string' ? raw.background : fallback.background,
    stopReasons: typeof raw.stopReasons === 'string' ? raw.stopReasons : fallback.stopReasons,
    completionEstimate: est,
    conclusion,
    conclusionReason:
      typeof raw.conclusionReason === 'string' ? raw.conclusionReason : fallback.conclusionReason,
  };
}

/* ============================================================
 * 公共 API
 * ============================================================ */

/** DEV-only source logger — production UI 不可见（import.meta.env.DEV 在生产为 false，被 tree-shake） */
function logSrc(fn: string, source: 'real' | 'fallback'): void {
  if (import.meta.env.DEV) console.log(`%c[AI source] ${fn} = ${source}`, source === 'real' ? 'color:#0a0' : 'color:#e17055');
}

export const aiClient = {
  /**
   * 初始化配置。
   * - cityName：供 Prompt 上下文。
   * - forceMock：显式强制 Mock（?mock=1 / DEV 应急）；不传则默认真实 AI 优先。
   * 兼容旧签名：仍接受 isDemoMode（映射到 forceMock）；apiKey/endpoint/model 已废弃并忽略
   * （前端不再持有密钥，provider 配置在服务端环境变量）。
   */
  init(opts: {
    forceMock?: boolean;
    cityName?: string;
    /** @deprecated 前端不再据此判断模式；保留以兼容旧调用，仅映射到 forceMock */
    isDemoMode?: boolean;
    /** @deprecated 已忽略（服务端环境变量决定） */
    apiKey?: string;
    /** @deprecated 已忽略 */
    endpoint?: string;
    /** @deprecated 已忽略 */
    model?: string;
  }): void {
    if (opts.cityName !== undefined) config.cityName = opts.cityName;
    if (opts.forceMock !== undefined) config.forceMock = opts.forceMock;
    else if (opts.isDemoMode !== undefined) config.forceMock = opts.isDemoMode;
  },

  /** 当前是否会走 Mock（仅 forceMock 显式开启时为 true） */
  isDemoMode(): boolean {
    return shouldUseMock();
  },

  /**
   * 立项：生成项目档案（含 progressFrequency 建议）。
   * 单一入口；可选 context 注入当年施政方针与城市名等上下文：
   * - currentPolicy 仅影响 Prompt 上下文与批复中的风险提示，不产生第二套逻辑；
   * - cityName 传入时覆盖本次调用使用的城市名。
   */
  async createProject(
    input: string,
    year: number,
    counter: number,
    context?: { currentPolicy?: AnnualPolicy | null; cityName?: string; existingProjects?: Project[] },
  ): Promise<ProjectDraft> {
    const fallback = pickProjectDraftMock(input);
    if (shouldUseMock()) {
      logSrc('createProject', 'fallback');
      await delay(MOCK_DELAY_MS);
      return fallback;
    }
    try {
      const { system, user } = projectCreationPrompt({
        cityName: context?.cityName ?? config.cityName,
        year,
        counter,
        policyTitle: context?.currentPolicy?.title ?? null,
        policyDescription: context?.currentPolicy?.description ?? null,
        userInput: input,
        existingProjects: context?.existingProjects,
      });
      const text = await chatCompletion(system, user, 'json', 0.6);
      logSrc('createProject', 'real');
      return sanitizeDraft(parseJsonLoose<Partial<ProjectDraft>>(text), fallback);
    } catch (e) {
      console.error('[aiClient.createProject] 降级：', e);
      logSrc('createProject', 'fallback');
      return buildDraftFromSemantics(input);
    }
  },

  /** 审计：生成烂尾项目审计报告 */
  async auditProject(project: Project): Promise<AuditReport> {
    if (shouldUseMock()) {
      logSrc('auditProject', 'fallback');
      await delay(MOCK_DELAY_MS);
      return pickAuditMock();
    }
    try {
      const stalledDays = Math.max(0, Math.round((Date.now() - project.lastProgressAt) / 86_400_000));
      const { system, user } = auditPrompt({ cityName: config.cityName, project, stalledDays });
      const text = await chatCompletion(system, user, 'json', 0.35);
      logSrc('auditProject', 'real');
      return sanitizeAudit(parseJsonLoose<Partial<AuditReport>>(text));
    } catch (e) {
      console.error('[aiClient.auditProject] 降级：', e);
      logSrc('auditProject', 'fallback');
      return pickAuditMock();
    }
  },

  /** 降级：根据新描述重新生成缩减版项目档案 */
  async downgradeProject(project: Project, newInput: string): Promise<ProjectDraft> {
    const fallback = downgradeDraftMock(newInput);
    if (shouldUseMock()) {
      logSrc('downgradeProject', 'fallback');
      await delay(MOCK_DELAY_MS);
      return fallback;
    }
    try {
      const { system, user } = projectDowngradePrompt({ cityName: config.cityName, project, newInput });
      const text = await chatCompletion(system, user, 'json', 0.5);
      logSrc('downgradeProject', 'real');
      return sanitizeDraft(parseJsonLoose<Partial<ProjectDraft>>(text), fallback);
    } catch (e) {
      console.error('[aiClient.downgradeProject] 降级：', e);
      logSrc('downgradeProject', 'fallback');
      return fallback;
    }
  },

  /**
   * 市长办公室 AI 秘书对话（TASK-16）。
   * 以本地计算的 SecretaryContext 为事实边界：System Prompt 约束 + 台账事实块随对话发送。
   * - Mock / 无 Key / 失败降级：用 secretaryMockReply 基于真实 GameState 确定性作答（非"模拟回答"占位）。
   * - 真实 AI：仅在市长主动提交问题时由上层调用，一次问题最多一次请求。
   */
  async chat(messages: Message[], ctx: SecretaryContext): Promise<string> {
    // 取最新一条市长问题，供 Mock 意图识别使用
    const lastMayor = [...messages].reverse().find((m) => m.role === 'mayor');
    const question = lastMayor?.content ?? '';

    if (shouldUseMock()) {
      logSrc('chat', 'fallback');
      await delay(MOCK_DELAY_MS);
      return secretaryMockReply(ctx, question);
    }
    try {
      const system = secretaryPrompt();
      const facts = secretaryFactsBlock(ctx);
      const withFacts: Message[] = [
        { id: 'facts', role: 'system', content: facts, createdAt: Date.now() },
        ...messages,
      ];
      const reply = await chatCompletionWithHistory(system, withFacts, 0.6);
      logSrc('chat', 'real');
      return reply;
    } catch (e) {
      console.error('[aiClient.chat] 降级：', e);
      logSrc('chat', 'fallback');
      return secretaryMockReply(ctx, question);
    }
  },

  /** 年报单段润色（失败则原样返回模板，保证数字/结构不丢） */
  async polishReportSection(
    template: string,
    data: AnnualReportStats,
    projectNames: string[],
    context?: ReportCommentaryContext,
  ): Promise<string> {
    if (shouldUseMock()) {
      logSrc('polishReportSection', 'fallback');
      await delay(MOCK_DELAY_MS / 2);
      return template;
    }
    try {
      const { system, user } = reportPolishPrompt({
        cityName: config.cityName,
        template,
        stats: data,
        projectNames,
        policy: context?.policy ?? null,
        completedProjectNames: context?.completedProjectNames ?? projectNames,
        troubledProjectNames: context?.troubledProjectNames ?? [],
        demolishedProjectNames: context?.demolishedProjectNames ?? [],
        feedbackSummary: context?.feedbackSummary ?? [],
      });
      const text = await chatCompletion(system, user, 'text', 0.65);
      logSrc('polishReportSection', 'real');
      return text.trim() || template;
    } catch (e) {
      console.error('[aiClient.polishReportSection] 降级：', e);
      logSrc('polishReportSection', 'fallback');
      return template;
    }
  },

  /** 施政方针候选：固定返回 3 条；policyHistory 用于去重（避免每年相同候选） */
  async generateNextPolicyCandidates(
    stats: AnnualReportStats,
    projects: Project[],
    currentPolicy: AnnualPolicy,
    policyHistory?: AnnualPolicy[],
    feedbacks?: CitizenFeedback[],
  ): Promise<AnnualPolicy[]> {
    const year = stats.year + 1;
    const toPolicies = (cands: Array<{ title: string; description: string }>): AnnualPolicy[] =>
      cands.slice(0, 3).map((c) => ({
        year,
        title: c.title,
        description: c.description,
        source: 'secretary-generated',
      }));

    const historyTitles = new Set((policyHistory ?? []).map((p) => p.title.trim()));
    const fallbackPool =
      stats.abandoned >= 2 || stats.completionRate < 40
        ? [
            { title: '少开新工、集中清欠', description: '控制新增建设节奏，优先处理长期停滞和烂尾项目。' },
            { title: '严控立项、优先竣工', description: '把有限推进能力集中到已开工项目，减少新增未完工程。' },
            { title: '盘活存量、分类治理', description: '按项目完成度和停滞原因分类推进复工、降级或销项。' },
          ]
        : stats.completionRate >= 70 && stats.abandoned === 0
          ? [
              { title: '稳中扩建、提质增效', description: '在既有成果基础上审慎扩大建设规模，并提高项目质量。' },
              { title: '巩固成果、适度开新', description: '优先维护已形成的建设成果，按实际能力安排新增项目。' },
              { title: '强化验收、持续运营', description: '完善竣工验收和后续使用安排，避免建成项目闲置。' },
            ]
          : [
              { title: '量力推进、确保竣工', description: '依据实际推进能力安排项目，优先保证在建工程按期收尾。' },
              { title: '精简立项、聚焦深耕', description: '减少重复和分散建设，把资源集中到少数重点目标。' },
              { title: '审慎开工、动态调整', description: '根据施工记录及时调整规模和节奏，降低项目停滞风险。' },
            ];
    const fallbackCandidates = [...fallbackPool, ...MOCK_NEXT_POLICIES]
      .filter((p, index, all) => all.findIndex((x) => x.title === p.title) === index)
      .filter((p) => !historyTitles.has(p.title));
    let suffix = 1;
    while (fallbackCandidates.length < 3) {
      const title = `年度治理方向${suffix}`;
      suffix += 1;
      if (historyTitles.has(title) || fallbackCandidates.some((p) => p.title === title)) continue;
      fallbackCandidates.push({
        title,
        description: '结合本年度项目台账动态安排建设重点，并避免重复既有施政方针。',
      });
    }

    if (shouldUseMock()) {
      logSrc('generateNextPolicyCandidates', 'fallback');
      await delay(MOCK_DELAY_MS);
      return toPolicies(fallbackCandidates);
    }
    try {
      const freq = { daily: 0, weeklyMulti: 0, weekly: 0, longTerm: 0 };
      for (const p of projects) {
        if (p.progressFrequency === 'daily') freq.daily += 1;
        else if (p.progressFrequency === 'several-times-weekly') freq.weeklyMulti += 1;
        else if (p.progressFrequency === 'weekly') freq.weekly += 1;
        else freq.longTerm += 1;
      }
      const { system, user } = nextPolicyPrompt({
        cityName: config.cityName,
        stats,
        currentPolicy,
        freq,
        projects,
        policyHistory: policyHistory ?? [],
        feedbacks: feedbacks ?? [],
      });
      const text = await chatCompletion(system, user, 'json', 0.75);
      const raw = parseJsonLoose<Array<{ title?: string; description?: string }>>(text);
      // 去重：过滤掉与历史方针标题完全相同的候选
      const seenTitles = new Set<string>();
      const cleaned = (Array.isArray(raw) ? raw : [])
        .filter((c) => c && typeof c.title === 'string' && c.title.trim())
        .map((c) => ({ title: (c.title as string).trim(), description: (c.description ?? '').toString().trim() }))
        .filter((c) => c.description.length > 0)
        .filter((c) => !historyTitles.has(c.title) && !seenTitles.has(c.title))
        .filter((c) => {
          seenTitles.add(c.title);
          return true;
        });
      logSrc('generateNextPolicyCandidates', cleaned.length >= 3 ? 'real' : 'fallback');
      return cleaned.length >= 3 ? toPolicies(cleaned) : toPolicies(fallbackCandidates);
    } catch (e) {
      console.error('[aiClient.generateNextPolicyCandidates] 降级：', e);
      logSrc('generateNextPolicyCandidates', 'fallback');
      return toPolicies(fallbackCandidates);
    }
  },

  /**
   * 初始建城方针候选（恰 3 条）。真实 AI 优先；超时/失败/解析异常 → fallback 固定 3 条。
   * 建城阶段不得因等待模型阻塞流程：失败即回退，UI 照常三选一。
   */
  async generateInitialPolicyCandidates(year: number): Promise<AnnualPolicy[]> {
    const fallback = (): AnnualPolicy[] =>
      MOCK_INITIAL_POLICIES.slice(0, 3).map((c) => ({
        year,
        title: c.title,
        description: c.description,
        source: 'initial' as const,
      }));

    if (shouldUseMock()) {
      await delay(MOCK_DELAY_MS);
      return fallback();
    }
    try {
      const system = `你是${config.cityName}人民政府市长办公室 AI 秘书，为新建城市拟定建城元年的施政方针候选。
风格：正式、克制、带轻微官方幽默感；紧扣"新城市、新开始"语义；不使用 emoji、不喊口号。
仅输出严格 JSON 数组（恰好 3 个元素，彼此方向有差异）：
[{"title":"方针标题(4-8字)","description":"简要说明(1句)"},{"title":"...","description":"..."},{"title":"...","description":"..."}]`;
      const user = `城市名：${config.cityName}，建城年份：${year}。请拟定 3 个建城元年施政方针候选。`;
      const text = await chatCompletion(system, user, 'json');
      const raw = parseJsonLoose<Array<{ title?: string; description?: string }>>(text);
      const cleaned = (Array.isArray(raw) ? raw : [])
        .filter((c) => c && typeof c.title === 'string' && c.title.trim())
        .map((c) => ({
          year,
          title: (c.title as string).trim(),
          description: (c.description ?? '').toString().trim(),
          source: 'initial' as const,
        }));
      return cleaned.length >= 3 ? cleaned.slice(0, 3) : fallback();
    } catch (e) {
      console.error('[aiClient.generateInitialPolicyCandidates] 降级：', e);
      return fallback();
    }
  },

  /** 施工备注整理：口语 → 一句正式施工记录（失败则回原文） */
  async formalizeProgressNote(rawNote: string, projectName: string): Promise<string> {
    const trimmed = rawNote.trim();
    if (!trimmed) return '';
    if (shouldUseMock()) {
      await delay(MOCK_DELAY_MS / 2);
      return `本日围绕"${trimmed.slice(0, 16)}"开展相关工作，项目建设正常推进。`;
    }
    try {
      const { system, user } = formalizeProgressPrompt({ projectName, rawNote: trimmed });
      const text = await chatCompletion(system, user);
      return text.trim() || trimmed;
    } catch (e) {
      console.error('[aiClient.formalizeProgressNote] 降级：', e);
      return trimmed;
    }
  },

  /** 年报 mock 段落（供 reportBuilder 在 Demo / 降级时使用） */
  annualReportMockSections: annualReportMock,
};

export type AIClient = typeof aiClient;
