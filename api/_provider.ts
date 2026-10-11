/**
 * OpenAI-compatible LLM provider adapter（服务端，薄封装）。
 *
 * 唯一与具体厂商/部署相关的代码集中在此。切换 OpenAI / DeepSeek / Qwen / 自建网关
 * 只需改环境变量，不改业务。未来切 Netlify / Cloudflare / 自建 Node 只替换 api/ai.* 的
 * 平台入口签名，本文件可复用。
 *
 * 环境变量（仅服务端，前端永不可见）：
 *   AI_BASE_URL  OpenAI-compatible chat/completions 基址（默认 https://api.openai.com/v1）
 *   AI_API_KEY   提供商密钥
 *   AI_MODEL     模型名（默认 gpt-4o-mini）
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 需要严格 JSON 时传 'json'（映射为 response_format: json_object） */
  responseFormat?: 'text' | 'json';
}

export interface ProviderResult {
  content: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
/**
 * 服务端对提供商的硬超时。推理型模型（如 gpt-5.* 系列）首字节较慢，13s 偏短会误伤 JSON/复杂请求，
 * 故放宽到 75s；需保证"前端超时 > 服务端超时"，让服务端能先返回结构化结果而非被前端掐断。
 */
const PROVIDER_TIMEOUT_MS = 75_000;

export class ProviderConfigError extends Error {}
export class ProviderUpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** 读取服务端配置；缺失 AI_API_KEY 抛 ProviderConfigError（由入口转为 503 + fallback 语义） */
function readConfig() {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new ProviderConfigError('AI_API_KEY not configured');
  }
  const baseUrl = (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

/**
 * 调用 OpenAI-compatible /chat/completions，返回首条消息文本。
 * 失败抛错（ProviderConfigError / ProviderUpstreamError / 其它），由入口统一处理，
 * 不把 provider 原始响应或 secret 透传给前端。
 */
export async function callProvider(req: ProviderRequest): Promise<ProviderResult> {
  const { apiKey, baseUrl, model } = readConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.8,
    };
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;
    if (req.responseFormat === 'json') body.response_format = { type: 'json_object' };

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 不透传上游响应体（可能含敏感/冗长信息），只保留状态码
      throw new ProviderUpstreamError(`upstream ${resp.status}`, resp.status);
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new ProviderUpstreamError('upstream empty content', 502);
    }
    return { content };
  } finally {
    clearTimeout(timer);
  }
}
