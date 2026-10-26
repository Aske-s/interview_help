/**
 * 全局共享类型契约（主进程 / 预加载 / 渲染进程共用）
 *
 * 约定：本文件是"接口冻结区"。所有跨进程数据结构必须先在这里定义，
 * 各工作流不得各自发明相似结构。
 */

/* ------------------------------------------------------------------ *
 * 模型网关
 * ------------------------------------------------------------------ */

/**
 * 推理强度。取值与 OpenAI Codex 的 `model_reasoning_effort` 完全一致
 * （codex-rs/protocol/src/openai_models.rs 的 ReasoningEffort 枚举）。
 * 'auto' 表示不发送该参数，交给网关/模型用默认值。
 */
export type ReasoningEffort = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** OpenAI 兼容的对话模型配置 */
export interface ProviderConfig {
  id: string
  /** 展示名，如 "DeepSeek 官方" */
  name: string
  /** 形如 https://api.deepseek.com/v1 （不带结尾斜杠） */
  baseUrl: string
  apiKey: string
  /** 默认对话模型，如 deepseek-chat */
  model: string
  /** 是否支持图片输入（截图解题需要） */
  supportsVision: boolean
  /** 推理强度；现在的新模型基本不再使用 temperature，而是用它控制思考深度 */
  reasoningEffort: ReasoningEffort
  /**
   * 可选：temperature。留空则不发送该参数——
   * 推理模型（o 系列 / gpt-5 / deepseek-reasoner 等）通常不接受 temperature，
   * 硬发可能被网关拒绝或静默忽略。
   */
  temperature?: number
  maxTokens: number
  /**
   * 最大输出 token 的参数名。
   * 新版 OpenAI 模型（o 系列 / GPT-5）拒收 max_tokens，要求 max_completion_tokens。
   * 'auto' 会按模型名推断，并且网关报错时自动纠正重试。
   */
  maxTokensParam: 'auto' | 'max_tokens' | 'max_completion_tokens'
  /**
   * 额外请求体参数（JSON 对象字符串），会深合并进请求体。
   * 用于适配各家私有字段，例如：
   *   通义千问  {"enable_thinking": true}
   *   Anthropic 兼容  {"thinking": {"type": "enabled", "budget_tokens": 4096}}
   *   自定义网关  {"reasoning": {"effort": "high"}}
   */
  extraBody: string
}

export type AsrProviderKind = 'openai-compat' | 'local-whisper-cpp' | 'whisper-server' | 'dashscope-realtime'

/** 语音识别配置：云端 OpenAI 兼容接口 ↔ 本地 whisper.cpp 双通道 */
export interface AsrConfig {
  kind: AsrProviderKind
  /** openai-compat：/v1/audio/transcriptions 所在网关 */
  baseUrl: string
  apiKey: string
  model: string
  /** 'zh' | 'en' | 'auto' */
  language: string
  /** local-whisper-cpp：whisper-cli 可执行路径 */
  binaryPath: string
  /** local-whisper-cpp：ggml 模型路径 */
  modelPath: string
  extraArgs: string
  /**
   * whisper-server：常驻服务地址。
   *
   * 为什么不直接每次调 whisper-cli：实测同一段 6.2 秒音频，
   * CLI 每次重载模型要 14.9 秒，常驻服务只要 1.0 秒（约 5.5 倍实时）。
   * 实时助答必须用常驻模式。
   */
  serverUrl: string
  /** whisper-server：是否由应用自动拉起服务（未启动时） */
  autoStartServer: boolean
  /** whisper-server：whisper-server 可执行路径（自动拉起时用） */
  serverBinaryPath: string
  /** whisper-server：Silero VAD 模型路径；配置后启用服务端 VAD 切分 */
  vadModelPath: string
  /**
   * 端点静音时长（毫秒）。对齐原版 `aliyunMaxSentenceSilenceMs` 默认 800：
   * 说话停顿超过它即判定一句结束。
   */
  vadSilenceMs: number
  /** VAD 语音概率阈值（0-1） */
  vadThreshold: number
  /* ---- 阿里云百炼 Paraformer 实时识别（dashscope-realtime）---- */
  /** 服务地址，留空用官方 wss://dashscope.aliyuncs.com/api-ws/v1/inference */
  realtimeUrl: string
  /** 模型名，默认 paraformer-realtime-v2 */
  realtimeModel: string
  /**
   * 语义断句：true 用语义断句（更准，适合会议转写）；
   * false 用 VAD 断句（延迟低），此时 max_sentence_silence 才生效。
   */
  semanticPunctuation: boolean
  /** 标点恢复 */
  punctuationPrediction: boolean
  /** 逆文本正则化：中文数字转阿拉伯数字 */
  inverseTextNormalization: boolean
}

