/**
 * macOS 系统音频采集（主进程侧）。
 *
 * 为什么需要它：Chromium 的 `getDisplayMedia({audio:true})` 在 macOS 上拿不到
 * 系统输出（loopback）—— 音轨对象存在、不报错，但永远是静音。原版也是这样处理的：
 * 自己带一个 ScreenCaptureKit helper 子进程，把 16k/mono/s16le PCM 通过管道吐出来。
 *
 * 本文件对应原版 `MacSystemAudioService`（dist-electron/main.js），协议逐条对齐：
 *
 *   拉起方式   spawn(helper, [])            —— 无参数即管道模式
 *   stderr     "ready"                      —— 采集已开始
 *              "failed: <原因>"              —— 启动失败
 *              其它行                        —— 诊断信息，仅记录
 *   stdout     [uint32 LE 长度][PCM 载荷]     —— 逐个帧
 *   渲染层事件  mac-system-audio:ready / :data / :error
 *
 * 注意：ScreenCaptureKit 同一时刻只允许一个采集会话，残留进程会让后续
 * `SCShareableContent.current` 直接卡住（不报错、也不返回）。所以 start() 必须先
 * 杀掉旧进程，stop() 必须真的 kill —— 这两点在实测中踩过。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, systemPreferences } from 'electron'

export interface SystemAudioResult {
  ok: boolean
  error?: string
}

/* 与原版一致的错误码 */
export const SCREEN_PERMISSION_DENIED = 'SCREEN_PERMISSION_DENIED'
export const SCREEN_CAPTURE_UNAVAILABLE = 'SCREEN_CAPTURE_UNAVAILABLE'
export const SCREEN_CAPTURE_TIMEOUT = 'SCREEN_CAPTURE_TIMEOUT'
export const SYSTEM_AUDIO_STOPPED = 'SYSTEM_AUDIO_STOPPED'
export const SYSTEM_AUDIO_START_TIMEOUT = 'SYSTEM_AUDIO_START_TIMEOUT'

/** 管道模式专用事件名（原版就是这个拼写，不带 IPC. 前缀） */
export const SYSTEM_AUDIO_CHANNELS = {
  Start: 'mac-system-audio:start',
  Stop: 'mac-system-audio:stop',
  CheckAccess: 'mac-system-audio:check-access',
  Data: 'mac-system-audio:data',
  Ready: 'mac-system-audio:ready',
  Error: 'mac-system-audio:error'
} as const

/** 探活超时（原版 60s）：helper 首次枚举可采集内容可能要好几秒 */
const PROBE_TIMEOUT_MS = 60_000
/** 单帧载荷上限，防止畸形长度把内存吃干 */
const MAX_FRAME_BYTES = 1 << 20

export type MediaAccessKind = 'screen' | 'microphone' | 'camera'

export function mediaAccessStatus(kind: MediaAccessKind): string {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus(kind)
  } catch {
    return 'unknown'
  }
}

/**
 * 采集类错误的归一化。原版就是用**系统真实权限状态**来判定的，
 * 而不是去猜 helper 报的文字 —— 这样「未授权」和「其它故障」不会混淆，
 * 渲染层也就能准确提示「去开屏幕录制」还是「换一种输入」。
 */
export function normalizeCaptureError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.message === SCREEN_CAPTURE_TIMEOUT) {
      return new Error(SCREEN_CAPTURE_TIMEOUT)
    }
  }
  const status = mediaAccessStatus('screen')
  if (status === 'denied' || status === 'restricted') return new Error(SCREEN_PERMISSION_DENIED)
  return new Error(SCREEN_CAPTURE_UNAVAILABLE)
}

/** macOS 13+ 才有 ScreenCaptureKit 音频；Windows 走系统 loopback */
export function supportsSystemAudioLoopback(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform !== 'darwin') return false
  return macOsMajorVersion() >= 13
}

