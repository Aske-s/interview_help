import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AsrConfig, ConnectionTestResult } from '@shared/types'
import { pcmRms } from './index'

/**
 * 阿里云百炼（DashScope）Paraformer 实时语音识别。
 *
 * 协议依据官方文档：
 *   - 客户端事件：run-task / finish-task
 *   - 服务端事件：task-started / result-generated / task-finished / task-failed
 * https://help.aliyun.com/zh/model-studio/paraformer-client-events
 * https://help.aliyun.com/zh/model-studio/paraformer-server-events
 *
 * 为什么单独做这条通道：它是**流式**的——
 * 服务端在 `result-generated` 里给出 `sentence.sentence_end`：
 *   · false → 中间结果，可以边说边显示
 *   · true  → 最终结果，定稿
 * 这与随思客户端拿到 `{isFinal, segId}` 后原地更新的语义完全一致
 * （见原版 floating 的 case "transcript"）。之前的三条通道都是批量的，拿不到这种增量。
 *
 * 参数对应关系（对齐原版 quizConfig / audio 里的字段）：
 *   max_sentence_silence           ↔ 随思 aliyunMaxSentenceSilenceMs（默认 800）
 *   semantic_punctuation_enabled   语义断句（true）或 VAD 断句（false）
 *   punctuation_prediction_enabled 标点恢复
 *   inverse_text_normalization_enabled 中文数字转阿拉伯数字
 */

const WS_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
const SAMPLE_RATE = 16000
/** 每帧音频时长（毫秒）。100ms 是实时流的常规粒度 */
const FRAME_MS = 100
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000
/** task-started 的等待上限；超时说明连接/鉴权/模型有问题 */
const START_TIMEOUT_MS = 12000

/** 服务端事件 */
export interface DashScopeEvents {
  /** 连接并就绪，可以开始推音频 */
  onStarted?: () => void
  /** 中间结果（sentence_end=false），可边说边更新 */
  onPartial?: (text: string) => void
  /** 最终结果（sentence_end=true） */
  onFinal?: (text: string, sentenceId: number) => void
  onFinished?: () => void
  onError?: (message: string) => void
}

/**
 * 一次实时识别会话。
 *
 * 用法：
 *   const s = new DashScopeRealtimeSession(cfg, events)
 *   await s.start()          // 建连 + run-task，等 task-started
 *   s.push(pcm)              // 音频可以随时推入，内部按 100ms 分帧并在就绪后发出
 *   await s.finish()         // 发 finish-task，等 task-finished
 */
export class DashScopeRealtimeSession {
  private ws: WebSocket | null = null
  private taskId = randomUUID()
  private started = false
  /** 就绪前先把音频缓存起来，避免丢字头 */
  private pending: Buffer[] = []
  private finalizedText: string[] = []
  private closed = false
  /** 同一句的中间结果要覆盖而不是追加，用 sentenceId 记录 */
  private lastPartialBySentence = new Map<number, string>()

  constructor(
    private readonly cfg: AsrConfig,
    private readonly events: DashScopeEvents = {}
  ) {}

  private endpoint(): string {
    const custom = (this.cfg.realtimeUrl || '').trim()
    return custom || WS_ENDPOINT
  }