/** 向量模型配置（知识库检索用）。留空则自动退化为关键词检索 */
export interface EmbeddingConfig {
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

/* ------------------------------------------------------------------ *
 * 会话与消息
 * ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant'

/** 多模态内容片段（截图解题需要发图） */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: ChatRole
  content: string | ChatContentPart[]
}

/** 流式回答分片：reasoning 为思维链，content 为正文 */
export interface ChatDelta {
  kind: 'reasoning' | 'content'
  text: string
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
}

export interface ChatResult {
  text: string
  reasoning: string
  usage: ChatUsage | null
  /** 首字延迟（毫秒） */
  firstTokenMs: number | null
  totalMs: number
  /** 为兼容网关而自动调整过的参数，便于界面提示用户 */
  adjustments?: string[]
}

export type SessionKind = 'meeting' | 'interview_assist' | 'quiz' | 'ai_interview' | 'chat'

export interface TranscriptSegment {
  id: string
  text: string
  /** 该片段来自麦克风还是系统音频 */
  source: 'mic' | 'system'
  /** 声纹判定结果：self 表示是自己在说话（开启声纹过滤时才有值） */
  speaker?: 'self' | 'other'
  startMs: number
  endMs: number
  final: boolean
}

/** 一条问答记录 */
export interface QaRecord {
  id: string
  question: string
  answer: string
  reasoning?: string
  createdAt: number
  /** 触发方式 */
  trigger: 'auto' | 'manual' | 'screenshot'
}

export interface SessionRecord {
  id: string
  kind: SessionKind
  title: string
  createdAt: number
  updatedAt: number
  /** 绑定的智能体模板 id */
  agentId?: string
  transcript: TranscriptSegment[]
  qa: QaRecord[]
  /** 自由备注 / 复盘 */
  notes?: string
}

/* ------------------------------------------------------------------ *
 * 智能体模板
 * ------------------------------------------------------------------ */

export interface AgentTemplate {
  id: string
  name: string
  /** 角色设定 */
  persona: string
  /** 回答要求/风格 */
  style: string
  /** 绑定的知识库 id 列表 */
  knowledgeBaseIds: string[]
  /**
   * 带多少轮历史问答作为上下文。
   *
   * 对齐原版工作流 LLM 节点的 `memory.window.size`（原版默认 10 轮，
   * 并且用 role_prefix 明确区分 user / assistant）。0 = 不带历史。
   */
  memoryRounds?: number
  /** 覆盖默认 provider，留空用全局默认 */
  providerId?: string
  builtin?: boolean
}

/* ------------------------------------------------------------------ *
 * 知识库
 * ------------------------------------------------------------------ */

export interface KnowledgeDocument {
  id: string
  kbId: string
  name: string
  /** 原始文件路径，若为粘贴文本则为空 */
  path?: string
  chars: number
  chunks: number
  createdAt: number
}

export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
}

export interface RetrievedChunk {
  docId: string
  docName: string
  text: string
  score: number
}

/* ------------------------------------------------------------------ *
 * 笔试 / 截图解题
 * ------------------------------------------------------------------ */