function macOsMajorVersion(): number {
  /*
   * 优先用 Electron 的 process.getSystemVersion()，它给的是产品版本号（如 "26.6.1"），
   * 原版比较的也是产品版本。纯 Node 环境（自测脚本）没有这个 API，
   * 退回内核版本号换算：Darwin 22 = macOS 13。
   */
  const raw = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : ''
  const product = Number.parseInt(String(raw).split('.')[0] ?? '', 10)
  if (Number.isFinite(product) && product > 0) return product
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const darwin = Number.parseInt(String(require('node:os').release()).split('.')[0] ?? '', 10)
    if (Number.isFinite(darwin) && darwin > 0) return Math.max(0, darwin - 9)
  } catch {
    /* 拿不到就按不支持处理 */
  }
  return 0
}

export class MacSystemAudioService {
  private child: ChildProcess | null = null
  private target: BrowserWindow | null = null
  /** stdout 上还没凑满一帧的残留字节 */
  private pending = Buffer.alloc(0)
  private frameCount = 0
  private ready = false
  private probe: Promise<SystemAudioResult> | null = null
  private cancelProbe: (() => void) | null = null

  /** 当前是否已有一路采集在跑（原版用 process && ready 判定） */
  isRunning(): boolean {
    return this.child !== null && this.ready
  }

