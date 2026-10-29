import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createAsrProvider, pcmRms, type AsrProvider } from '../asr'
import { isVoiceFrame, nextNoiseFloor } from './vad'
import { DashScopeRealtimeSession, type DashScopeEvents } from '../asr/dashscope'
import { settingsStore, activeProvider } from '../store/settings'
import { runStream, cancelStream } from '../gateway/stream-manager'
import { chatComplete } from '../gateway/llm'
import { isSelf, similarity } from '../voiceprint'
import { loadProfile } from '../voiceprint/store'
import { appendQa, appendTranscript, attachMyAnswer, createSession } from '../ipc/data'
import { retrieveContext } from '../knowledge'
import { contextByPurpose } from '../knowledge'
import { getWindow } from '../windows'
import type { ChatDelta, ChatMessage, LiveState, QaRecord, SessionKind, SessionRecord, TranscriptSegment } from '@shared/types'

/**
 * 实时会话编排器：音频 → 识别 → 问题拼接 → 生成答案。
 *
 * 事件（通过 EventEmitter 发出，由 ipc/live.ts 转发到窗口）：
 *   state        (LiveState)
 *   transcript   (TranscriptSegment)
 *   answerDelta  ({ qaId, delta })
 *   answerDone   ({ record })
 *   security     (reason)
 *   error        ({ scope, message })
 */

const SAMPLE_RATE = 16000

interface SourceBuffer {
  chunks: Buffer[]
  bytes: number
  lastVoiceAt: number
  /**
   * 自适应噪声基底（RMS）。
   *
   * 原版只用固定阈值 150/32768 更新「最后说话时间」，切分交给服务端 VAD。
   * 本地没有服务端 VAD 时，固定绝对阈值在两种场景都会出错：
   *   · 视频/音乐：能量一直高于阈值 → 永不触发静音切分 → 一直攒到硬上限才切
   *   · 轻声/远场：能量低于阈值 → 被判成噪声
   * 所以改成跟踪噪声基底，用「显著高于基底」来判有语音。
   */
  noiseFloor: number
}

function emptyBuffer(): SourceBuffer {
  return { chunks: [], bytes: 0, lastVoiceAt: 0, noiseFloor: 0 }
}

/** 常见录屏/共享软件进程名，用于安全模式启发式检测 */
const RECORDER_PATTERNS = [
  'zoom.us',
  'TencentMeeting',
  'wemeet',
  'feishu',
  'Lark',
  'DingTalk',
  'Microsoft Teams',
  'obs',
  'ScreenFlow',
  'Camtasia',
  'QuickTime Player',
  'Recordit',
  'Loom'
]

/* ------------------------------------------------------------------ *
 * 对话上下文
 * ------------------------------------------------------------------ */

/**
 * 默认带多少轮历史问答。
 *
 * 依据：原版工作流的 LLM 节点 `memory.window.size` 默认就是 **10**，
 * 并且 `role_prefix` 明确区分 user / assistant —— 也就是说它会把
 * 「上一轮问了什么、自己答了什么」作为真正的对话轮次回传，
 * 而不是只塞一段原始转写。
 */
const DEFAULT_MEMORY_ROUNDS = 10

/**
 * 发给模型的历史上下文总字符预算。
 *
 * 为什么要有：长面试（几十轮）逐轮累加会把提示词撑到几万 token，
 * 首字延迟和费用都会失控。所以除了轮数上限，再加一道字符预算。
 */
const CONTEXT_CHAR_BUDGET = 6000
/**
 * 简历整份注入的字符上限。
 *
 * 简历通常 1~3k 字，正常不会被截；设上限是防止有人把整本简历库塞进来
 * 把提示词撑爆。超了保留头部 —— 简历一般是倒序的，头部就是基本信息 + 最近经历，
 * 正是面试最常问的部分。
 */
const RESUME_CONTEXT_MAX_CHARS = 3000
/** 「我实际回答」保留策略：首部（结论/立场）+ 尾部（补充/收尾），中间例子可丢 */
const MY_ANSWER_HEAD = 220
const MY_ANSWER_TAIL = 230
/** 「上次给的建议」只留开头，够判断方向即可 */
const ADVICE_MAX = 500

/**
 * 首尾截断。
 *
 * 为什么不是简单取开头：人的回答结构是「先给结论 → 中间举例 → 最后补充」，
 * 追问通常打在结论和最后一句补充上，中间的例子反而最不重要。
 * 这个策略零延迟、零 token，却能覆盖大部分"摘要"的价值。
 */
function clipMiddle(text: string, head: number, tail: number): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= head + tail + 10) return clean
  // 注意：tail 为 0 时绝不能写 clean.slice(-0) —— 那是 slice(0)，等于整段。
  const tailPart = tail > 0 ? clean.slice(-tail) : ''
  return tailPart ? `${clean.slice(0, head)}…（中略）…${tailPart}` : `${clean.slice(0, head)}…`
}

