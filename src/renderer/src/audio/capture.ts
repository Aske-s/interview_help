/**
 * 音频采集（渲染层）。
 *
 * 麦克风与系统音频是两条完全不同的链路：
 *
 *  麦克风   getUserMedia → AudioContext(原生率) → 降到 16k → PCM16
 *  电脑音频 macOS：主进程拉 ScreenCaptureKit 子进程，通过 IPC 推 16k/mono/s16le PCM
 *           其它平台：getDisplayMedia 拿 loopback 音轨（并停掉视频轨）
 *
 * 为什么 macOS 不能走 getDisplayMedia：那条路能拿到「音轨对象」，但永远是静音 ——
 * 不报错、帧也照常送，就是数据全 0。原版为此单独做了原生采集组件，这里保持一致。
 *
 * 输出统一为 16kHz / 单声道 / Int16 PCM，按帧回调给调用方。
 */

export type AudioSource = 'mic' | 'system'

export interface CaptureOptions {
  mic: boolean
  system: boolean
  micDeviceId?: string
}

interface SourcePipeline {
  context: AudioContext
  stream: MediaStream
  node: ScriptProcessorNode
  source: MediaStreamAudioSourceNode
  level: number
}

/** 原生通道的帧切分粒度：1280 字节 = 640 采样 = 40ms（与原版一致） */
const NATIVE_FRAME_BYTES = 1280
/** 等 helper 就绪的上限：首次枚举可采集内容可能要好几秒 */
const NATIVE_READY_TIMEOUT_MS = 60_000
const TARGET_SAMPLE_RATE = 16000

/** 只取音频采集相关的桥接能力，避免依赖窗口类型判别 */
interface SystemAudioBridge {
  supported: () => Promise<boolean>
  checkAccess: () => Promise<{ ok: boolean; error?: string }>
  start: () => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<void>
  onData: (cb: (pcm: ArrayBuffer) => void) => () => void
  onReady: (cb: () => void) => () => void
  onError: (cb: (message: string) => void) => () => void
}

interface AppBridge {
  info?: () => Promise<{ isMacOS?: boolean; platform?: string }>
}

function bridge(): { systemAudio: SystemAudioBridge | null; app: AppBridge | null } {
  const api = window.api as unknown as { systemAudio?: SystemAudioBridge; app?: AppBridge } | undefined
  return { systemAudio: api?.systemAudio ?? null, app: api?.app ?? null }
}

/** 平台只查一次 */
let platformCache: { isMacOS: boolean } | null = null
/** 供设备自检等模块复用：决定「电脑音频」用原生还是 getDisplayMedia */
export async function detectAudioPlatform(): Promise<{ isMacOS: boolean }> {
  if (platformCache) return platformCache
  try {
    const info = await bridge().app?.info?.()
    platformCache = { isMacOS: Boolean(info?.isMacOS ?? info?.platform === 'darwin') }
  } catch {
    platformCache = { isMacOS: false }
  }
  return platformCache
}

/** 把主进程的错误码翻成能直接给用户看的话 */
export function describeAudioError(code: string | undefined): string {
  switch (code) {
    case 'SCREEN_PERMISSION_DENIED':
      return (
        '电脑音频采集需要「屏幕录制」权限。请到 系统设置 → 隐私与安全性 → 屏幕与系统音频录制 ' +
        '中允许本应用，然后完全退出并重新打开（关闭窗口不等于退出应用）。'
      )
    case 'SCREEN_CAPTURE_UNAVAILABLE':
      return '当前系统不支持直接采集电脑音频，请改用麦克风输入。'
    case 'SYSTEM_AUDIO_START_TIMEOUT':
      return '电脑音频采集启动超时。请确认已授予「屏幕录制」权限后重试。'
    case 'SYSTEM_AUDIO_STOPPED':
      return '电脑音频采集已停止。'
    default:
      return code || '电脑音频采集失败。'
  }
}

/**
 * 重采样：把任意采样率的一帧降/升到 16kHz（线性插值）。
 *
 * 麦克风路径用它把设备原生采样率降到 16k。系统音频的原生通道本身就是 16k，
 * 不需要经过这里。
 */
function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_SAMPLE_RATE) return input
  const ratio = fromRate / TARGET_SAMPLE_RATE
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(input.length - 1, left + 1)
    const t = pos - left
    out[i] = input[left] * (1 - t) + input[right] * t
  }
  return out
}

