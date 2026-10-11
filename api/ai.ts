/**
 * Serverless AI 代理入口（Vercel 风格：POST /api/ai）。
 *
 * 前端只请求本端点，永远不接触 AI_API_KEY / provider secret。
 * 平台相关仅此文件的 req/res 签名；provider 逻辑在 ./_provider（可迁移）。
 *
 * 请求体：{ messages, responseFormat?, temperature?, maxTokens? }
 * 成功响应：{ content: string }
 * 失败响应：{ error: string } + 合适状态码（配置缺失/上游错误 → 由前端走 fallback）
 *
 * 安全校验：仅 POST；校验 messages；限制条数/长度/maxTokens；
 * 禁止前端传 baseUrl/apiKey/model（一律忽略，model 由服务端环境变量决定）；
 * 不回传 provider 原始响应与内部错误细节。
 */
import {
  callProvider,
  ProviderConfigError,
  ProviderUpstreamError,
  type ChatMessage,
} from './_provider';

// 平台无关的最小请求/响应接口（Vercel Node 函数兼容；迁移时只换这层签名）
interface Req {
  method?: string;
  body?: unknown;
}
interface Res {
  status: (code: number) => Res;
  json: (data: unknown) => void;
  setHeader: (k: string, v: string) => void;
}

/* ---------- 校验上限（服务端强制，防滥用/超额） ---------- */
const MAX_MESSAGES = 24;
const MAX_MSG_CHARS = 8_000; // 单条
const MAX_TOTAL_CHARS = 24_000; // 总输入
const MAX_TOKENS_CAP = 1_500; // maxTokens 上限
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

function parseBody(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

function validateMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) return null;
  let total = 0;
  const out: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) return null;
    if (typeof content !== 'string') return null;
    if (content.length > MAX_MSG_CHARS) return null;
    total += content.length;
    if (total > MAX_TOTAL_CHARS) return null;
    out.push({ role: role as ChatMessage['role'], content });
  }
  return out;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body = parseBody(req.body);
  if (!body) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }

  const messages = validateMessages(body.messages);
  if (!messages) {
    res.status(400).json({ error: 'invalid messages' });
    return;
  }

  // 前端禁止指定 provider / key / model / baseUrl —— 一律忽略（不读取）
  const responseFormat = body.responseFormat === 'json' ? 'json' : 'text';
  let temperature: number | undefined;
  if (typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2) {
    temperature = body.temperature;
  }
  let maxTokens: number | undefined;
  if (typeof body.maxTokens === 'number' && body.maxTokens > 0) {
    maxTokens = Math.min(Math.floor(body.maxTokens), MAX_TOKENS_CAP);
  }

  try {
    const { content } = await callProvider({ messages, responseFormat, temperature, maxTokens });
    res.status(200).json({ content });
  } catch (e) {
    if (e instanceof ProviderConfigError) {
      // 后端未配置密钥：返回 503，前端据此走 deterministic fallback（不白屏）
      res.status(503).json({ error: 'ai service unavailable' });
      return;
    }
    if (e instanceof ProviderUpstreamError) {
      res.status(502).json({ error: 'ai upstream error' });
      return;
    }
    // 超时(abort)或其它：统一 502，不透传堆栈
    res.status(502).json({ error: 'ai request failed' });
  }
}