/** 代码格式：仅函数核心代码 / 完整 IO 程序 */
export type QuizCodeMode = 'core' | 'acm'
/** 结论格式：精简（只给代码和复杂度）/ 全面（思路+代码+复杂度） */
export type QuizAnswerStyle = 'concise' | 'full'

export interface QuizConfig {
  codeMode: QuizCodeMode
  answerStyle: QuizAnswerStyle
  /** 'auto' = 按截图自适应判题语言 */
  language: string
  /** 单批最多截图数 */
  maxBatchScreens: number
}

/** 一组测试样例：标准输入 → 期望输出 */
export interface QuizTestCase {
  id: string
  input: string
  expected: string
}

/** 一次截图附件（批量时会有多张） */
export interface QuizAttachment {
  id: string
  dataUrl: string
  /** 第几屏，从 1 开始 */
  index: number
  /** 长截图拼接产生的屏数 */
  frames?: number
}

export type QuizJobStatus = 'queued' | 'running' | 'done' | 'failed'

/** 解题任务（原版有「排队中——前一题解题完成后自动开始」的语义） */
export interface QuizJob {
  id: string
  attachments: QuizAttachment[]
  prompt: string
  status: QuizJobStatus
  answer: string
  reasoning: string
  error?: string
  createdAt: number
  /** 首字延迟 */
  firstTokenMs?: number | null
  totalMs?: number
}

/* ------------------------------------------------------------------ *
 * AI 面试
 * ------------------------------------------------------------------ */

/** 面试阶段 */
export type InterviewPhase =
  | 'idle'
  | 'intro'
  | 'project'
  | 'technical'
  | 'behavioral'
  | 'candidate_qa'
  | 'review'

/** 难度等级 */
export type InterviewDifficulty = 'easy' | 'medium' | 'hard' | 'expert'

/**
 * 考察节奏。
 * adaptive：按阶段目标与回答质量自动推进，最多 15 轮
 * fixed：固定轮数，只限制核心/技术问题，开场与反问收尾不计入
 */
export type InterviewPacing = 'adaptive' | 'fixed'

/** 考察偏好 */
export type InterviewFocus =
  | 'balanced'
  | 'fundamentals'
  | 'system_design'
  | 'project'
  | 'breadth'

export interface InterviewConfig {
  /** 目标岗位 */
  role: string
  /** 面试官角色设定，例如「资深后端面试官」 */
  interviewer: string
  difficulty: InterviewDifficulty
  pacing: InterviewPacing
  /** pacing=fixed 时的题目数，3-15 */
  fixedRounds: number
  focus: InterviewFocus
  /** 单题超时（秒），0 表示不限 */
  timeoutSec: number
  /** 候选人简历/背景材料（可由 PDF 解析得到） */
  background: string
  /** 简历来源文件名，便于展示 */
  resumeName?: string
}

export interface InterviewTurn {
  id: string
  phase: InterviewPhase
  question: string
  answer?: string
  /** 0-100 */
  score?: number
  comment?: string
  createdAt: number
  /** 回答耗时（毫秒），用于超时提示 */
  elapsedMs?: number
}

export interface InterviewSession {
  id: string
  /** 岗位（与 config.role 同步，保留便于列表展示） */
  role: string
  /** 兼容旧数据：早期版本只存了 background 字符串 */
  background: string
  config: InterviewConfig
  phase: InterviewPhase
  turns: InterviewTurn[]
  createdAt: number
  updatedAt: number
  review?: string
  /** 是否已结束 */
  finished?: boolean
}

/* ------------------------------------------------------------------ *
 * 待办
 * ------------------------------------------------------------------ */