function withTimeout<T>(task: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 一帧 Int16 PCM 的峰值（0-1），用于界面上的音量指示 */
function peakOf(pcm: Int16Array): number {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const value = Math.abs(pcm[i]) / 32768
    if (value > peak) peak = value
  }
  return peak
}

/**
 * 把流式字节切成固定长度的 PCM 帧。
 *
 * 主进程推来的是「字节流」，帧边界会横跨两次事件；直接按事件切会把采样点切歪
 * （表现为杂音、识别乱码）。所以必须留残留字节，凑满一帧才吐出来。
 * 抽成纯函数是为了能单测——这段逻辑以前踩过坑。
 */
export function drainNativeFrames(
  carry: Uint8Array,
  chunk: Uint8Array,
  frameBytes: number = NATIVE_FRAME_BYTES
): { frames: Int16Array[]; carry: Uint8Array } {
  const merged = new Uint8Array(carry.byteLength + chunk.byteLength)
  merged.set(carry)
  merged.set(chunk, carry.byteLength)
  const frames: Int16Array[] = []
  let offset = 0
  while (merged.byteLength - offset >= frameBytes) {
    // slice() 复制到独立 buffer，可以直接按 Int16 视图读，也不会被后续写入影响
    const slice = merged.slice(offset, offset + frameBytes)
    offset += frameBytes
    frames.push(new Int16Array(slice.buffer, 0, slice.byteLength / 2))
  }
  return { frames, carry: merged.slice(offset) }
}

/** 开麦结果：是否回退到了系统默认设备 */
export interface MicOpenResult {
  stream: MediaStream
  usedDefaultDevice: boolean
}

/**
 * 打开麦克风。
 *
 * 为什么需要"回退"：Chromium 的 `deviceId` 是按 profile 加盐的哈希，
 * 权限状态变化、profile 重建、设备插拔都会让它变。应用里存的是上次选的设备 ID，
 * 用 `{ exact }` 硬约束一旦失效就抛 OverconstrainedError —— 表现是麦克风完全打不开，
 * 而界面上只会闪一行错误，「我的回答」永远是空的（很难察觉）。
 *
 * 所以：指定设备打不开时，退回系统默认设备，并让调用方知道发生了回退
 * （调用方可以顺手把失效的 deviceId 清掉，下次不再白试）。
 */
export async function openMicStream(
  deviceId?: string,
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints)
): Promise<MicOpenResult> {
  const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  /** 记录每一次尝试的结果，失败时拼进错误文本，免得只看到一句含糊的报错 */
  const attempts: string[] = []
  const nameOf = (error: unknown): string =>
    error instanceof Error && error.name ? error.name : String(error).slice(0, 40)
  /** 组装错误时保留底层 name，别让上层只能靠 parse 文本判断 */
  const micError = (lastName: string): Error => {
    const composed = new Error(`麦克风打开失败（${attempts.join('，')}）`)
    if (lastName) composed.name = lastName
    return composed
  }

  if (deviceId) {
    try {
      return { stream: await getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } }), usedDefaultDevice: false }
    } catch (error) {
      const name = nameOf(error)
      attempts.push(`指定设备 ${name}`)
      const deviceGone = name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
      // 设备确实不在了 → 回退；权限被拒等原样抛出（回退也开不了，不能掩盖真原因）
      if (!deviceGone) {
        throw micError(name)
      }
      console.warn('[AudioCapture] 指定麦克风不可用，回退默认设备：', name)
    }
  }

  /*
   * 默认设备也失败时给一次短延迟重试。
   *
   * 典型场景：设备检查刚关掉麦克风、立刻又开一次，macOS 释放 CoreAudio 设备
   * 需要一点时间，这时会抛 NotReadableError（Could not start audio source）。
   * 等一拍再来一次通常就好了 —— 不重试的话表现就是"偶尔开不了麦"。
   */
  const openDefault = async (): Promise<MediaStream> => {
    try {
      return await getUserMedia({ audio: base })
    } catch (error) {
      const name = nameOf(error)
      attempts.push(`默认设备 ${name}`)
      if (name !== 'NotReadableError' && name !== 'AbortError') {
        throw micError(name)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        return await getUserMedia({ audio: base })
      } catch (retryError) {
        const retryName = nameOf(retryError)
        attempts.push(`重试 ${retryName}`)
        throw micError(retryName)
      }
    }
  }

  return { stream: await openDefault(), usedDefaultDevice: Boolean(deviceId) }
}

