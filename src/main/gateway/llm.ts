import { randomUUID } from 'node:crypto'
import type { ChatDelta, ChatMessage, ChatResult, ChatUsage, ConnectionTestResult, ProviderConfig } from '@shared/types'

/**
 * OpenAI 兼容网关客户端。
 *
 * 只依赖 fetch + SSE，因此可以对接：官方 OpenAI/DeepSeek/通义/豆包/Kimi/OpenRouter、
 * 各类中转站、vLLM / Ollama / LM Studio 等自建服务。
 */

export interface ChatOptions {
  provider: ProviderConfig
  messages: ChatMessage[]
  /** 请求 JSON 输出（部分网关支持 response_format） */
  json?: boolean
  signal?: AbortSignal
  /** 覆盖模型（知识库检索等场景可能用不同模型） */
  model?: string
  /** 覆盖推理强度 */
  reasoningEffort?: ProviderConfig['reasoningEffort']
  temperature?: number
  maxTokens?: number
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  // 允许用户直接填写完整端点
  if (/\/chat\/completions$/.test(base) || /\/completions$/.test(base)) return base
  return `${base}${path}`
}

function authHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  return headers
}

/** 深合并：把 extraBody 叠加到请求体上，数组与标量整体覆盖 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 组装请求体。
 *
 * 参数策略（重点）：只发送「用户明确要发」的参数，避免推理模型被无效参数干扰。
 *  - temperature 未填 → 不发送（o 系列 / gpt-5 / deepseek-reasoner 等不接受）
 *  - reasoningEffort 为 'auto' → 不发送 reasoning_effort
 *  - extraBody 为合法 JSON 对象 → 深合并进请求体，用于适配各家私有字段
 */
function buildBody(opts: ChatOptions, stream: boolean): Record<string, unknown> {
  const { provider } = opts
  const model = opts.model || provider.model
  if (!model) throw new Error('未配置模型名称')

  const body: Record<string, unknown> = { model, messages: opts.messages, stream }

  const maxTokens = opts.maxTokens ?? provider.maxTokens
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens

  // 推理强度（与 Codex 的 model_reasoning_effort 取值一致）
  const effort = opts.reasoningEffort ?? provider.reasoningEffort
  if (effort && effort !== 'auto') body.reasoning_effort = effort

  // temperature 仅在显式提供时发送
  const temperature = opts.temperature ?? provider.temperature
  if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature

  if (opts.json) body.response_format = { type: 'json_object' }

  // 自定义参数（逃生口）
  const extra = (provider.extraBody ?? '').trim()
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return deepMerge(body, parsed as Record<string, unknown>)
      }
      console.warn('[gateway] extraBody 不是 JSON 对象，已忽略')
    } catch (error) {
      console.warn('[gateway] extraBody 解析失败，已忽略：', error instanceof Error ? error.message : error)
    }
  }
  return body
}

/** extraBody 是否可解析，供 UI 校验 */
export function validateExtraBody(extra: string): { ok: boolean; message: string } {
  const text = (extra ?? '').trim()
  if (!text) return { ok: true, message: '' }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '必须是 JSON 对象，例如 {"enable_thinking": true}' }
    }
    return { ok: true, message: `将合并以下字段：${Object.keys(parsed).join(', ')}` }
  } catch (error) {
    return { ok: false, message: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 网关返回体的宽松类型 */
interface WireMessage {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
}

interface WireChoice {
  delta?: WireMessage
  message?: WireMessage
  finish_reason?: string | null
}

interface WireResponse {
  choices?: WireChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; type?: string }
  message?: string
  /** 部分中转/Azure 网关把真实错误塞在这里（字符串） */
  messages?: string
  code?: string
  detail?: string
}

function extractUsage(res: WireResponse): ChatUsage | null {
  const u = res.usage
  if (!u) return null
  return { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 }
}

/**
 * 从错误响应体里提取可读信息。
 *
 * 各网关格式差异很大：
 *  - OpenAI 官方：{"error":{"message":"..."}}
 *  - Azure 中转：{"code":"...","messages":"azure service call failed: ...{\"error\":{\"message\":\"...\"}}"}
 *  - 纯文本 / HTML
 * 因此这里逐层找，尽量把嵌套的真实原因挖出来。
 */
function extractErrorMessage(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const pick = (value: unknown, depth = 0): string => {
    if (depth > 4) return ''
    if (typeof value === 'string') {
      const s = value.trim()
      if (!s) return ''
      // 内层还是 JSON 就继续往下挖，取出真正的 message
      const inner = s.match(/\{[\s\S]*\}/)
      if (inner) {
        try {
          const nested = pick(JSON.parse(inner[0]), depth + 1)
          if (nested) return nested
        } catch {
          /* 不是 JSON，原样返回 */
        }
      }
      return s
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      for (const key of ['error', 'message', 'messages', 'detail', 'msg', 'reason']) {
        const found = pick(obj[key], depth + 1)
        if (found) return found
      }
    }
    return ''
  }

  try {
    const parsed = JSON.parse(text) as unknown
    const message = pick(parsed)
    if (message) return message
  } catch {
    /* 非 JSON */
  }
  // 兜底：把原文里的 message 字段抠出来
  const loose = text.match(/"message"\s*:\s*"([^"]+)"/)
  if (loose) return loose[1]
  return text.slice(0, 400)
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  const message = extractErrorMessage(text)
  return message ? `${res.status} ${message}` : `HTTP ${res.status} ${res.statusText}`
}