export interface TodoItem {
  id: string
  text: string
  done: boolean
  createdAt: number
  dueAt?: number
  /** 来源会话 */
  sessionId?: string
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export interface UiSettings {
  theme: 'dark' | 'light' | 'warm'
  /** 悬浮窗不透明度 0.2 - 1 */
  opacity: number
  /**
   * 界面等比缩放在各窗口内用 localStorage 独立记忆（见 renderer/src/hooks/useZoom.ts），
   * 不在这里保存——因为不同窗口需要的缩放比例通常不同。
   */
  language: 'zh-CN' | 'en'
}

/** 隐身/安全相关 */
export interface StealthSettings {
  /** 防录屏：窗口内容不进屏幕录制 */
  contentProtection: boolean
  /** 安全模式：检测到录屏/共享时自动隐藏或退出 */
  safeMode: boolean
  /** 放弃焦点：悬浮窗不抢焦点 */
  releaseFocus: boolean
  /** 鼠标穿透 */
  clickThrough: boolean
  /**
   * 悬停显隐（原版 hoverReveal）：鼠标移开时**整个悬浮窗消失**，移入即恢复。
   * 与原版的 autoCollapseChrome 是两件事，别混。
   */
  hoverReveal: boolean
  /** 悬停时的不透明度：鼠标移开时降到这个值，看起来就像「消失」 */
  hoverRevealOpacity: number
  /** 自动收起标题栏（原版 autoCollapseChrome）：只收起标题栏与工具条，保留内容区 */
  autoCollapse: boolean
  /** 安全模式：在共享画面中隐藏真实鼠标（本机仍可见替代光标） */
  hideCursor: boolean
  /** 记住安全模式：每次启动自动开启 */
  rememberSafeMode: boolean
  /** 退出时自动保存记录、不再弹确认（原版：开启后，退出自动保存记录，不再弹出确认） */
  autoSaveOnExit: boolean
}

export interface HotkeySettings {
  /**
   * 解除悬浮窗交互锁定（鼠标穿透）。
   * 留空时使用内置兜底键 CommandOrControl+Shift+9（对齐原版 mi）。
   * 穿透开启后窗口不响应鼠标，没有这条快捷键就出不来了。
   */
  toggleClickThrough: string
  /** 开启/关闭悬停显隐 */
  toggleHoverReveal: string
  /** 显示/隐藏悬浮窗 */
  toggleFloating: string
  /** 手动触发一次回答 */
  answerNow: string
  /** 截图解题 */
  screenshot: string
  /** 清空当前会话 */
  clearSession: string
}

export interface AudioSettings {
  /** 麦克风设备 id，空为系统默认 */
  micDeviceId: string
  /** 摄像头设备 id，空为系统默认（仅用于设备自检） */
  cameraDeviceId: string
  micEnabled: boolean
  systemAudioEnabled: boolean
  /** 系统音频采集方式 */
  systemAudioSource: 'loopback' | 'virtual-device' | 'off'
  /** 虚拟音频设备名（systemAudioSource=virtual-device 时使用） */
  virtualDeviceLabel: string
}

/* ------------------------------------------------------------------ *
 * 模式（原版 aim:modes：把会议/笔试/面试的整套参数做成可切换的预设）
 * ------------------------------------------------------------------ */

export type ModeKind = 'meeting' | 'quiz' | 'interview'

export interface ModeQuizConfig {
  /** 截屏快捷键 */
  shortcut: string
  /** 截图 JPEG 质量 1-100 */
  jpegQuality: number
  /** 允许耳机媒体键触发截屏 */
  useMediaKey: boolean
  /** 该模式专属的附加系统提示词 */
  systemPrompt: string
  /**
   * 题型（原版 qz.kindLabel）。
   * normal：按问答题作答；coding：按编程题格式输出。
   */
  kind: 'normal' | 'coding'
  /**
   * 代码格式（原版 qz.codeModeLabel）。
   * core：核心代码模式（仅函数）；acm：ACM 模式（完整 IO 程序）。
   */
  codeMode: 'core' | 'acm'
  /** 判题语言（原版 qz.agentLangLabel）；auto = 按截图识别 */
  language: string
  /**
   * 解题模式（原版 qz.modeNormal / Agent）。
   * normal：一次多模态作答；agent：本机工作区解题 + 样例检查。
   */
  solveMode: 'normal' | 'agent'
}

/** 模式预设。字段名对齐原版 aim:modes 的存储结构 */
export interface Mode {
  id: string
  name: string
  description?: string
  type: ModeKind
  /** 原版为 normal；预置模式带 defaultKey */
  kind: string
  /** 系统预置模式不可删除 */
  defaultKey?: string