/**
 * 选出 ScriptProcessor 合法的缓冲区大小。
 *
 * 硬约束来自 WebAudio：必须是 **256 ~ 16384 之间的 2 的幂**（或 0 让浏览器自己选）。
 * 之前按「原生采样率 × 0.1」算，48kHz 会得到 4800 —— 不是 2 的幂，
 * `createScriptProcessor` 直接抛异常，于是**麦克风整条链路都建不起来**
 * （表现就是 [mic] Failed to execute 'createScriptProcessor'…）。
 *
 * 取「不超过目标值的最大的 2 的幂」，既接近 100ms 的理想帧长，又一定合法：
 *   48000 → 4096（85ms）  44100 → 4096（93ms）  16000 → 1024（64ms）
 */
export function pickScriptProcessorBufferSize(nativeRate: number): number {
  const target = Math.max(256, Math.round(nativeRate * 0.1))
  let size = 256
  while (size * 2 <= Math.min(16384, target)) size *= 2
  return size
}

export class AudioCapture {
  private pipelines = new Map<AudioSource, SourcePipeline>()
  private frameHandlers: Array<(pcm: Int16Array, source: AudioSource) => void> = []
  private errorHandlers: Array<(scope: string, message: string) => void> = []
  private deviceFallbackHandlers: Array<() => void> = []
  /** 原生系统音频通道的清理函数 */
  private nativeStop: (() => void) | null = null
  private nativeLevel = 0

  onFrame(cb: (pcm: Int16Array, source: AudioSource) => void): void {
    this.frameHandlers.push(cb)
  }

  onError(cb: (scope: string, message: string) => void): void {
    this.errorHandlers.push(cb)
  }

  /** 指定的麦克风不可用、已回退到系统默认设备时触发 */
  onDeviceFallback(cb: () => void): void {
    this.deviceFallbackHandlers.push(cb)
  }

  /** 0-1 的输入电平，用于 UI 显示 */
  getLevel(): number {
    let max = this.nativeLevel
    for (const pipeline of this.pipelines.values()) max = Math.max(max, pipeline.level)
    return max
  }