/**
 * 一轮问答：面试官问了什么、我实际答了什么、当时给了什么建议。
 *
 * 三者缺一不可 —— 只给建议不知道自己答了什么，模型会重复建议；
 * 只给转写没有建议，模型不知道上一轮的口径。
 */
interface LiveTurn {
  question: string
  /** 我在这一轮里说的话（麦克风转写累积） */
  answerText: string
  /** 当时生成的建议答案 */
  advice: string
  qaId?: string
}

class LiveOrchestrator extends EventEmitter {
  /** 已结束的轮次（用于组上下文，内存里只留最近若干轮） */
  private turns: LiveTurn[] = []
  /** 正在进行的这一轮（面试官刚问、我还没答完） */
  private currentTurn: LiveTurn | null = null

  private state: LiveState = {
    hearing: false,
    audioFrames: 0,
    audioLevel: 0,
    streamingConnected: false,
    streamingError: '',
    running: false,
    pendingQuestion: '',
    lastTranscript: '',
    accumulated: '',
    questionTranslation: '',
    autoStopped: false,
    voiceprintEnrolled: false,
    streaming: false,
    gateway: 'unknown',
    asr: 'idle',
    securityAlert: '',
    sessionId: null
  }

  private session: SessionRecord | null = null
  private asr: AsrProvider | null = null
  private buffers: Record<'mic' | 'system', SourceBuffer> = { mic: emptyBuffer(), system: emptyBuffer() }
  private segmentQueue: Promise<void> = Promise.resolve()
  /**
   * 流式识别会话（阿里云百炼实时识别）。
   *
   * 对齐原版：音频**连续推**，不做本地切分；
   * 中间结果（sentence_end=false）只更新界面，定稿（sentence_end=true）才进提问链路。
   * 随思客户端拿到的就是 {isFinal, segId}，处理方式与此一致。
   * 每个音频源一条会话（麦克风 / 电脑音频分开，避免混流出错）。
   */
  private streaming = new Map<'mic' | 'system', DashScopeRealtimeSession>()
  /** 每个源的流式连接是否就绪 */
  private streamingReady = new Set<'mic' | 'system'>()
  /** 重连计数，用于退避 */
  private streamingRetry = new Map<'mic' | 'system', number>()
  /** 累计收到的音频帧数（自检用） */
  private audioFrames = 0
  private commitTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private securityTimer: NodeJS.Timeout | null = null
  private currentQaId: string | null = null
  private pendingAnswer = { text: '', reasoning: '' }
  /** 正在拼接中的待回答问题 */
  private pendingQuestion = ''
  /** 最近一次有人说话的时间，用于「无人发言自动停止采集」 */
  private lastVoiceAt = 0
  /** 题目翻译的请求序号，避免乱序覆盖 */
  private translationSeq = 0
  /** 缓存的声纹模板（启动/切换时刷新，避免每段音频都读盘） */
  private voiceprintProfile: ReturnType<typeof loadProfile> = null
  /** 最近一次声纹相似度，供调试与界面展示 */
  private lastVoiceprintScore = 0

  /* ---------------- 生命周期 ---------------- */

  start(kind: SessionKind = 'meeting', title?: string): LiveState {
    if (this.state.running) return this.state

    const settings = settingsStore.get()
    this.asr = createAsrProvider(settings.asr)
    this.streamingRetry.clear()
    this.audioFrames = 0
    this.setState({ audioFrames: 0, audioLevel: 0, streamingConnected: false, streamingError: '' })
    // 传了标题就用标题；否则留「未命名会话」，首次问答后由 appendQa 自动命名
    this.session = createSession(kind, title?.trim() || undefined)
    this.buffers = { mic: emptyBuffer(), system: emptyBuffer() }
    this.pendingQuestion = ''
    this.currentQaId = null
    // 新会话不继承上一场的轮次上下文
    this.turns = []
    this.currentTurn = null
    // 每次开新会话时刷新声纹模板（用户可能刚录入）
    this.voiceprintProfile = loadProfile()

    this.state = {
      ...this.state,
      running: true,
      asr: 'listening',
      voiceprintEnrolled: Boolean(this.voiceprintProfile),
      sessionId: this.session.id,
      gateway: activeProvider()?.baseUrl ? 'ok' : 'unknown',
      streaming: false,
      securityAlert: ''
    }
    this.emit('state', this.state)

    // 定时检查静音切分与安全模式
    /*
     流式通道：会话需要一开始就建好，音频才能连续推。
     只给开启的音频源建，避免无谓计费。
     */
    if (settings.asr.kind === 'dashscope-realtime') {
      if (settings.audio.micEnabled) this.startStreaming('mic')
      if (settings.audio.systemAudioEnabled) this.startStreaming('system')
      this.setState({ asr: 'listening' })
    }

    this.tickTimer = setInterval(() => this.tick(), 200)
    this.securityTimer = setInterval(() => void this.checkEnvironment(), 4000)
    return this.state
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.securityTimer) clearInterval(this.securityTimer)
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.tickTimer = null
    this.securityTimer = null
    this.commitTimer = null

