import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

/**
 * 本地开发用 /api/ai 中间件（直接 Node 调用，不经 ssrLoadModule）。
 * 密钥从 Node 侧读取，绝不暴露给浏览器。
 */
function devAiProxy(): Plugin {
  // 读取 .env.local 的 AI_* 到 process.env（仅服务端）
  const envPath = resolve(__dirname, '.env.local')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*(AI_[A-Z_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }

  const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
  const DEFAULT_MODEL = 'gpt-4o-mini'
  const PROVIDER_TIMEOUT_MS = 75_000

  const MAX_MESSAGES = 24
  const MAX_MSG_CHARS = 8_000
  const MAX_TOTAL_CHARS = 24_000
  const MAX_TOKENS_CAP = 1_500
  const VALID_ROLES = new Set(['system', 'user', 'assistant'])

  function validateMessages(input: unknown): Array<{ role: string; content: string }> | null {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) return null
    let total = 0
    const out: Array<{ role: string; content: string }> = []
    for (const item of input) {
      if (!item || typeof item !== 'object') return null
      const role = (item as { role?: unknown }).role
      const content = (item as { content?: unknown }).content
      if (typeof role !== 'string' || !VALID_ROLES.has(role)) return null
      if (typeof content !== 'string') return null
      if (content.length > MAX_MSG_CHARS) return null
      total += content.length
      if (total > MAX_TOTAL_CHARS) return null
      out.push({ role, content })
    }
    return out
  }

  return {
    name: 'dev-ai-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/ai', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)

        let body: Record<string, unknown>
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid body' }))
          return
        }

        const messages = validateMessages(body.messages)
        if (!messages) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid messages' }))
          return
        }

        const apiKey = process.env.AI_API_KEY
        if (!apiKey?.trim()) {
          res.statusCode = 503
          res.end(JSON.stringify({ error: 'ai service unavailable' }))
          return
        }

        const baseUrl = (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
        const model = process.env.AI_MODEL || DEFAULT_MODEL
        const responseFormat = body.responseFormat === 'json' ? 'json' : 'text'
        let temperature: number | undefined
        if (typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)
          temperature = body.temperature
        let maxTokens: number | undefined
        if (typeof body.maxTokens === 'number' && body.maxTokens > 0)
          maxTokens = Math.min(Math.floor(body.maxTokens), MAX_TOKENS_CAP)

        const reqBody: Record<string, unknown> = {
          model,
          messages,
          temperature: temperature ?? 0.8,
        }
        if (maxTokens) reqBody.max_tokens = maxTokens
        if (responseFormat === 'json') reqBody.response_format = { type: 'json_object' }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
        try {
          const upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          })
          if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '')
            console.error(`[dev-ai] upstream ${upstream.status}: ${detail.slice(0, 500)}`)
            res.statusCode = 502
            res.end(JSON.stringify({ error: `ai upstream error` }))
            return
          }
          const data = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
          const content = data?.choices?.[0]?.message?.content
          if (!content?.trim()) {
            res.statusCode = 502
            res.end(JSON.stringify({ error: 'ai empty content' }))
            return
          }
          res.statusCode = 200
          res.end(JSON.stringify({ content }))
        } catch {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'ai request failed' }))
        } finally {
          clearTimeout(timer)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), devAiProxy()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
