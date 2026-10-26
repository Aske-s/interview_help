import { chatStream } from './llm'
import type { ChatDelta, ChatMessage, ChatResult, ProviderConfig } from '@shared/types'

/**
 * 流式请求管理器：统一处理取消、并发与错误分发。
 * 对话窗口与实时会话（悬浮窗）都通过它发起请求，避免各自管理 AbortController。
 */

export interface StreamHandlers {
  onDelta?: (delta: ChatDelta) => void
  onDone?: (result: ChatResult) => void
  onError?: (message: string) => void
}

export interface StreamRequest {
  requestId: string
  provider: ProviderConfig
  messages: ChatMessage[]
  json?: boolean
  model?: string
  temperature?: number
  maxTokens?: number
}

const active = new Map<string, AbortController>()

/** 发起流式请求；同 requestId 会先取消旧请求 */
export function runStream(req: StreamRequest, handlers: StreamHandlers): void {
  cancelStream(req.requestId)

  const controller = new AbortController()
  active.set(req.requestId, controller)

  void (async () => {
    try {
      const iterator = chatStream({
        provider: req.provider,
        messages: req.messages,
        json: req.json,
        model: req.model,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal: controller.signal
      })

      let result: ChatResult | undefined
      for (;;) {
        const step = await iterator.next()
        if (step.done) {
          result = step.value
          break
        }
        handlers.onDelta?.(step.value)
      }

      if (result) handlers.onDone?.(result)
    } catch (error) {
      // 主动取消不算错误
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      handlers.onError?.(message)
    } finally {
      active.delete(req.requestId)
    }
  })()
}

export function cancelStream(requestId: string): void {
  const controller = active.get(requestId)
  if (controller) {
    controller.abort()
    active.delete(requestId)
  }
}

export function cancelAllStreams(): void {
  for (const id of [...active.keys()]) cancelStream(id)
}

export function activeStreamCount(): number {
  return active.size
}