  /** 建连并启动任务；resolve 表示可以推音频了 */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.cfg.apiKey) {
        reject(new Error('未配置阿里云百炼 API Key'))
        return
      }
      const ws = new WebSocket(this.endpoint(), {
        headers: {
          Authorization: `bearer ${this.cfg.apiKey}`,
          'X-DashScope-DataInspection': 'enable'
        }
      })
      this.ws = ws

      /*
       * 超时保护：如果 task-started 一直不来，音频会永远堆在 pending 里发不出去，
       * 服务端最终报 noinputaudio，而客户端界面看不到任何错误。
       * 这里主动失败，把「连接/鉴权/模型」这一环的问题暴露出来。
       */
      const startTimer = setTimeout(() => {
        fail(`识别通道 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内未就绪（未收到 task-started）。请检查 API Key、模型名与网络。`)
      }, START_TIMEOUT_MS)

      let settled = false
      const fail = (message: string): void => {
        if (settled) {
          this.events.onError?.(message)
          return
        }
        settled = true
        reject(new Error(message))
      }

      ws.on('open', () => {
        ws.send(JSON.stringify(this.runTaskPayload()))
      })
      ws.on('close', () => clearTimeout(startTimer))

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return // 服务端不会发二进制，忽略
        let msg: DashScopeMessage
        try {
          msg = JSON.parse(data.toString()) as DashScopeMessage
        } catch {
          return
        }
        const event = msg?.header?.event ?? ''
        switch (event) {
          case 'task-started': {
            this.started = true
            // 把等待期间攒下的音频补发出去，保证字头不丢
            for (const chunk of this.pending) this.sendFrames(chunk)
            this.pending = []
            clearTimeout(startTimer)
            this.events.onStarted?.()
            if (!settled) {
              settled = true
              resolve()
            }
            break
          }
          case 'result-generated': {
            const sentence = msg?.payload?.output?.sentence
            if (!sentence || sentence.heartbeat) break // 心跳包直接跳过
            const text = (sentence.text ?? '').trim()
            if (!text) break
            const sentenceId = Number(sentence.sentence_id ?? 0)
            if (sentence.sentence_end) {
              // 定稿：记录最终文本，并让中间态不再影响结果
              this.lastPartialBySentence.delete(sentenceId)
              this.finalizedText.push(text)
              this.events.onFinal?.(text, sentenceId)
            } else {
              this.lastPartialBySentence.set(sentenceId, text)
              this.events.onPartial?.(text)
            }
            break
          }
          case 'task-finished': {
            this.events.onFinished?.()
            break
          }
          case 'task-failed': {
            const code = msg?.header?.error_code ?? 'UNKNOWN'
            const detail = msg?.header?.error_message ?? '未知错误'
            fail(`阿里云实时识别失败 ${code}：${detail}`)
            break
          }
          default:
            break
        }
      })

      ws.on('error', (err: Error) => fail(`连接阿里云实时识别失败：${err.message}`))
      ws.on('close', () => {
        this.closed = true
        if (!settled) fail('阿里云实时识别连接被关闭')
      })
    })
  }

  private runTaskPayload(): unknown {
    const params: Record<string, unknown> = {
      format: 'pcm',
      sample_rate: SAMPLE_RATE,
      disfluency_removal_enabled: false
    }
    const lang = languageHint(this.cfg.language)
    if (lang) params.language_hints = [lang]
    if (this.cfg.semanticPunctuation) {
      params.semantic_punctuation_enabled = true
    } else {
      params.semantic_punctuation_enabled = false
      // 只有 VAD 断句模式下 max_sentence_silence 才生效（文档明确）
      params.max_sentence_silence = Math.min(6000, Math.max(200, this.cfg.vadSilenceMs || 800))
    }
    params.punctuation_prediction_enabled = this.cfg.punctuationPrediction !== false
    params.inverse_text_normalization_enabled = this.cfg.inverseTextNormalization !== false
    // 持续静音时靠心跳保活，否则连接会被超时断开
    params.heartbeat = true

    return {
      header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: this.cfg.realtimeModel || 'paraformer-realtime-v2',
        parameters: params,
        input: {}
      }
    }
  }

  /** 推入一段 PCM（16k 单声道）。未就绪时先缓存 */
  push(pcm: Buffer): void {
    if (this.closed || !pcm.length) return
    if (!this.started) {
      this.pending.push(pcm)
      return
    }
    this.sendFrames(pcm)
  }

  /** 已发送到服务端的帧数（排查用） */
  sentFrames = 0

  private sendFrames(pcm: Buffer): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      ws.send(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length)))
      this.sentFrames++
    }
  }

  /** 结束任务：发 finish-task 并等 task-finished */
  finish(timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.close()
        resolve()
      }, timeoutMs)
      const onFinished = (): void => {
        clearTimeout(timer)
        this.events.onFinished = undefined
        resolve()
      }
      const prev = this.events.onFinished
      this.events.onFinished = () => {
        prev?.()
        onFinished()
      }
      ws.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
          payload: { input: {} }
        })
      )
    })
  }

  /** 已定稿的完整文本 */
  get text(): string {
    return this.finalizedText.join('')
  }

  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* 忽略 */
    }
    this.ws = null
  }
}

interface DashScopeMessage {
  header?: {
    event?: string
    task_id?: string
    error_code?: string
    error_message?: string
  }
  payload?: {
    output?: {
      sentence?: {
        sentence_id?: number
        text?: string
        sentence_end?: boolean
        heartbeat?: boolean
      }
    }
    usage?: { duration?: number } | null
  }
}

/** 文档取值：zh / en / ja / yue / ko / de / fr / ru；不设置则自动识别 */
function languageHint(language?: string): string | undefined {
  if (!language || language === 'auto') return undefined
  const lower = language.toLowerCase()
  if (lower.startsWith('zh')) return 'zh'
  if (lower.startsWith('en')) return 'en'
  if (lower.startsWith('ja')) return 'ja'
  if (lower.startsWith('ko')) return 'ko'
  return lower.slice(0, 2)
}

/**
 * 把实时会话包装成批量接口。
 *
 * 这样它在现有 `AsrProvider` 契约下就能直接工作（每段音频起一次会话），
 * 同时把 `startSession` 暴露给编排层——编排层接上后即可拿到边说边出的中间结果，
 * 那才是与随思一致的链路。
 */
export class DashScopeAsr {
  readonly kind = 'dashscope-realtime' as const

  constructor(private readonly cfg: AsrConfig) {}

  /** 供编排层使用的流式入口 */
  startSession(events: DashScopeEvents): DashScopeRealtimeSession {
    return new DashScopeRealtimeSession(this.cfg, events)
  }

  async transcribe(pcm: Buffer, opts: { language?: string; signal?: AbortSignal } = {}): Promise<string> {
    if (!this.cfg.apiKey) throw new Error('未配置阿里云百炼 API Key')
    if (pcm.length < 1600) return ''

    const session = new DashScopeRealtimeSession(
      { ...this.cfg, language: opts.language ?? this.cfg.language },
      {}
    )
    try {
      await session.start()
      session.push(pcm)
      await session.finish()
      return session.text
    } finally {
      session.close()
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      // 用 0.5 秒静音做探针：能建连并启动任务即说明 Key 与模型可用
      const session = new DashScopeRealtimeSession(this.cfg, {})
      try {
        await session.start()
        session.push(Buffer.alloc(SAMPLE_RATE)) // 0.5s
        await session.finish(5000)
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: `阿里云实时识别可用（${this.cfg.realtimeModel || 'paraformer-realtime-v2'}）`
        }
      } finally {
        session.close()
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/** 供测试与编排层复用的常量 */
export const DASHSCOPE_DEFAULTS = {
  endpoint: WS_ENDPOINT,
  model: 'paraformer-realtime-v2',
  frameBytes: FRAME_BYTES,
  sampleRate: SAMPLE_RATE
}

/** 静音检测用（推流时可用于跳过纯静音，减少无效计费） */
export function isSilentPcm(pcm: Buffer): boolean {
  return pcmRms(pcm) < 0.002
}