/* ------------------------------------------------------------------ *
 * 参数兼容性自愈
 *
 * 不同模型/网关对同名参数的支持不一致，最典型的是新版 OpenAI 模型
 * （o 系列 / GPT-5）拒收 max_tokens，要求 max_completion_tokens：
 *   "Unsupported parameter: 'max_tokens' is not supported with this model.
 *    Use 'max_completion_tokens' instead."
 *
 * 与其靠模型名猜（容易过时），不如按网关的真实报错纠正参数后重试一次。
 * ------------------------------------------------------------------ */

/** 参数不支持时的处理方式：改名 / 删除 */
const PARAM_FIXES: Record<string, { renameTo?: string; drop?: true }> = {
  max_tokens: { renameTo: 'max_completion_tokens' },
  max_completion_tokens: { renameTo: 'max_tokens' },
  temperature: { drop: true },
  reasoning_effort: { drop: true },
  response_format: { drop: true },
  stream_options: { drop: true }
}

/** 从错误文本中找出网关拒绝的参数名 */
function detectRejectedParams(errorText: string): string[] {
  const found = new Set<string>()
  // Unsupported parameter: 'max_tokens' / Unsupported value: 'x' for 'temperature'
  for (const match of errorText.matchAll(/unsupported\s+(?:parameter|value)[^'"]*['"]([a-z_]+)['"]/gi)) {
    found.add(match[1].toLowerCase())
  }
  // 注意：绝不能把「Use 'xxx' instead」里的 xxx 当作被拒参数——
  // 那是网关推荐的替代名，误判会让两个参数互相重命名而死循环。
  // 兜底：错误里直接点了我们发送过的参数名
  if (!found.size) {
    for (const key of Object.keys(PARAM_FIXES)) {
      if (new RegExp(`['"\`]${key}['"\`]`, 'i').test(errorText)) found.add(key)
    }
  }
  return [...found]
}

/** 已知需要 max_completion_tokens 的模型（仅在 auto 模式下作为初始猜测） */
function prefersMaxCompletionTokens(model: string): boolean {
  return /^(o[1-9]|gpt-5|gpt-4\.5)/i.test(model.trim())
}

/**
 * 发送对话请求，遇到「参数不被支持」时自动纠正并重试（最多 2 轮）。
 * 返回最终响应，由调用方决定如何消费（流式/非流式）。
 */
async function postChat(
  provider: ProviderConfig,
  opts: ChatOptions,
  stream: boolean
): Promise<{ res: Response; body: Record<string, unknown>; adjustments: string[] }> {
  const body = buildBody(opts, stream)
  if (stream) {
    // 部分网关（DeepSeek/Qwen）需要显式开启 usage 统计
    body.stream_options = { include_usage: true }
  }

  const url = joinUrl(provider.baseUrl, '/chat/completions')
  const adjustments: string[] = []
  /** 记录历史上被拒过的参数，用来阻断「改名来回弹跳」的死循环 */
  const rejectedEver = new Set<string>()

  // auto 模式：先按模型名猜一次，猜错也会被下面的自愈纠正
  const explicit = provider.maxTokensParam ?? 'auto'
  const model = String(body.model ?? '')
  const wantCompletion =
    explicit === 'max_completion_tokens' || (explicit === 'auto' && prefersMaxCompletionTokens(model))
  if (wantCompletion && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
    adjustments.push('max_tokens → max_completion_tokens（按模型名推断）')
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal: opts.signal
    })
    if (res.ok) return { res, body, adjustments }

    const errorText = await res.text().catch(() => '')
    // 只有 400/422 这类「参数问题」才值得纠正重试；鉴权/限流/超时直接报错
    const retriable = res.status === 400 || res.status === 422
    const rejected = retriable ? detectRejectedParams(errorText) : []

    if (!rejected.length) {
      const message = extractErrorMessage(errorText)
      throw new Error(message ? `${res.status} ${message}` : `HTTP ${res.status} ${res.statusText}`)
    }

    let changed = false
    for (const param of rejected) {
      const fix = PARAM_FIXES[param]
      if (!fix || body[param] === undefined) continue
      rejectedEver.add(param)

      if (fix.renameTo && !rejectedEver.has(fix.renameTo)) {
        // 只在本体确实用了这个参数、且目标参数还没被占用时才改名
        if (body[fix.renameTo] === undefined) body[fix.renameTo] = body[param]
        delete body[param]
        adjustments.push(`${param} → ${fix.renameTo}（网关不支持）`)
        changed = true
      } else {
        // 目标参数历史上也被拒过，或本就没有替代名 → 直接移除，避免来回改名死循环
        delete body[param]
        adjustments.push(`${param} 已移除（网关不支持）`)
        changed = true
      }
    }

    if (!changed) {
      const message = extractErrorMessage(errorText)
      throw new Error(message ? `${res.status} ${message}` : `HTTP ${res.status} ${res.statusText}`)
    }
    if (adjustments.length) console.warn('[gateway] 参数兼容性调整：', adjustments.join('；'))
  }

  throw new Error('参数兼容性重试次数已用尽，请检查模型与网关配置')
}