    // 收尾：把残留音频也识别掉
    this.flush('mic', true)
    this.flush('system', true)
    // 最后一轮也要把"我实际回答了什么"落库
    this.closeTurn()
    if (this.currentQaId) cancelStream(this.currentQaId)

    this.state = {
      ...this.state,
      running: false,
      asr: 'idle',
      streaming: false,
      autoStopped: false,
      questionTranslation: '',
      accumulated: ''
    }
    this.emit('state', this.state)
  }

  getState(): LiveState {
    return this.state
  }

  /* ---------------- 流式识别（阿里云百炼实时识别） ---------------- */

  /**
   * 建立流式会话。
   *
   * 与原版一致的分工：
   *   · 中间结果 → 只更新界面（lastTranscript），让用户看到「边说边出字」
   *   · 定稿结果 → 当作一条转写片段，走原有的提问判定与合并链路
   */
  private startStreaming(source: 'mic' | 'system'): void {
    const provider = this.asr as unknown as {
      kind?: string
      startSession?: (events: DashScopeEvents) => DashScopeRealtimeSession
    }
    // 只有流式通道有 startSession；批量通道没有，直接跳过
    if (provider?.kind !== 'dashscope-realtime' || typeof provider.startSession !== 'function') return
    const factory = provider as { startSession: (events: DashScopeEvents) => DashScopeRealtimeSession }
    const session = factory.startSession({
      onStarted: () => {
        this.streamingReady.add(source)
        this.streamingRetry.set(source, 0)
        this.setState({ streamingConnected: true, streamingError: '' })
      },
      onPartial: (text: string) => {
        /*
         * 中间结果：只在界面上显示，不触发提问（原版 isFinal=false 的处理）。
         * hearing=true 让界面出现「正在识别」的实时行。
         */
        this.setState({ lastTranscript: text, hearing: true })
      },
      onFinal: (text: string) => {
        this.setState({ hearing: false })
        this.ingestStreamingFinal(text, source)
      },
      onFinished: () => {
        this.setState({ hearing: false })
      },
      onError: (message: string) => {
        this.setState({ streamingConnected: false, streamingError: message })
        this.emit('error', { scope: 'asr', message })
        /*
         * 会话是**跑到一半**才断的（例如服务端 NO_INPUT_AUDIO_ERROR、网络抖动），
         * 这种情况以前只提示不重连 —— 之后所有音频都被静默丢进死连接，
         * 表现就是「第一句还能识别，后面全没了」。这里补上重连。
         *
         * 只在「已经就绪过」时重连：启动阶段失败会走 start() 的 reject，
         * 两边都排重连会把重试次数平白翻倍。
         */
        if (this.streamingReady.has(source)) this.scheduleStreamingRetry(source)
      }
    })
    this.streaming.set(source, session)
    session.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ streamingConnected: false, streamingError: message })
      this.emit('error', { scope: 'asr', message })
      this.scheduleStreamingRetry(source)
    })
  }

  /**
   * 这句话是不是「我自己」说的。
   *
   * 判定顺序：
   *   1. 声纹明确给了结论就用它（线下场景只有麦克风时唯一的依据）
   *   2. 否则看音源：同时采集电脑音频时，麦克风就是我方、系统音频就是对方
   *   3. 只开麦克风（面对面）且没开声纹时，无法区分 —— 一律按对方处理，
   *      宁可多答一句，也不要把真正的问题吞掉
   */
  private isOwnVoice(source: 'mic' | 'system', speaker?: 'self' | 'other'): boolean {
    if (speaker === 'self') return true
    if (speaker === 'other') return false
    return source === 'mic' && settingsStore.get().audio.systemAudioEnabled
  }

  /** 把我说的话累积到当前轮里 */
  private appendMyAnswer(text: string): void {
    const clean = text.trim()
    if (!clean) return
    if (!this.currentTurn) {
      // 还没提问就说话（例如面试官寒暄阶段的回应）：开一个无名轮兜住
      this.currentTurn = { question: '', answerText: '', advice: '' }
    }
    this.currentTurn.answerText = this.currentTurn.answerText
      ? `${this.currentTurn.answerText} ${clean}`
      : clean
  }

  /**
   * 结束当前轮：把「我实际回答了什么」回填到对应的问答记录，并归档进上下文。
   * 在下一句问题提交时调用（此时我的回答已经说完了）。
   */
  private closeTurn(): void {
    const turn = this.currentTurn
    this.currentTurn = null
    if (!turn) return
    if (turn.answerText && this.session && turn.qaId) {
      // 落盘字段留长一点（复盘要看），发送给模型时再按预算截断
      attachMyAnswer(this.session.id, turn.qaId, turn.answerText.slice(0, 4000))
    }
    if (turn.question || turn.answerText) this.turns.push(turn)
    // 内存里最多留 40 轮，避免超长会议无限增长
    if (this.turns.length > 40) this.turns.splice(0, this.turns.length - 40)
  }

  /** 流式定稿 → 复用既有的转写落库与提问判定链路 */
  private ingestStreamingFinal(text: string, source: 'mic' | 'system'): void {
    const clean = text.trim()
    if (!clean) return
    const segment: TranscriptSegment = {
      id: randomUUID(),
      text: clean,
      source,
      startMs: Date.now(),
      endMs: Date.now(),
      final: true
    }
    if (this.session) appendTranscript(this.session.id, segment)
    this.emit('transcript', segment)
    this.setState({ lastTranscript: clean, asr: 'listening' })

    /*
     * 分流：我说的话只用来构建上下文，**绝不能当成问题去提问**。
     * 以前不区分音源，开了麦克风之后会把自己说的内容也拿去问模型。
     */
    if (this.isOwnVoice(source)) {
      this.appendMyAnswer(clean)
      return
    }
    this.stitch(clean)
  }

  /** 断线重连（指数退避，最多 5 次） */
  private scheduleStreamingRetry(source: 'mic' | 'system'): void {
    if (!this.state.running) return
    const attempt = this.streamingRetry.get(source) ?? 0
    if (attempt >= 5) return
    this.streamingRetry.set(source, attempt + 1)
    const delay = Math.min(8000, 500 * 2 ** attempt)
    setTimeout(() => {
      if (!this.state.running) return
      this.streaming.get(source)?.close()
      this.streaming.delete(source)
      this.streamingReady.delete(source)
      this.startStreaming(source)
    }, delay)
  }

  private stopStreaming(): void {
    for (const session of this.streaming.values()) session.close()
    this.streaming.clear()
    this.streamingReady.clear()
  }

  /* ---------------- 音频输入 ---------------- */

  pushAudio(pcm: Buffer, source: 'mic' | 'system'): void {
    if (!this.state.running || !pcm?.length) return
    const settings = settingsStore.get()
    if (source === 'mic' && !settings.audio.micEnabled) return
    if (source === 'system' && !settings.audio.systemAudioEnabled) return

    /*
     * 流式通道（阿里云百炼）：音频直接推进长连接，不做本地缓冲与切分。
     * 这正是原版的做法 —— `y.sendAudio(c, "mic")` 对每一帧无条件发送，
     * 断句由服务端的 VAD/语义断句负责，客户端只负责显示与合并。
     */
    /*
     * 采集统计（帧数/音量）在早退之前统计，任何通道都能拿到。
     *
     * 这里**不再往终端打日志**：它每 10 帧（约 1 秒）打一行，
     * 会议全程会把终端刷满。需要排障时读 live.state() 或设置页的「检测电脑音频」。
     *
     * 状态广播也降到「第一帧 + 每 100 帧（约 10 秒）」：
     * 界面上已经不再常驻显示这两个值，没必要让每个窗口每秒重渲染一次。
     */
    this.audioFrames++
    const level = pcmRms(pcm)
    if (this.audioFrames === 1 || this.audioFrames % 100 === 0) {
      this.setState({ audioFrames: this.audioFrames, audioLevel: level })
    }

    const session = this.streaming.get(source)
    if (session) {
      session.push(pcm)
      return
    }

    const buf = this.buffers[source]
    buf.chunks.push(pcm)
    buf.bytes += pcm.length

    /*
     * 能量判定只用来更新「最后说话时间」（对齐原版的用法）。
     *
     * 判据是「显著高于噪声基底」而不是一个固定绝对阈值：
     * 固定阈值对视频/音乐永远成立（永不切分），对轻声又过于苛刻。
     * 基底用慢速滑动平均估计，遇到更安静的环境会跟着降下来。
     */
    const rms = pcmRms(pcm)
    /*
     * 噪声基底：快速跟随「更安静」，极慢回升。
     *
     * 曾经用第一帧的 RMS 初始化基底，结果是——如果音频一开始就是人声，
     * 基底直接等于人声能量，`rms > floor*2.2` 永远不成立，
     * 于是一路判不出「有语音」，只能靠硬上限切分（自测抓到的真实 bug）。
     * 正确做法：初值取「当前值与一个很小的先验的较小者」，之后只快速下降、缓慢上升。
     */
    buf.noiseFloor = nextNoiseFloor(buf.noiseFloor, rms)
    const isVoice = isVoiceFrame(rms, buf.noiseFloor)
    if (isVoice) {
      buf.lastVoiceAt = Date.now()
      this.lastVoiceAt = buf.lastVoiceAt
      // 新的一段发言到来时解除自动停止状态
      if (this.state.autoStopped) this.setState({ autoStopped: false })
    }
  }

  /* ---------------- 定时任务 ---------------- */

  private tick(): void {
    const tuning = settingsStore.get().asrTuning
    const now = Date.now()

    // 无人发言自动停止采集（原版：「超过设定时间无人发言，系统将自动关闭声音录入」）
    if (tuning.silenceAutoStopSec > 0 && this.lastVoiceAt > 0 && !this.state.autoStopped) {
      const idleSec = (now - this.lastVoiceAt) / 1000
      if (idleSec >= tuning.silenceAutoStopSec) {
        this.autoStop()
        return
      }
    }
    for (const source of ['mic', 'system'] as const) {
      const buf = this.buffers[source]
      if (!buf.bytes) continue
      const durationMs = (buf.bytes / 2 / SAMPLE_RATE) * 1000
      const silentFor = now - (buf.lastVoiceAt || now)
      const hasVoice = buf.lastVoiceAt > 0

      if (durationMs >= tuning.maxSegmentMs) {
        this.flush(source)
      } else if (hasVoice && durationMs >= tuning.minSegmentMs && silentFor >= tuning.silenceMs) {
        this.flush(source)
      }
      /*
       * 这里原本有一个「纯噪声直接丢弃」的分支 —— 那是错的：
       * 阈值偏高时，视频音乐、轻声、远场说话全都会被判成噪声整段丢掉，
       * 用户感受就是「识别不准 / 少了大半内容」。
       * 现在一律送去识别：真是静音的话 whisper 会返回空串，代价只是几毫秒，
       * 而丢音频是不可逆的信息损失。
       */
    }
  }

  /** 把累计音频送去识别；force=true 时忽略最短时长限制 */
  private flush(source: 'mic' | 'system', force = false): void {
    const buf = this.buffers[source]
    if (!buf.bytes || !this.asr) return
    const tuning = settingsStore.get().asrTuning
    const durationMs = (buf.bytes / 2 / SAMPLE_RATE) * 1000
    if (!force && durationMs < tuning.minSegmentMs) return

    const pcm = Buffer.concat(buf.chunks, buf.bytes)
    const startedAt = Date.now() - durationMs
    buf.chunks = []
    buf.bytes = 0
    buf.lastVoiceAt = 0

    // 串行化识别请求，避免并发打爆网关
    this.segmentQueue = this.segmentQueue.then(async () => {
      if (!this.asr) return
      this.setState({ asr: 'transcribing' })
      try {
        const text = await this.asr.transcribe(pcm, { hotwords: tuning.hotwords, language: settingsStore.get().asr.language })
        if (!text) return

        /*
         * 声纹过滤：判定这段音频是不是「自己」在说话。
         * 开启且已录入时才判定；判定失败（模块异常）一律当作他人，避免静默吞掉问题。
         */
        const vp = settingsStore.get().voiceprint
        const profile = vp.enabled ? this.voiceprintProfile : null
        /*
         * 只有够长的片段才做声纹判定。
         * 实测依据：1.2 秒的片段做声纹会得到 d²≈14.7（远超同人基线），被判成他人；
         * 也就是说短片段上声纹既不可靠、又可能把「别人的提问」误判成自己而静默丢弃。
         * 因此短片段直接跳过判定（按他人处理），保证问题不会被吞掉。
         */
        const voiceprintReliable = durationMs >= 1500
        let speaker: 'self' | 'other' | undefined
        if (profile && voiceprintReliable) {
          try {
            speaker = isSelf(profile, pcm, vp.threshold) ? 'self' : 'other'
            this.lastVoiceprintScore = similarity(profile, pcm)
          } catch (error) {
            console.warn('[live] 声纹判定失败，按他人处理：', error instanceof Error ? error.message : error)
            speaker = 'other'
          }
        }

        const segment: TranscriptSegment = {
          id: randomUUID(),
          text,
          source,
          startMs: startedAt,
          endMs: startedAt + durationMs,
          final: true,
          speaker
        }
        // 自己的发言按设置决定是否保留在上下文（原版：会记录在上下文中）
        if (this.session && (speaker !== 'self' || vp.keepInContext)) appendTranscript(this.session.id, segment)
        this.emit('transcript', segment)
        this.setState({ lastTranscript: text, asr: 'listening', voiceprintEnrolled: Boolean(profile) })

        // 我说的话只进上下文，不作为提问来源
        if (this.isOwnVoice(source, speaker)) {
          this.appendMyAnswer(text)
          return
        }
        this.stitch(text)
      } catch (error) {
        this.setState({ asr: 'error' })
        this.emit('error', { scope: 'asr', message: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  /* ---------------- 问题拼接 ---------------- */

  /**
   * 把连续的识别片段拼成一个完整问题。
   * 策略：片段累加，静音达到 1.5 倍阈值或出现问号即提交。
   */
  private stitch(text: string): void {
    const clean = text.trim()
    if (!clean) return

    const tuning = settingsStore.get().asrTuning

    /*
     * 累积转写模式：语音累计成一条，不自动提交，等用户点击发送。
     * 对齐原版：「开启后语音累计成一条，点击气泡才发送给 AI」。
     */
    if (tuning.cumulative) {
      this.pendingQuestion = this.pendingQuestion ? `${this.pendingQuestion} ${clean}` : clean
      const tooLong = this.pendingQuestion.length > 2000
      this.setState({
        pendingQuestion: this.pendingQuestion,
        accumulated: this.pendingQuestion
      })
      if (tooLong) {
        // 原版：「累计转写内容过长，请先发送当前内容」
        this.emit('error', { scope: 'cumulative', message: '累计转写内容过长，请先发送当前内容' })
      }
      return
    }

    this.pendingQuestion = this.pendingQuestion ? `${this.pendingQuestion} ${clean}` : clean
    this.setState({ pendingQuestion: this.pendingQuestion, accumulated: this.pendingQuestion })

    if (this.commitTimer) clearTimeout(this.commitTimer)
    const delay = Math.max(600, tuning.silenceMs * 1.5)
    const endsWithQuestion = /[?？]$/.test(clean)
    this.commitTimer = setTimeout(() => this.commitQuestion(), endsWithQuestion ? Math.min(delay, 500) : delay)
  }

  private commitQuestion(): void {
    const question = this.pendingQuestion.trim()
    if (!question) return
    const tuning = settingsStore.get().asrTuning

    // 关闭自动出答案时，把问题留在待答区等用户手动发送，不能丢掉
    if (!tuning.autoAnswer) return
    if (question.length < tuning.autoAnswerMinChars) return

    this.pendingQuestion = ''
    this.setState({ pendingQuestion: '' })
    void this.ask(question, 'auto')
  }

  /* ---------------- 生成答案 ---------------- */

  /**
   * 生成答案。
   * @param question 指定问题；不传则使用当前待答问题
   * @param trigger  来源标记，用于记录里区分自动/手动/截图
   */
  async ask(question?: string, trigger: QaRecord['trigger'] = 'manual'): Promise<void> {
    if (!this.state.running && !question) return
    const provider = activeProvider()
    if (!provider?.baseUrl) {
      this.emit('error', { scope: 'gateway', message: '未配置模型网关，请到「设置 → 模型网关」填写' })
      return
    }

    const prompt = (question ?? this.pendingQuestion).trim()
    if (!prompt) return
    // 新一轮开始 = 上一轮结束：把我的回答归到上一轮，并归档进上下文
    this.closeTurn()
    this.currentTurn = { question: prompt, answerText: '', advice: '' }
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.pendingQuestion = ''
    /*
     * 一并清空 accumulated。
     * 累积转写模式下这两个字段是同一份内容的两个视图：
     * 只清 pendingQuestion 会让界面气泡一直留着刚发出去的文字
     * （原版语义是「确认后再发送」，发送完气泡应当清掉）。
     */
    this.setState({ pendingQuestion: '', accumulated: '' })

    /*
     * 打断上一条还没跑完的答案。
     *
     * 必须显式通知界面「这条已经不会再出内容了」：否则那张卡片会一直停在
     * 「生成中」，看起来像卡死；而且 state.streaming 也永远回不到 false。
     */
    if (this.currentQaId) {
      const aborted = this.currentQaId
      cancelStream(aborted)
      this.emit('answerAborted', { qaId: aborted })
    }
    const qaId = randomUUID()
    this.currentQaId = qaId
    this.pendingAnswer = { text: '', reasoning: '' }
    this.setState({ streaming: true })
    /*
     * 先把题目推给界面再开始生成。
     * 首字可能要等好几秒（实测 8s 量级），这段时间界面上若没有题目，
     * 就是一张空白卡片 —— 用户会以为「第二句没回答」。
     */
    this.emit('answerStart', { qaId, question: prompt, trigger })

    // 题目翻译：只影响展示，不改变发送给模型的原题
    void this.translateQuestion(prompt)

    const messages = await this.buildMessages(prompt)
    runStream(
      { requestId: qaId, provider, messages },
      {
        onDelta: (delta: ChatDelta) => {
          if (delta.kind === 'content') this.pendingAnswer.text += delta.text
          else this.pendingAnswer.reasoning += delta.text
          this.emit('answerDelta', { qaId, delta })
        },
        onDone: (result) => {
          const record: QaRecord = {
            id: qaId,
            question: prompt,
            answer: result.text,
            reasoning: result.reasoning || undefined,
            createdAt: Date.now(),
            trigger
          }
          if (this.session) appendQa(this.session.id, record)
          /*
           * 把这一条建议挂到对应轮次上。
           * 通常此时 currentTurn 就是它；但如果我在建议还没生成完就开始回答、
           * 下一句问题又提前到了，这条会落到已归档的轮次里 —— 两种都要覆盖。
           */
          const turn =
            this.currentTurn?.question === prompt
              ? this.currentTurn
              : [...this.turns].reverse().find((item) => item.question === prompt && !item.advice)
          if (turn) {
            turn.qaId = qaId
            turn.advice = result.text
            if (turn.answerText && this.session) {
              attachMyAnswer(this.session.id, qaId, turn.answerText.slice(0, 4000))
            }
          }
          this.currentQaId = null
          this.setState({ streaming: false })
          this.emit('answerDone', {
            record,
            firstTokenMs: result.firstTokenMs,
            totalMs: result.totalMs
          })
        },
        onError: (message: string) => {
          this.currentQaId = null
          this.setState({ streaming: false })
          this.emit('error', { scope: 'llm', message })
        }
      }
    )
  }

  /** 组装 prompt：角色设定 + 知识库召回 + 最近转写上下文 */
  private async buildMessages(question: string): Promise<ChatMessage[]> {
    const settings = settingsStore.get()
    const agent = settings.agents.find((a) => a.id === settings.activeAgentId) ?? settings.agents[0]

    const parts: string[] = []
    if (agent?.persona) parts.push(`【角色】\n${agent.persona}`)
    if (agent?.style) parts.push(`【风格】\n${agent.style}`)
    parts.push(
      '【要求】\n直接给出可以照着念的答案，不要复述问题，不要输出“作为AI”之类的话。信息不足时给出可用的框架性回答。'
    )

    /*
     * 简历：整份注入，而不是按问题检索。
     * 面试里大量问题都是「介绍一下你自己 / 讲讲你的项目」这类，
     * 用相似度检索反而不稳（问题里不含简历里的关键名词时捞不到）。
     */
    const resume = contextByPurpose('resume', RESUME_CONTEXT_MAX_CHARS)
    if (resume) {
      parts.push(`【我的简历 / 背景】（回答时以这里的事实为准，不要编造经历）\n${resume}`)
    }

    // 知识库召回（失败静默降级）
    if (agent?.knowledgeBaseIds?.length) {
      const chunks = await retrieveContext(agent.knowledgeBaseIds, question, 4)
      if (chunks.length) {
        parts.push(
          `【参考资料】\n${chunks.map((c, i) => `[${i + 1}] ${c.docName}：${c.text}`).join('\n')}\n请优先依据以上资料回答。`
        )
      }
    }

    /*
     * 历史轮次：最近几轮「面试官问了什么 / 我实际怎么答的 / 当时建议了什么」。
     *
     * 面试的追问几乎都锚定在上一轮的具体细节上（尤其是项目拆解：
     * "你刚说用了 Redis，那缓存一致性怎么保证"），所以必须带上"我实际说了什么"，
     * 否则模型只能凭上一轮的建议重答一遍，前后会打架。
     *
     * 两道闸：轮数上限（memoryRounds）+ 总字符预算，谁先到算谁。
     */
    const rounds = Math.max(0, agent?.memoryRounds ?? DEFAULT_MEMORY_ROUNDS)
    const window: LiveTurn[] = []
    let used = 0
    if (rounds > 0) {
      for (let i = this.turns.length - 1; i >= 0 && window.length < rounds; i--) {
        const turn = this.turns[i]
        if (!turn.question && !turn.answerText) continue
        const cost =
          turn.question.length +
          Math.min(turn.answerText.length, MY_ANSWER_HEAD + MY_ANSWER_TAIL) +
          Math.min(turn.advice.length, ADVICE_MAX)
        // 至少留最近一轮，否则完全失去连贯性
        if (window.length > 0 && used + cost > CONTEXT_CHAR_BUDGET) break
        window.unshift(turn)
        used += cost
      }
    }

    const history: ChatMessage[] = []
    for (const turn of window) {
      const said: string[] = []
      if (turn.question) said.push(`面试官：${turn.question}`)
      if (turn.answerText) said.push(`我实际回答：${clipMiddle(turn.answerText, MY_ANSWER_HEAD, MY_ANSWER_TAIL)}`)
      history.push({ role: 'user', content: said.join('\n') })
      if (turn.advice) history.push({ role: 'assistant', content: clipMiddle(turn.advice, ADVICE_MAX, 0) })
    }

    return [
      { role: 'system', content: parts.join('\n\n') },
      ...history,
      { role: 'user', content: question }
    ]
  }

  /**
   * 无人发言达到阈值后自动停止采集。
   * 只停「声音录入」，会话本身保留，用户可随时继续。
   */
  private autoStop(): void {
    if (this.state.autoStopped || !this.state.running) return
    // 把残留音频先识别掉，避免丢掉最后一句
    this.flush('mic', true)
    this.flush('system', true)
    this.buffers = { mic: emptyBuffer(), system: emptyBuffer() }
    this.setState({ autoStopped: true, asr: 'idle' })
    this.emit('autoStop', { seconds: settingsStore.get().asrTuning.silenceAutoStopSec })
  }

  /** 从自动停止状态恢复采集 */
  resumeFromAutoStop(): LiveState {
    if (!this.state.autoStopped) return this.state
    this.lastVoiceAt = Date.now()
    this.buffers = { mic: emptyBuffer(), system: emptyBuffer() }
    this.setState({ autoStopped: false, asr: 'listening' })
    return this.state
  }

  /** 声纹录入完成后刷新缓存 */
  refreshVoiceprint(): void {
    this.voiceprintProfile = loadProfile()
    this.setState({ voiceprintEnrolled: Boolean(this.voiceprintProfile) })
  }

  /** 最近一次声纹相似度（调试/展示用） */
  voiceprintScore(): number {
    return this.lastVoiceprintScore
  }

  /** 累积转写模式下手动发送当前累计内容 */
  sendAccumulated(): void {
    const text = this.pendingQuestion.trim()
    if (!text) return
    if (this.commitTimer) clearTimeout(this.commitTimer)
    void this.ask(text, 'manual')
  }

  /** 清空累计转写（原版：「清空累计转写」） */
  clearAccumulated(): void {
    this.pendingQuestion = ''
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.setState({ pendingQuestion: '', accumulated: '' })
  }

  /**
   * 题目翻译：仅翻译题目用于展示，AI 仍用原题作答。
   * 翻译失败不影响主流程（静默降级，只是没有译文）。
   */
  private async translateQuestion(question: string): Promise<void> {
    const settings = settingsStore.get()
    if (!settings.translate.enabled) {
      this.setState({ questionTranslation: '' })
      return
    }
    const provider = activeProvider()
    if (!provider?.baseUrl) return

    const seq = ++this.translationSeq
    try {
      const result = await chatComplete({
        provider,
        messages: [
          {
            role: 'system',
            content:
              '你是翻译引擎。把用户给出的句子翻译成目标语言，只输出译文本身，' +
              '不要解释、不要加引号、不要保留原文。如果原文已经是目标语言，原样返回。'
          },
          { role: 'user', content: `目标语言：${settings.translate.target}\n\n${question}` }
        ],
        maxTokens: 512
      })
      // 只有最新一次翻译才允许写入，避免快速连问时旧结果覆盖新结果
      if (seq !== this.translationSeq) return
      this.setState({ questionTranslation: result.text.trim() })
    } catch (error) {
      console.warn('[live] 题目翻译失败（不影响作答）：', error instanceof Error ? error.message : error)
    }
  }

  clear(): void {
    this.pendingQuestion = ''
    // 清空上下文：把最后一轮尽量收尾落库，然后丢弃轮次
    this.closeTurn()
    this.turns = []
    if (this.currentQaId) cancelStream(this.currentQaId)
    this.currentQaId = null
    this.stopStreaming()
    this.setState({
      pendingQuestion: '',
      accumulated: '',
      lastTranscript: '',
      hearing: false,
      streaming: false,
      questionTranslation: ''
    })
    if (this.state.running) {
      this.session = createSession('meeting')
      this.setState({ sessionId: this.session.id })
    }
  }

  /* ---------------- 环境安全（启发式） ---------------- */

  /**
   * 检测录屏/共享软件。这里用进程名启发式：无法覆盖所有情况，
   * 但能在最常见的会议/录屏场景下给出提示。窗口层面的防录屏由
   * setContentProtection 负责（见 windows.ts）。
   */
  private async checkEnvironment(): Promise<void> {
    if (process.platform !== 'darwin') return
    try {
      const { exec } = await import('node:child_process')
      const output = await new Promise<string>((resolve) => {
        exec('ps -axo comm', { timeout: 3000 }, (_err, stdout) => resolve(stdout ?? ''))
      })
      const hits = RECORDER_PATTERNS.filter((name) => output.includes(name))
      const settings = settingsStore.get()
      const reason = hits.length && settings.stealth.safeMode ? `检测到录屏/共享软件：${hits.join('、')}` : ''
      if (reason !== this.state.securityAlert) {
        this.setState({ securityAlert: reason })
        if (reason) {
          this.emit('security', reason)
          // 安全模式：主动把悬浮窗藏起来
          getWindow('floating')?.hide()
        }
      }
    } catch {
      /* 检测失败不影响主流程 */
    }
  }

  private setState(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }
}

export const live = new LiveOrchestrator()