  /**
   * 实测屏幕录制权限是否真的可用。
   *
   * 做法与原版相同：拉一个 helper 起来，等它在 stderr 上打 "ready"。
   * 这比 `systemPreferences.getMediaAccessStatus()` 更可信 —— 后者在
   * 「授权过但没重启应用」时会骗你。
   */
  checkAccess(): Promise<SystemAudioResult> {
    if (this.child && this.ready) return Promise.resolve({ ok: true })
    if (this.probe) return this.probe
    if (process.platform !== 'darwin') {
      return Promise.resolve({ ok: false, error: SCREEN_CAPTURE_UNAVAILABLE })
    }
    const helper = this.getHelperPath()
    if (!helper) return Promise.resolve({ ok: false, error: SCREEN_CAPTURE_UNAVAILABLE })

    this.probe = new Promise<SystemAudioResult>((resolve) => {
      const proc = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
      let buffered = ''
      let settled = false
      const finish = (result: SystemAudioResult): void => {
        if (settled) return
        settled = true
        this.cancelProbe = null
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {
          /* 已经退出 */
        }
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, error: SYSTEM_AUDIO_START_TIMEOUT }), PROBE_TIMEOUT_MS)
      this.cancelProbe = () => finish({ ok: false, error: SYSTEM_AUDIO_STOPPED })

      proc.stdout?.on('data', () => {
        /* 探活不消费音频，读掉即可，避免管道写满把 helper 卡住 */
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        buffered += String(chunk)
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line) continue
          if (line === 'ready') finish({ ok: true })
          else if (/^(failed:|capture stopped:)/.test(line)) {
            finish({ ok: false, error: normalizeCaptureError(new Error(line)).message })
          }
        }
      })
      proc.on('error', () => finish({ ok: false, error: SCREEN_CAPTURE_UNAVAILABLE }))
      proc.on('exit', () => finish({ ok: false, error: normalizeCaptureError(new Error('Helper exited')).message }))
    }).finally(() => {
      this.probe = null
    })

    return this.probe
  }

  /**
   * 开始采集，音频帧推给 `win`。
   * 返回 { ok: true } 只代表 helper 已拉起；真正的就绪信号是
   * `mac-system-audio:ready` 事件（渲染层必须等它）。
   */
  start(win: BrowserWindow): SystemAudioResult {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'macOS 系统音频采集仅在 macOS 上可用。' }
    }
    if (this.child) {
      // 同一窗口重复 start 只需要补发一次 ready；换了窗口则重启
      if (this.target === win && !win.isDestroyed()) {
        if (this.ready) queueMicrotask(() => this.sendReady())
        return { ok: true }
      }
      this.stop(false)
    }
    const helper = this.getHelperPath()
    if (!helper) {
      return { ok: false, error: `未找到系统音频采集组件：${this.helperCandidates()[0]}` }
    }

    this.cancelProbe?.()
    this.ready = false

    console.log('[MacSystemAudio] 启动采集组件：', helper)
    const proc = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = proc
    this.target = win
    this.pending = Buffer.alloc(0)
    this.frameCount = 0

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== proc) return
      this.handleStdout(chunk)
    })

    let buffered = ''
    const onLine = (line: string): void => {
      if (this.child !== proc || !line) return
      if (line === 'ready') {
        this.ready = true
        this.sendReady()
        return
      }
      if (!/^(failed:|capture stopped:)/.test(line)) {
        console.warn('[MacSystemAudio] 组件诊断：', line)
        return
      }
      console.warn('[MacSystemAudio] 组件报错：', line)
      this.sendError(normalizeCaptureError(new Error(line)).message)
      this.stop(false)
    }
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (this.child !== proc) return
      buffered += String(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const raw of lines) onLine(raw.trim())
    })
    proc.on('error', (error: Error) => {
      if (this.child !== proc) return
      this.sendError(error.message)
      this.stop(false)
    })
    proc.on('exit', () => {
      if (buffered) onLine(buffered.trim())
      if (this.child !== proc) return
      // 非正常退出：告诉渲染层，否则界面会停在「正在听…」
      this.sendError(SYSTEM_AUDIO_STOPPED)
      this.child = null
      this.ready = false
      this.target = null
      this.pending = Buffer.alloc(0)
      this.frameCount = 0
    })

    return { ok: true }
  }

  /** sendError=false 用于「主动停止」，避免把正常关闭报成故障 */
  stop(sendError = true): void {
    this.cancelProbe?.()
    this.ready = false
    const proc = this.child
    if (proc && sendError) this.sendError(SYSTEM_AUDIO_STOPPED)
    this.child = null
    this.target = null
    this.pending = Buffer.alloc(0)
    this.frameCount = 0
    if (proc && !proc.killed) {
      try {
        proc.kill()
      } catch {
        /* 已经退出 */
      }
    }
  }

  private helperCandidates(): string[] {
    const name = 'capture-sck'
    const relative = path.join('native', 'system-audio', name)
    return [
      // 开发模式：项目根目录
      path.join(app.getAppPath(), relative),
      // 打包后：随 extraResources 放到 resources 下
      path.join(process.resourcesPath ?? '', relative),
      path.join(process.resourcesPath ?? '', 'app.asar.unpacked', relative)
    ]
  }

  private getHelperPath(): string | null {
    for (const candidate of this.helperCandidates()) {
      if (candidate && existsSync(candidate)) return candidate
    }
    return null
  }

  /** 按 [uint32 LE 长度][载荷] 拆帧 */
  private handleStdout(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0)
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        console.warn('[MacSystemAudio] 帧长度异常，丢弃缓冲：', length)
        this.pending = Buffer.alloc(0)
        return
      }
      if (this.pending.length < 4 + length) return
      const payload = this.pending.subarray(4, 4 + length)
      this.sendData(payload)
      this.pending = this.pending.subarray(4 + length)
    }
  }

  private sendData(payload: Buffer): void {
    const win = this.target
    if (!win || win.isDestroyed()) return
    this.frameCount += 1
    // 只报第一帧：确认采集通了就够，之后不再刷终端
    if (this.frameCount === 1) console.log('[MacSystemAudio] 已开始推送 PCM 帧')
    // 复制成独立 ArrayBuffer 再发：Buffer 底层是共享内存池，直接切出来会串数据
    const copy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
    win.webContents.send(SYSTEM_AUDIO_CHANNELS.Data, copy)
  }

  private sendReady(): void {
    const win = this.target
    if (!win || win.isDestroyed()) return
    win.webContents.send(SYSTEM_AUDIO_CHANNELS.Ready)
  }

  private sendError(message: string): void {
    const win = this.target
    if (!win || win.isDestroyed()) return
    win.webContents.send(SYSTEM_AUDIO_CHANNELS.Error, message)
  }
}

let service: MacSystemAudioService | null = null

export function getMacSystemAudioService(): MacSystemAudioService | null {
  if (process.platform !== 'darwin') return null
  if (!service) service = new MacSystemAudioService()
  return service
}

/** 退出前必须收掉子进程，否则会留下僵尸采集会话 */
export function disposeMacSystemAudio(): void {
  service?.stop(false)
  service = null
}