/**
 * 流式对话。逐块产出 reasoning / content 增量。
 * 调用方负责处理取消（传入 AbortSignal）。
 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<ChatDelta, ChatResult, void> {
  const { provider, messages } = opts
  if (!provider.baseUrl) throw new Error('未配置网关地址（baseUrl）')

  const model = opts.model || provider.model
  if (!model) throw new Error('未配置模型名称')

  const started = Date.now()
  const { res, adjustments } = await postChat(provider, opts, true)

  if (!res.ok || !res.body) throw new Error(await readError(res))

  let text = ''
  let reasoning = ''
  let usage: ChatUsage | null = null
  let firstTokenMs: number | null = null

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE：以空行分隔事件
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)

        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let parsed: WireResponse
          try {
            parsed = JSON.parse(payload) as WireResponse
          } catch {
            continue
          }

          const choice = parsed.choices?.[0]
          const delta = choice?.delta ?? choice?.message
          if (!delta && !parsed.usage) continue

          const r = delta?.reasoning_content ?? delta?.reasoning
          if (r) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started
            reasoning += r
            yield { kind: 'reasoning', text: r }
          }
          const c = delta?.content
          if (c) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started
            text += c
            yield { kind: 'content', text: c }
          }
          if (parsed.usage) usage = extractUsage(parsed)
        }
      }
    }
  } finally {
    reader.releaseLock?.()
    // 主动取消底层请求，避免连接悬挂
    if (opts.signal?.aborted) {
      await res.body.cancel().catch(() => undefined)
    }
  }

  return {
    text,
    reasoning,
    usage,
    firstTokenMs,
    totalMs: Date.now() - started,
    adjustments
  }
}

/** 非流式对话，供标题生成、评分、结构化抽取等场景使用 */
export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
  const { provider } = opts
  if (!provider.baseUrl) throw new Error('未配置网关地址（baseUrl）')

  const started = Date.now()
  const { res, adjustments } = await postChat(provider, opts, false)
  if (!res.ok) throw new Error(await readError(res))

  const json = (await res.json()) as WireResponse
  const msg = json.choices?.[0]?.message
  return {
    text: msg?.content ?? '',
    reasoning: msg?.reasoning_content ?? msg?.reasoning ?? '',
    usage: extractUsage(json),
    firstTokenMs: null,
    totalMs: Date.now() - started,
    adjustments
  }
}

/** 拉取模型列表（部分网关不支持，失败时返回错误信息而非抛异常） */
export async function listModels(provider: ProviderConfig): Promise<{ ok: boolean; models: string[]; message: string }> {
  if (!provider.baseUrl) return { ok: false, models: [], message: '未配置网关地址' }
  try {
    const res = await fetch(joinUrl(provider.baseUrl, '/models'), {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return { ok: false, models: [], message: await readError(res) }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    return { ok: true, models, message: `获取到 ${models.length} 个模型` }
  } catch (error) {
    return { ok: false, models: [], message: error instanceof Error ? error.message : String(error) }
  }
}

/** 连通性测试：用一次极小的补全请求验证地址/密钥/模型三者是否可用 */
export async function testProvider(provider: ProviderConfig): Promise<ConnectionTestResult> {
  const started = Date.now()
  try {
    const result = await chatComplete({
      provider,
      messages: [
        { role: 'system', content: '你是连通性测试探针，只回复 OK。' },
        { role: 'user', content: 'ping' }
      ],
      maxTokens: 8
    })
    // 探针用于验证配置，因此不发送 temperature；若发生过参数兼容调整，一并告知用户
    const notes = result.adjustments?.length ? `（已自动适配：${result.adjustments.join('；')}）` : ''
    return {
      ok: true,
      latencyMs: Date.now() - started,
      message: `连接正常，模型返回：${result.text.trim().slice(0, 40) || '(空)'}${notes}`
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 向量
 * ------------------------------------------------------------------ */

/** 批量取向量；网关不支持时抛错，由调用方降级为关键词检索 */
export async function embed(cfg: { baseUrl: string; apiKey: string; model: string }, inputs: string[]): Promise<number[][]> {
  if (!cfg.baseUrl) throw new Error('未配置向量模型网关')
  const res = await fetch(joinUrl(cfg.baseUrl, '/embeddings'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({ model: cfg.model, input: inputs }),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) throw new Error(await readError(res))
  const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> }
  const rows = json.data ?? []
  if (!rows.length) throw new Error('向量接口返回为空')
  return rows
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((r) => r.embedding ?? [])
}

/** 供需要 requestId 的场景使用 */
export function newRequestId(): string {
  return randomUUID()
}