  /* 音频 */
  speechToText: boolean
  audioSource: 'mic' | 'system' | 'both'
  speechLanguage: string
  microphoneId: string
  volume: number
  /** 原版 excludeSelfVoice：排除自己的声音（声纹过滤） */
  excludeSelfVoice: boolean
  /** 阿里云静音断句（毫秒） */
  aliyunMaxSentenceSilenceMs: number

  /* 答题 */
  autoAnswer: boolean
  /** 原版 concise / detailed */
  answerStyle: 'concise' | 'detailed'
  /** 原版 fast / balanced / slow */
  responseSpeed: 'fast' | 'balanced' | 'slow'
  knowledgeBaseIds: string[]

  /* 外观 */
  overlayOpacity: number
  autoHideMain: boolean

  /** 笔试模式专属 */
  quizConfig?: ModeQuizConfig

  createdAt: number
  updatedAt: number
}

/** 声纹过滤：把「自己的声音」从提问来源里排除 */
export interface VoiceprintSettings {
  enabled: boolean
  /** 相似度阈值 0-1，越高越严格 */
  threshold: number
  /** 命中自己声音时是否保留在上下文里（原版：会记录在上下文中） */
  keepInContext: boolean
}

/** 语音识别调参 */
export interface AsrTuning {
  /** 判定一句结束的静音时长（毫秒） */
  silenceMs: number
  /** 单个识别片段最长时长（毫秒） */
  maxSegmentMs: number
  /** 单个识别片段最短时长，过滤噪声（毫秒） */
  minSegmentMs: number
  /** 热词，提升专有名词识别率 */
  hotwords: string[]
  /** 是否自动出答案 */
  autoAnswer: boolean
  /** 自动出答案前累计的问题字数阈值 */
  autoAnswerMinChars: number
  /**
   * 累积转写：语音累计成一条，不自动提交，点击气泡/按钮才发送给 AI。
   * 对齐原版：「开启后语音累计成一条，点击气泡才发送给 AI」。
   */
  cumulative: boolean
  /**
   * 无人发言多少秒后自动停止采集（0 = 不自动停止）。
   * 对齐原版：「会议中若超过设定时间无人发言，系统将自动关闭声音录入」。
   */
  silenceAutoStopSec: number
}

/** 题目翻译：仅翻译题目用于展示，AI 仍用原题作答 */
export interface TranslateSettings {
  enabled: boolean
  /** 目标语言代码，如 zh / en / ja */
  target: string
  /** 触发翻译的快捷键说明用不到，快捷键在主 hotkeys 里 */
}

export interface Settings {
  version: number
  providers: ProviderConfig[]
  activeProviderId: string
  /** 模式预设（会议/笔试/面试）：一整套音频+答题+外观参数 */
  modes: Mode[]
  /** 当前激活的模式 id */
  activeModeId: string
  asr: AsrConfig
  asrTuning: AsrTuning
  translate: TranslateSettings
  voiceprint: VoiceprintSettings
  embedding: EmbeddingConfig
  ui: UiSettings
  stealth: StealthSettings
  hotkeys: HotkeySettings
  audio: AudioSettings
  agents: AgentTemplate[]
  activeAgentId: string
  /** 开始会话前自动做一次设备检查 */
  preflightCheck: boolean
  /** 笔试准备页的持久化选择 */
  quizPrep: QuizPrepSettings
}

/** 笔试准备页（原版：创建笔试 → 选截图来源 → 开始） */
export interface QuizPrepSettings {
  /** 上次填写的笔试名称，便于连续创建时复用 */
  lastName: string
  /** 是否另存本次笔试记录 */
  saveRecord: boolean
}

/* ------------------------------------------------------------------ *
 * 运行态
 * ------------------------------------------------------------------ */

export type GatewayStatus = 'unknown' | 'ok' | 'error'

export interface ConnectionTestResult {
  ok: boolean
  /** 毫秒 */
  latencyMs: number
  message: string
  /** 探针返回的模型列表（若接口支持） */
  models?: string[]
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export interface AppPermissions {
  microphone: PermissionState
  camera: PermissionState
  screen: PermissionState
  accessibility: PermissionState
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput' | 'videoinput'
}

/* ------------------------------------------------------------------ *
 * 设备检查（面试/会议开始前）
 * ------------------------------------------------------------------ */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown'

export interface DeviceCheckItem {
  /** microphone | camera | system-audio | screen */
  id: string
  label: string
  status: CheckStatus
  message: string
  /** 原版语义：检查失败也可以继续，系统会按可用输入兜底 */
  optional: boolean
  /** 检测到的设备名，便于确认用的是哪一个 */
  detail?: string
}

export interface DeviceCheckResult {
  items: DeviceCheckItem[]
  /** 三项核心检查（麦克风/摄像头/系统音频）是否全部通过 */
  allPassed: boolean
  /** 有失败项但依然可以开始 */
  canProceed: boolean
  checkedAt: number
}

/* ------------------------------------------------------------------ *
 * 环境检查（安全模式相关）
 * ------------------------------------------------------------------ */

export interface SecurityCheckItem {
  id: string
  label: string
  status: CheckStatus
  message: string
  /** 建议动作，例如加入白名单 */
  advice?: string
}

export interface SecurityCheckResult {
  items: SecurityCheckItem[]
  /** 整体风险等级 */
  risk: 'safe' | 'warn' | 'risk' | 'unknown'
  summary: string
  /** 检测到的具体软件名，便于用户排查 */
  detections: {
    /** 录屏 / 屏幕共享软件 */
    recorders: string[]
    /** 杀毒 / 防火墙等安全软件 */
    securitySoftware: string[]
  }
  checkedAt: number
}

/** 把检查结果持久化，供各窗口读取 */
export interface CheckState {
  device?: DeviceCheckResult
  security?: SecurityCheckResult
}

/** 悬浮窗实时运行状态（主进程 → 悬浮窗） */
export interface LiveState {
  running: boolean
  /** 当前识别到的待回答问题 */
  pendingQuestion: string
  /** 最近一次识别文本 */
  lastTranscript: string
  /**
   * 是否正在识别（流式通道下收到中间结果时为 true）。
   * 用来在界面上显示「正在识别」的实时行——对应原版的 isFinal=false 增量状态。
   */
  hearing: boolean
  /* ---- 链路自检：用来判断「没反应」断在哪一环 ---- */
  /** 累计收到的音频帧数。为 0 说明采集没送出帧（权限/采集失败） */
  audioFrames: number
  /** 最近一帧的音量（0-1）。帧在涨但这里恒为 0 → 采到的是静音 */
  audioLevel: number
  /** 流式识别通道是否已连上 */
  streamingConnected: boolean
  /** 流式通道最近一次错误（空表示没有） */
  streamingError: string
  /** 累积转写缓冲（cumulative 模式下显示，点击才发送） */
  accumulated: string
  /** 当前待答问题的翻译（题目翻译开启时） */
  questionTranslation: string
  /** 是否因长时间无人发言而自动停止了采集 */
  autoStopped: boolean
  /** 声纹过滤：是否已录入自己的声纹 */
  voiceprintEnrolled: boolean
  /** 正在生成 */
  streaming: boolean
  gateway: GatewayStatus
  asr: 'idle' | 'listening' | 'transcribing' | 'error'
  /** 安全模式命中原因，空为正常 */
  securityAlert: string
  sessionId: string | null
}

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}
