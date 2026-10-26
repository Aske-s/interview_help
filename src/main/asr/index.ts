import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AsrConfig, AsrProviderKind, ConnectionTestResult } from '@shared/types'
import { DashScopeAsr } from './dashscope'

/**
 * 语音识别抽象层。两条通道：
 *  - openai-compat：任意提供 /v1/audio/transcriptions 的网关（云端或本地 faster-whisper-server）
 *  - local-whisper-cpp：本地 whisper-cli 可执行文件
 *
 * 输入统一为 16kHz / 单声道 / PCM16 裸流，由调用方（实时会话）负责切分。
 */

export interface AsrTranscribeOptions {
  language?: string
  hotwords?: string[]
  signal?: AbortSignal
}

export interface AsrProvider {
  readonly kind: AsrProviderKind
  transcribe(pcm: Buffer, opts?: AsrTranscribeOptions): Promise<string>
  test(): Promise<ConnectionTestResult>
}

/** 给裸 PCM 套上 WAV 头（whisper 系列接口都要求容器格式） */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function languageCode(language?: string): string | undefined {
  if (!language || language === 'auto') return undefined
  return language
}

/* ------------------------------------------------------------------ *
 * OpenAI 兼容通道
 * ------------------------------------------------------------------ */

class OpenAiCompatAsr implements AsrProvider {
  readonly kind = 'openai-compat' as const

  constructor(private readonly cfg: AsrConfig) {}

  async transcribe(pcm: Buffer, opts: AsrTranscribeOptions = {}): Promise<string> {
    if (!this.cfg.baseUrl) throw new Error('未配置语音识别网关地址')
    if (!this.cfg.model) throw new Error('未配置语音识别模型名')
    if (pcm.length < 1600) return '' // 少于 50ms 的碎片直接丢弃

    const base = this.cfg.baseUrl.replace(/\/+$/, '')
    const url = /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`

    const wav = pcm16ToWav(pcm)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', this.cfg.model)
    const lang = languageCode(opts.language ?? this.cfg.language)
    if (lang) form.append('language', lang)
    const hotwords = opts.hotwords?.filter(Boolean) ?? []
    if (hotwords.length) form.append('prompt', hotwords.join('、'))
    form.append('response_format', 'json')

    const res = await fetch(url, {
      method: 'POST',
      headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : undefined,
      body: form,
      signal: opts.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`语音识别失败 ${res.status} ${text.slice(0, 200)}`)
    }
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      // 用 0.3 秒静音做探针，确认接口可达且鉴权通过
      const silence = Buffer.alloc(16000 * 0.3 * 2)
      const text = await this.transcribe(silence)
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `语音识别接口可用（探针返回：${text || '空'}）`
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

/* ------------------------------------------------------------------ *
 * 本地 whisper.cpp 通道
 * ------------------------------------------------------------------ */

class LocalWhisperAsr implements AsrProvider {
  readonly kind = 'local-whisper-cpp' as const

  constructor(private readonly cfg: AsrConfig) {}

  async transcribe(pcm: Buffer, opts: AsrTranscribeOptions = {}): Promise<string> {
    const { binaryPath, modelPath } = this.cfg
    if (!binaryPath) throw new Error('未配置 whisper-cli 路径')
    if (!modelPath) throw new Error('未配置 whisper 模型路径')
    if (pcm.length < 1600) return ''

    const dir = mkdtempSync(join(tmpdir(), 'suisi-asr-'))
    const wavPath = join(dir, 'audio.wav')
    try {
      writeFileSync(wavPath, pcm16ToWav(pcm))
      const args = [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-l',
        languageCode(opts.language ?? this.cfg.language) ?? 'auto',
        '-nt', // 不输出时间戳
        '-np' // 不打印进度
      ]
      const hotwords = opts.hotwords?.filter(Boolean) ?? []
      if (hotwords.length) args.push('--prompt', hotwords.join('、'))
      const extra = this.cfg.extraArgs.trim()
      if (extra) args.push(...extra.split(/\s+/))

      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve(out)
          else reject(new Error(`whisper-cli 退出码 ${code}：${err.slice(0, 200)}`))
        })
        opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
      })

      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('['))
        .join('')
        .trim()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      const text = await this.transcribe(Buffer.alloc(16000 * 0.3 * 2))
      return { ok: true, latencyMs: Date.now() - started, message: `本地 whisper 可用（探针返回：${text || '空'}）` }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * whisper-server 通道（whisper.cpp 常驻服务）
 * ------------------------------------------------------------------ */

/**
 * 通过 whisper.cpp 的常驻服务做转写。
 *
 * 为什么单独一条通道而不是复用 openai-compat：
 * whisper-server 只提供原生 `/inference`，**不支持** /v1/audio/transcriptions（实测 404）。
 *
 * 为什么不用 local-whisper-cpp（CLI）做实时：
 * 实测同一段 6.2 秒音频，CLI 每次都要重载模型 —— 14.9 秒；
 * 常驻服务 —— 1.0 秒。实时助答只能走常驻。
 */
class WhisperServerAsr implements AsrProvider {
  readonly kind = 'whisper-server' as const

  constructor(private readonly cfg: AsrConfig) {}

  private endpoint(path: string): string {
    const base = (this.cfg.serverUrl || 'http://127.0.0.1:8178').replace(/\/+$/, '')
    return `${base}${path}`
  }

  async transcribe(pcm: Buffer, opts: AsrTranscribeOptions = {}): Promise<string> {
    if (pcm.length < 1600) return ''
    const wav = pcm16ToWav(pcm)
    const hotwords = opts.hotwords?.filter(Boolean) ?? []
    const fields: Array<[string, string]> = [
      ['language', languageCode(opts.language ?? this.cfg.language) ?? 'auto'],
      ['response_format', 'json']
    ]
    if (hotwords.length) fields.push(['prompt', hotwords.join('、')])

    /*
     * 手工构造 multipart。
     * 不能用 fetch + FormData：那会走 Transfer-Encoding: chunked，
     * 而 whisper-server 用的 C++ HTTP 库不认分块编码，会直接断连（实测 EPIPE）。
     * 手工拼出带 Content-Length 的完整 body 才稳。
     */
    const boundary = `----suisi${Date.now().toString(16)}`
    const parts: Buffer[] = []
    for (const [name, value] of fields) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      )
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`
      )
    )
    parts.push(wav)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    const res = await fetch(this.endpoint('/inference'), {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body: new Uint8Array(body),
      signal: opts.signal
    })
    if (!res.ok) throw new Error(`whisper-server 返回 ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { text?: string }
    return (data.text ?? '').trim()
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now()
    try {
      const res = await fetch(this.endpoint('/'), { method: 'GET' })
      const latencyMs = Date.now() - started
      if (!res.ok) return { ok: false, latencyMs, message: `whisper-server 返回 ${res.status}` }
      return { ok: true, latencyMs, message: `whisper-server 可用（${this.cfg.serverUrl}）` }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `连不上 whisper-server：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

export function createAsrProvider(cfg: AsrConfig): AsrProvider {
  if (cfg.kind === 'local-whisper-cpp') return new LocalWhisperAsr(cfg)
  if (cfg.kind === 'whisper-server') return new WhisperServerAsr(cfg)
  if (cfg.kind === 'dashscope-realtime') return new DashScopeAsr(cfg)
  return new OpenAiCompatAsr(cfg)
}

/** 加权均方根能量，用于判断是否有语音（VAD 的轻量替代） */
export function pcmRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0
  const samples = pcm.length >> 1
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples)
}