  async start(opts: CaptureOptions): Promise<void> {
    if (opts.mic) {
      try {
        await this.startMic(opts.micDeviceId)
      } catch (error) {
        this.fail('mic', error)
      }
    }
    if (opts.system) {
      try {
        await this.startSystem()
      } catch (error) {
        this.fail('system', error)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.nativeStop) {
      const stop = this.nativeStop
      this.nativeStop = null
      stop()
    }
    this.nativeLevel = 0
    for (const [source, pipeline] of this.pipelines) {
      try {
        pipeline.node.disconnect()
        pipeline.source.disconnect()
        pipeline.stream.getTracks().forEach((t) => t.stop())
        await pipeline.context.close()
      } catch {
        /* 忽略重复释放 */
      }
      this.pipelines.delete(source)
    }
  }

  private async startMic(deviceId?: string): Promise<void> {
    const { stream, usedDefaultDevice } = await openMicStream(deviceId)
    if (usedDefaultDevice) {
      // 告诉上层：失效的 deviceId 该清掉了，否则每次启动都白试一次
      for (const handler of this.deviceFallbackHandlers) handler()
    }
    this.attach('mic', stream)
  }

  private async startSystem(): Promise<void> {
    const platform = await detectAudioPlatform()
    if (platform.isMacOS) return this.startNativeSystem()
    return this.startDisplayMediaSystem()
  }

  /**
   * macOS 原生通道（与原版一致）。
   *
   * 关键点：
   *  1. `start()` 返回 ok 只代表组件已拉起，必须等 ready 事件；
   *  2. 必须持续消费 data 事件，否则管道写满会把采集组件卡死；
   *  3. 数据是「流式字节」，帧边界会跨事件，要自己按 1280 字节切。
   */
  private async startNativeSystem(): Promise<void> {
    const { systemAudio } = bridge()
    if (!systemAudio) throw new Error('当前窗口不支持电脑音频采集。')

    let stopped = false
    let settled = false
    let carry: Uint8Array = new Uint8Array(0)
    const cleanups: Array<() => void> = []
    const cleanupAll = (): void => {
      while (cleanups.length) {
        const fn = cleanups.pop()
        try {
          fn?.()
        } catch {
          /* 忽略重复解绑 */
        }
      }
    }

    const handleBytes = (buffer: ArrayBuffer): void => {
      const drained = drainNativeFrames(carry, new Uint8Array(buffer))
      carry = drained.carry
      for (const pcm of drained.frames) {
        this.nativeLevel = peakOf(pcm)
        for (const handler of this.frameHandlers) handler(pcm, 'system')
      }
    }

    const ready = new Promise<void>((resolve, reject) => {
      cleanups.push(systemAudio.onReady(() => resolve()))
      cleanups.push(
        systemAudio.onError((message) => {
          if (stopped) return
          const error = new Error(describeAudioError(message))
          if (!settled) {
            reject(error)
            return
          }
          // 已经跑起来之后再出错：通知调用方并自清理
          stopped = true
          cleanupAll()
          void systemAudio.stop().catch(() => undefined)
          this.fail('system', error)
        })
      )
      cleanups.push(
        systemAudio.onData((pcm) => {
          if (!stopped) handleBytes(pcm)
        })
      )
    })
    ready.catch(() => undefined)

    const teardown = (): void => {
      stopped = true
      cleanupAll()
      void systemAudio.stop().catch(() => undefined)
    }

    try {
      const started = await systemAudio.start()
      if (!started?.ok) throw new Error(describeAudioError(started?.error))
      await withTimeout(ready, NATIVE_READY_TIMEOUT_MS, 'SYSTEM_AUDIO_START_TIMEOUT')
      settled = true
    } catch (error) {
      teardown()
      throw error instanceof Error && /^(SCREEN_|SYSTEM_AUDIO_)/.test(error.message)
        ? new Error(describeAudioError(error.message))
        : error
    }

    this.nativeStop = teardown
  }

  /**
   * 非 macOS：走 Chromium 的 loopback。
   * 视频轨必须停掉 —— 只留音频，否则屏幕采集会话会一直占着不算完。
   */
  private async startDisplayMediaSystem(): Promise<void> {
    const stream = await withTimeout(
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      15_000,
      'SCREEN_CAPTURE_TIMEOUT'
    )
    stream.getVideoTracks().forEach((track) => track.stop())
    const audioTracks = stream.getAudioTracks()
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('当前系统不支持直接采集电脑音频，请改用麦克风输入。')
    }
    this.attach('system', new MediaStream(audioTracks))
  }

  private attach(source: AudioSource, stream: MediaStream): void {
    // 不强制采样率：让浏览器用设备原生率，避免系统音频被判成静音
    const context = new AudioContext()
    const nativeRate = context.sampleRate
    // 按原生率换算 100ms 的帧长，保证每帧时间粒度一致
    // 必须是 2 的幂（WebAudio 硬约束，否则直接抛异常）
    const frameSamples = pickScriptProcessorBufferSize(nativeRate)
    const mediaSource = context.createMediaStreamSource(stream)
    const node = context.createScriptProcessor(frameSamples, 1, 1)
    // 音轨显式启用：某些设备返回的轨道默认是 disabled 的
    for (const track of stream.getAudioTracks()) track.enabled = true
    const pipeline: SourcePipeline = { context, stream, node, source: mediaSource, level: 0 }

    node.onaudioprocess = (event) => {
      const raw = event.inputBuffer.getChannelData(0)
      // 统一降到 16k（原始数据可能是 44.1k/48k）
      const input = resampleTo16k(raw, nativeRate)
      let peak = 0
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        peak = Math.max(peak, Math.abs(sample))
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      pipeline.level = peak
      for (const handler of this.frameHandlers) handler(pcm, source)
    }

    mediaSource.connect(node)
    // ScriptProcessor 需要一个输出连接才会被驱动；接一个静音增益避免回授
    const silence = context.createGain()
    silence.gain.value = 0
    node.connect(silence)
    silence.connect(context.destination)

    this.pipelines.set(source, pipeline)
  }

  private fail(scope: AudioSource, error: unknown): void {
    // DOMException 的 message 经常是空的/含糊的，name 反而最有信息量
    const message =
      error instanceof Error
        ? error.message || error.name || String(error)
        : String(error)
    for (const handler of this.errorHandlers) handler(scope, message)
  }
}
