/**
 * IPC 契约（接口冻结区）
 *
 * 主进程：在 src/main/ipc 下按同名常量注册 handler。
 * 预加载：按窗口暴露 api 对象，类型见文件末尾。
 * 渲染进程：只通过 window.<api> 访问，不直接使用 ipcRenderer。
 */

export const IPC = {
  /* 设置 */
  SettingsGet: 'settings:get',
  SettingsPatch: 'settings:patch',
  SettingsReset: 'settings:reset',
  /**
   * 定向更新单个网关配置的若干字段。
   * 之所以需要它：渲染层若用「整份 providers 数组」回写，闭包里拿到的是渲染时快照，
   * 快速输入时后一次会覆盖前一次，表现为「改了保存不上」。
   * 按 id 定向合并可以从根本上避免这个问题。
   */
  SettingsPatchProvider: 'settings:patch-provider',
  /** 模式（会议/笔试/面试预设） */
  ModesList: 'modes:list',
  ModesSave: 'modes:save',
  ModesDelete: 'modes:delete',
  ModesActivate: 'modes:activate',
  ModesCycle: 'modes:cycle',
  /* 悬浮工具条 */
  QuizbarClickThrough: 'quizbar:click-through',
  QuizbarOpacity: 'quizbar:opacity',
  QuizbarCollapsed: 'quizbar:collapsed',
  QuizbarFocusable: 'quizbar:focusable',
  QuizbarClose: 'quizbar:close',
  QuizbarExpanded: 'quizbar:expanded',
  /** 悬停显隐：主进程通知渲染层鼠标是否在窗口内（原版 hoverReveal） */
  HoverRevealChanged: 'hover:reveal-changed',
  QuizbarSetSize: 'quizbar:set-size',
  /** 写文本到系统剪贴板（走主进程，不依赖渲染层焦点） */
  ClipboardWriteText: 'clipboard:write-text',
  /** 当前生效的穿透解锁快捷键（界面提示用） */
  ClickThroughHotkey: 'stealth:click-through-hotkey',
  /** 立即解除穿透 */
  ClickThroughRelease: 'stealth:click-through-release',
  /** 退出悬浮窗：按用户选择保存或丢弃本次记录 */
  QuizbarExit: 'quizbar:exit',
  /** 打开笔试/面试悬浮工具条 */
  QuizbarOpen: 'quizbar:open',
  /**
   * 让悬浮窗「开始一段会话」。
   *
   * 为什么不能由主窗口直接调 live:start：
   * 采集音频的 AudioCapture 活在悬浮窗渲染层里，设备检查闸门也在那边。
   * 主窗口先 start 只会让悬浮窗一打开就显示「停止」，但根本没有采集，
   * 用户得先点停止再点开始才真正跑起来。
   */
  FloatingStart: 'floating:start',
  /** 主进程 → 悬浮窗：请开始这段会话（事件） */
  FloatingStartRequested: 'floating:start-requested',
  /** 替代光标位置推送（主进程 → 光标窗口） */
  CursorPosition: 'cursor:position',
  /** 替代光标窗口显隐 */
  CursorOverlaySet: 'cursor:overlay-set',
  SettingsChanged: 'settings:changed', // 事件

  /* 网关连通性 */
  GatewayTest: 'gateway:test',
  GatewayListModels: 'gateway:list-models',
  GatewayTestAsr: 'gateway:test-asr',

  /* 对话（非流式，供工具类调用） */
  ChatComplete: 'chat:complete',

  /* 对话流式：渲染进程发起，主进程回推 delta 事件 */
  ChatStreamStart: 'chat:stream:start',
  ChatStreamCancel: 'chat:stream:cancel',
  ChatStreamDelta: 'chat:stream:delta', // 事件 { requestId, delta }
  ChatStreamDone: 'chat:stream:done', // 事件 { requestId, result }
  ChatStreamError: 'chat:stream:error', // 事件 { requestId, error }

  /* 会话记录 */
  SessionList: 'session:list',
  SessionGet: 'session:get',
  SessionCreate: 'session:create',
  SessionUpdate: 'session:update',
  SessionDelete: 'session:delete',
  SessionAppendTranscript: 'session:append-transcript',
  SessionAppendQa: 'session:append-qa',

  /* 智能体模板 */
  AgentList: 'agent:list',
  AgentSave: 'agent:save',
  AgentDelete: 'agent:delete',

  /* 知识库 */
  KbList: 'kb:list',
  KbCreate: 'kb:create',
  /** 改知识库用途（简历 / 题库 / 通用） */
  KbSetPurpose: 'kb:set-purpose',
  /** 把简历知识库提炼成速查卡（上传后跑一次） */
  KbDistillResume: 'kb:distill-resume',
  KbDelete: 'kb:delete',
  KbAddDocument: 'kb:add-document',
  KbRemoveDocument: 'kb:remove-document',
  KbListDocuments: 'kb:list-documents',
  KbSearch: 'kb:search',

  /* AI 面试 */
  InterviewList: 'interview:list',
  InterviewGet: 'interview:get',
  InterviewCreate: 'interview:create',
  InterviewStart: 'interview:start',
  InterviewAnswer: 'interview:answer',
  InterviewFinish: 'interview:finish',
  InterviewDelete: 'interview:delete',
  InterviewGenerateReview: 'interview:generate-review',

  /* 待办 */
  TodoList: 'todo:list',
  TodoAdd: 'todo:add',
  TodoToggle: 'todo:toggle',
  TodoDelete: 'todo:delete',

  /* 实时会话（悬浮窗主链路） */
  LiveStart: 'live:start',
  LiveStop: 'live:stop',
  LiveState: 'live:state',
  LivePushAudio: 'live:push-audio',
  LiveAsk: 'live:ask',
  LiveClear: 'live:clear',
  /** 累积转写模式下手动发送 */
  LiveSendAccumulated: 'live:send-accumulated',
  /** 清空累计转写 */
  LiveClearAccumulated: 'live:clear-accumulated',
  /** 从「无人发言自动停止」恢复采集 */
  LiveResumeCapture: 'live:resume-capture',
  LiveAutoStopped: 'live:auto-stopped', // 事件
  LiveStateChanged: 'live:state-changed', // 事件
  LiveTranscript: 'live:transcript', // 事件 { segment }
  /**
   * 开始为某个问题生成答案。
   * 为什么需要它：答案的第一个 token 可能要等好几秒，若只靠 answerDelta 建卡片，
   * 这段等待期界面上是一张「没有题目的空白卡」，看起来就像没在回答。
   */
  LiveAnswerStart: 'live:answer-start', // 事件 { qaId, question, trigger }
  LiveAnswerDelta: 'live:answer-delta', // 事件 { qaId, delta }
  LiveAnswerDone: 'live:answer-done', // 事件 { record, firstTokenMs, totalMs }
  /** 上一条答案被新的提问打断（不再有答案产出），界面据此收掉「生成中」 */
  LiveAnswerAborted: 'live:answer-aborted', // 事件 { qaId }
  LiveSecurityAlert: 'live:security-alert', // 事件 { reason }
  LiveError: 'live:error', // 事件 { scope, message }

  /* 悬浮窗控制 */
  FloatingToggle: 'floating:toggle',
  FloatingShow: 'floating:show',
  FloatingHide: 'floating:hide',
  FloatingSetOpacity: 'floating:set-opacity',
  FloatingSetClickThrough: 'floating:set-click-through',
  FloatingSetIgnoreFocus: 'floating:set-ignore-focus',
  FloatingResize: 'floating:resize',
  FloatingMoveBy: 'floating:move-by',

  /* 窗口管理 */
  WindowOpen: 'window:open',
  WindowClose: 'window:close',
  WindowMinimize: 'window:minimize',

  /* 截图 */
  CaptureStart: 'capture:start',
  CaptureDone: 'capture:done', // 事件 { dataUrl } 从 capture 窗口回传
  CaptureGetSource: 'capture:get-source', // capture 窗口索取待选区底图
  CaptureCancel: 'capture:cancel',
  CaptureSave: 'capture:save',
  CaptureReadClipboardImage: 'capture:read-clipboard-image',
  /** 直接抓取屏幕（不弹选区遮罩），供长截图/批量截图累加使用 */
  CaptureGrabScreen: 'capture:grab-screen',
  /** 解析简历 PDF/文档，返回纯文本 */
  InterviewParseResume: 'interview:parse-resume',
  /** 悬浮窗/笔试窗请求对给定图片出答案 */
  AnswerImage: 'answer:image',
  AnswerImageDelta: 'answer:image-delta', // 事件
  AnswerImageDone: 'answer:image-done', // 事件

  /* 设备与权限 */
  ListAudioDevices: 'device:list-audio',
  GetPermissions: 'permission:get',
  RequestPermission: 'permission:request',
  OpenSystemSettings: 'permission:open-settings',
  /** 实测屏幕录制是否真的可用 */
  ProbeScreenCapture: 'diagnostics:probe-screen-capture',

  /*
   * macOS 系统音频（电脑音频）。
   *
   * 原版在 macOS 上不走 getDisplayMedia —— 那条路拿不到系统输出，音轨存在但恒为静音。
   * 它由主进程拉一个 ScreenCaptureKit 子进程，把 16k/mono/s16le PCM 通过管道推给渲染层。
   * 事件名就是主进程侧的原始通道名，保持一致便于对照。
   */
  SystemAudioStart: 'mac-system-audio:start',
  SystemAudioStop: 'mac-system-audio:stop',
  /** 实测采集能力（拉起 helper 等 ready），比权限查询更可信 */
  SystemAudioCheckAccess: 'mac-system-audio:check-access',
  SystemAudioData: 'mac-system-audio:data', // 事件 { ArrayBuffer }
  SystemAudioReady: 'mac-system-audio:ready', // 事件
  SystemAudioError: 'mac-system-audio:error', // 事件 { message }

  /* 设备检查 / 环境检查 */
  DeviceCheckSave: 'diagnostics:device-check-save',
  SecurityScan: 'diagnostics:security-scan',
  CheckStateGet: 'diagnostics:check-state-get',
  CheckStateChanged: 'diagnostics:check-state-changed', // 事件
  CheckRecorders: 'diagnostics:recorders',
  /** 声纹录入：渲染层采集若干秒音频后回传，主进程生成模板 */
  VoiceprintEnroll: 'voiceprint:enroll',
  VoiceprintStatus: 'voiceprint:status',
  VoiceprintReset: 'voiceprint:reset',
  /** 键盘防护 / 安全输入 */
  GuardSupport: 'guard:support',
  GuardStatus: 'guard:status',
  GuardEnable: 'guard:enable',
  GuardDisable: 'guard:disable',
  SecureInputSet: 'guard:secure-input',
  AppDisplayName: 'diagnostics:app-name',

  /* 应用信息 */
  AppInfo: 'app:info',
  OpenExternal: 'app:open-external',
  OpenDataDir: 'app:open-data-dir',
  PickFile: 'app:pick-file',
  SaveFile: 'app:save-file',
  /** 界面等比缩放 */
  ZoomSet: 'app:zoom-set',
  ZoomGet: 'app:zoom-get'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/* ------------------------------------------------------------------ *
 * 各窗口暴露的 API 类型
 * ------------------------------------------------------------------ */

import type {
  AgentTemplate,
  AppPermissions,
  AsrConfig,
  AudioDeviceInfo,
  ChatDelta,
  ChatMessage,
  ChatResult,
  CheckState,
  ConnectionTestResult,
  DeviceCheckResult,
  InterviewConfig,
  Mode,
  InterviewSession,
  KnowledgeBase,
  KnowledgeDocument,
  LiveState,
  ProviderConfig,
  QaRecord,
  Result,
  RetrievedChunk,
  SessionKind,
  SessionRecord,
  Settings,
  TodoItem,
  TranscriptSegment,
  KnowledgePurpose
} from './types'

export interface StreamHandlers {
  onDelta: (requestId: string, delta: ChatDelta) => void
  onDone: (requestId: string, result: ChatResult) => void
  onError: (requestId: string, message: string) => void
}

export interface ModesApi {
  list: () => Promise<Mode[]>
  /** 新建或更新一个模式 */
  save: (mode: Partial<Mode> & { name: string; type: Mode['type'] }) => Promise<Mode>
  /** 删除模式（预置模式不可删） */
  remove: (id: string) => Promise<Result<null>>
  /** 激活模式：会把整套参数套用到设置上 */
  activate: (id: string) => Promise<Result<Mode>>
  /** 切换到上一个/下一个模式（原版：切换到上一个/下一个会议角色） */
  cycle: (direction: 1 | -1) => Promise<Mode>
}

export interface SettingsApi {
  get: () => Promise<Settings>
  patch: (patch: DeepPartial<Settings>) => Promise<Settings>
  /** 只更新指定网关的若干字段，不会覆盖同一数组中其它网关的改动 */
  patchProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<Settings>
  reset: () => Promise<Settings>
  onChanged: (cb: (s: Settings) => void) => () => void
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface GatewayApi {
  test: (provider: ProviderConfig) => Promise<ConnectionTestResult>
  listModels: (provider: ProviderConfig) => Promise<Result<string[]>>
  testAsr: (asr: AsrConfig) => Promise<ConnectionTestResult>
}

export interface ChatApi {
  complete: (messages: ChatMessage[], opts?: { providerId?: string; json?: boolean }) => Promise<Result<ChatResult>>
  streamStart: (requestId: string, messages: ChatMessage[], opts?: { providerId?: string }) => Promise<Result<null>>
  streamCancel: (requestId: string) => Promise<void>
  onDelta: (cb: (requestId: string, delta: ChatDelta) => void) => () => void
  onDone: (cb: (requestId: string, result: ChatResult) => void) => () => void
  onError: (cb: (requestId: string, message: string) => void) => () => void
}

export interface SessionApi {
  list: (kind?: SessionKind) => Promise<SessionRecord[]>
  get: (id: string) => Promise<SessionRecord | null>
  create: (kind: SessionKind, title?: string) => Promise<SessionRecord>
  update: (id: string, patch: Partial<SessionRecord>) => Promise<SessionRecord | null>
  remove: (id: string) => Promise<void>
  appendTranscript: (id: string, segment: TranscriptSegment) => Promise<void>
  appendQa: (id: string, qa: QaRecord) => Promise<void>
}

export interface AgentApi {
  list: () => Promise<AgentTemplate[]>
  save: (agent: AgentTemplate) => Promise<AgentTemplate[]>
  remove: (id: string) => Promise<AgentTemplate[]>
}

export interface KnowledgeApi {
  list: () => Promise<KnowledgeBase[]>
  /** purpose：resume（简历，整份注入面试作答）/ quiz（题库，注入截图解题）/ general（检索式） */
  create: (name: string, description?: string, purpose?: KnowledgePurpose) => Promise<KnowledgeBase[]>
  setPurpose: (kbId: string, purpose: KnowledgePurpose) => Promise<KnowledgeBase[]>
  /** 提炼简历速查卡；ok=false 时继续用原文兜底 */
  distillResume: (kbId: string) => Promise<{ ok: boolean; chars?: number; error?: string }>
  remove: (id: string) => Promise<KnowledgeBase[]>
  addDocument: (kbId: string, payload: { path?: string; name?: string; text?: string }) => Promise<Result<KnowledgeDocument>>
  removeDocument: (docId: string) => Promise<void>
  listDocuments: (kbId: string) => Promise<KnowledgeDocument[]>
  search: (kbIds: string[], query: string, topK?: number) => Promise<RetrievedChunk[]>
}

export interface InterviewApi {
  /** 解析简历文件（PDF/Word/文本），返回提取到的文本 */
  parseResume: (path: string) => Promise<Result<{ text: string; name: string }>>
  /** 生成复盘报告（不结束面试，用于随时查看） */
  generateReview: (id: string) => Promise<InterviewSession>
  list: () => Promise<InterviewSession[]>
  get: (id: string) => Promise<InterviewSession | null>
  /** 传整份配置（推荐）；主进程同时兼容旧的 (role, background) 双参数形态 */
  create: (config: InterviewConfig | string, background?: string) => Promise<InterviewSession>
  start: (id: string) => Promise<InterviewSession>
  /** elapsedMs 为渲染层的精确作答耗时；不传则由主进程按时间戳推算 */
  answer: (id: string, answer: string, elapsedMs?: number) => Promise<InterviewSession>
  finish: (id: string) => Promise<InterviewSession>
  remove: (id: string) => Promise<void>
}

export interface TodoApi {
  list: () => Promise<TodoItem[]>
  add: (text: string, sessionId?: string) => Promise<TodoItem[]>
  toggle: (id: string) => Promise<TodoItem[]>
  remove: (id: string) => Promise<TodoItem[]>
}

export interface LiveApi {
  /** title 用于给这次会话命名（不传则首次问答后按问题自动命名） */
  start: (opts?: { kind?: SessionKind; title?: string }) => Promise<Result<LiveState>>
  stop: () => Promise<void>
  state: () => Promise<LiveState>
  pushAudio: (pcm: ArrayBuffer, source: 'mic' | 'system') => void
  ask: (question?: string) => Promise<Result<null>>
  /** 累积转写模式：发送当前累计内容 */
  sendAccumulated: () => Promise<Result<null>>
  /** 清空累计转写 */
  clearAccumulated: () => Promise<void>
  /** 从「无人发言自动停止」恢复采集 */
  resumeCapture: () => Promise<LiveState>
  /** 无人发言导致自动停止采集 */
  onAutoStopped: (cb: (info: { seconds: number }) => void) => () => void
  clear: () => Promise<void>
  onState: (cb: (s: LiveState) => void) => () => void
  onTranscript: (cb: (segment: TranscriptSegment) => void) => () => void
  /** 开始生成：界面应立刻切到这条并显示题目 */
  onAnswerStart: (cb: (info: { qaId: string; question: string; trigger: QaRecord['trigger'] }) => void) => () => void
  onAnswerDelta: (cb: (qaId: string, delta: ChatDelta) => void) => () => void
  /** firstTokenMs/totalMs 用于在界面上直观看到「等了多久」 */
  onAnswerDone: (cb: (record: QaRecord, timing: { firstTokenMs?: number; totalMs?: number }) => void) => () => void
  /** 上一条被新提问打断 */
  onAnswerAborted: (cb: (qaId: string) => void) => () => void
  onSecurityAlert: (cb: (reason: string) => void) => () => void
  onError: (cb: (scope: string, message: string) => void) => () => void
}

export interface FloatingApi {
  /**
   * 打开悬浮窗并请求它开始一段会话（设备检查 → 建采集 → 真正开始，
   * 全部在悬浮窗里完成）。返回时悬浮窗已显示，但是否真正开始要等它自己走完检查。
   */
  start: (opts?: { kind?: SessionKind; title?: string }) => Promise<void>
  toggle: () => Promise<void>
  show: () => Promise<void>
  hide: () => Promise<void>
  setOpacity: (v: number) => Promise<void>
  setClickThrough: (v: boolean) => Promise<void>
  setIgnoreFocus: (v: boolean) => Promise<void>
  resize: (w: number, h: number) => Promise<void>
  moveBy: (dx: number, dy: number) => Promise<void>
}

export interface CaptureApi {
  /** 直接抓一屏，返回 dataURL；用于长截图/批量截图 */
  grabScreen: (displayId?: number) => Promise<Result<string>>
  /** 开始选区截图；完成后主进程通过 onDone 回传 */
  start: (mode?: 'region' | 'fullscreen' | 'long') => Promise<Result<null>>
  done: (dataUrl: string) => void
  cancel: () => void
  save: (dataUrl: string) => Promise<Result<string>>
  readClipboardImage: () => Promise<string | null>
  onDone: (cb: (dataUrl: string) => void) => () => void
  /** 请求对图片出答案（流式） */
  answerImage: (dataUrl: string, prompt?: string) => Promise<Result<string>>
  onAnswerDelta: (cb: (reqId: string, delta: ChatDelta) => void) => () => void
  /** 完成或失败：error 非空时表示失败原因 */
  onAnswerDone: (cb: (reqId: string, text: string, error?: string) => void) => () => void
}

export interface DeviceApi {
  listAudioDevices: () => Promise<AudioDeviceInfo[]>
  getPermissions: () => Promise<AppPermissions>
  requestPermission: (kind: 'microphone' | 'camera' | 'screen' | 'accessibility') => Promise<AppPermissions>
  openSystemSettings: (kind: 'microphone' | 'camera' | 'screen' | 'accessibility') => Promise<void>
  /** 实测屏幕录制是否真的可用 */
  probeScreenCapture: () => Promise<{ ok: boolean; message: string }>
}

export type GuardSide = 'left' | 'right' | 'both'

export interface GuardSupport {
  ok: boolean
  reason?: string
  helperPath: string | null
  hasAccessibility: boolean
}

export interface GuardStatus {
  enabled: boolean
  side: GuardSide
  secureInput: boolean
  support: GuardSupport
}

export interface GuardApi {
  support: () => Promise<GuardSupport>
  status: () => Promise<GuardStatus>
  enable: (side: GuardSide) => Promise<{ ok: boolean; message: string; status: GuardStatus }>
  disable: () => Promise<GuardStatus>
  setSecureInput: (on: boolean) => Promise<{ ok: boolean; message: string; status: GuardStatus }>
}

export interface VoiceprintApi {
  /** 录入声纹：由渲染层采集若干秒麦克风音频后回传（16kHz 单声道 PCM16） */
  enroll: (chunks: ArrayBuffer[]) => Promise<Result<{ samples: number }>>
  status: () => Promise<{ enrolled: boolean; samples: number; createdAt: number | null }>
  reset: () => Promise<void>
}

export interface DiagnosticsApi {
  /** 保存设备检查结果（渲染层实测后回传） */
  saveDeviceCheck: (result: DeviceCheckResult) => Promise<CheckState>
  /** 运行环境检查 */
  scanSecurity: () => Promise<CheckState>
  /** 读取最近一次检查结果 */
  getCheckState: () => Promise<CheckState>
  /** 当前检测到的录屏软件 */
  recorders: () => Promise<string[]>
  /** 应用展示名（用于白名单建议文案） */
  appName: () => Promise<string>
  onCheckStateChanged: (cb: (state: CheckState) => void) => () => void
}

/**
 * macOS 系统音频采集（原生 ScreenCaptureKit）。
 *
 * 为什么单独一条通道：macOS 上 `getDisplayMedia({audio:true})` 拿不到系统输出，
 * 音轨存在但恒为静音。原版由主进程拉 ScreenCaptureKit 子进程，把
 * 16k/mono/s16le PCM 按 [uint32 LE 长度][载荷] 分帧推给渲染层。
 *
 * 使用顺序：`start()` → 等 `onReady` → `onData` 收帧 → `stop()`。
 * 只 `start()` 而不消费 onData 是不行的：管道写满会把采集组件卡住。
 */
export interface SystemAudioApi {
  /** 当前平台是否支持（macOS 13+ / Windows） */
  supported: () => Promise<boolean>
  /** 实测屏幕录制权限是否真的可用（会真的拉起采集组件等 ready） */
  checkAccess: () => Promise<{ ok: boolean; error?: string }>
  /** 拉起采集；返回 ok 只代表组件已启动，就绪信号是 onReady */
  start: () => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<void>
  /** 16k / 单声道 / s16le 的 PCM 帧（100ms 一帧） */
  onData: (cb: (pcm: ArrayBuffer) => void) => () => void
  onReady: (cb: () => void) => () => void
  onError: (cb: (message: string) => void) => () => void
}

export interface ClipboardApi {
  /**
   * 写文本到系统剪贴板。
   *
   * 为什么必须走主进程：悬浮窗是 focusable:false 的（避免抢焦点），
   * 而 navigator.clipboard.writeText() 要求文档已聚焦，否则抛
   * NotAllowedError: Document is not focused —— 复制按钮会静默失效。
   */
  writeText: (text: string) => Promise<boolean>
}

export interface AppApi {
  info: () => Promise<{
    name: string
    version: string
    electron: string
    platform: string
    /** 平台判定，供渲染层选择采集方式（原版 appPlatform） */
    isMacOS: boolean
    isWindows: boolean
    supportsSystemAudioLoopback: boolean
    dataDir: string
  }>
  openExternal: (url: string) => Promise<void>
  openDataDir: () => Promise<void>
  /** 打开系统文件选择器，返回绝对路径；取消返回 null */
  pickFile: (opts?: { title?: string; extensions?: string[] }) => Promise<string | null>
  /** 用系统保存对话框写出文本文件，返回保存路径；取消返回 null */
  saveFile: (opts: { title?: string; defaultName: string; content: string; extensions?: string[] }) => Promise<string | null>
  /** 设置当前窗口的等比缩放（0.5 ~ 2.5）；返回实际生效值 */
  setZoom: (factor: number) => Promise<number>
  /** 读取当前窗口的缩放值 */
  getZoom: () => Promise<number>
  openWindow: (kind: 'main' | 'quiz' | 'interview' | 'floating' | 'quizbar') => Promise<void>
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
}

/** 主窗口（完整控制台）暴露的 API */
export interface MainWindowApi {
  kind: 'main'
  settings: SettingsApi
  gateway: GatewayApi
  chat: ChatApi
  sessions: SessionApi
  agents: AgentApi
  knowledge: KnowledgeApi
  interview: InterviewApi
  todos: TodoApi
  live: LiveApi
  device: DeviceApi
  diagnostics: DiagnosticsApi
  voiceprint: VoiceprintApi
  guard: GuardApi
  modes: ModesApi
  app: AppApi
  /** 主窗口只需要「请求悬浮窗开始」这一个能力 */
  floating: Pick<FloatingApi, 'start'>
  /** 系统剪贴板（走主进程，悬浮窗不聚焦也能用） */
  clipboard: ClipboardApi
  /** 电脑音频（macOS 原生采集） */
  systemAudio: SystemAudioApi
}

/** 悬浮窗暴露的 API */
export interface FloatingWindowApi {
  kind: 'floating'
  settings: SettingsApi
  live: LiveApi
  floating: FloatingApi
  /** 主窗口发起「开始会话」后，悬浮窗据此自动开跑（含设备检查） */
  onStartRequested: (cb: (opts: { kind: SessionKind; title?: string }) => void) => () => void
  capture: Pick<CaptureApi, 'start' | 'readClipboardImage' | 'onDone' | 'grabScreen'>
  device: DeviceApi
  diagnostics: DiagnosticsApi
  /** 悬浮窗需要切换模式（原版：切换到上一个/下一个会议角色） */
  modes: ModesApi
  app: AppApi
  /** 系统剪贴板（走主进程，悬浮窗不聚焦也能用） */
  clipboard: ClipboardApi
  /** 电脑音频（macOS 原生采集） */
  systemAudio: SystemAudioApi
}

/** 笔试/截图解题窗口 */
/**
 * 笔试/面试悬浮工具条（原版「快捷操作」）窗口。
 * 半透明小窗，承载截图识题、快捷键、悬停显隐、鼠标穿透、设置。
 */
export interface QuizbarWindowApi {
  kind: 'quizbar'
  settings: SettingsApi
  /** 窗口自身控制（穿透、不透明度、收起） */
  bar: QuizbarApi
  capture: Pick<CaptureApi, 'start' | 'readClipboardImage' | 'onDone' | 'grabScreen'>
  /** 识题结果流（与笔试窗口共用同一套主进程逻辑） */
  chat: Pick<ChatApi, 'streamStart' | 'complete'>
  onAnswerDelta: (cb: (reqId: string, delta: ChatDelta) => void) => () => void
  onAnswerDone: (cb: (reqId: string, text: string, error?: string) => void) => () => void
  /** 鼠标是否离开窗口（悬停显隐用） */
  onHoverReveal: (cb: (hidden: boolean) => void) => () => void
  modes: ModesApi
  /** 工具条只需要这几项应用能力，不必暴露完整 AppApi */
  app: Pick<AppApi, 'openWindow' | 'openDataDir' | 'closeWindow'>
  /** 系统剪贴板（走主进程，悬浮窗不聚焦也能用） */
  clipboard: ClipboardApi
  /** 电脑音频（macOS 原生采集） */
  systemAudio: SystemAudioApi
}

export interface QuizbarApi {
  /** 当前生效的穿透解锁快捷键，例如 ⌘⇧9；穿透开启时界面据此提示用户 */
  clickThroughHotkey: () => Promise<string>
  /** 立即解除穿透（界面上仍可点的场景） */
  releaseClickThrough: () => Promise<void>
  /** 鼠标穿透（开启后窗口不响应鼠标） */
  setClickThrough: (on: boolean) => Promise<void>
  /** 悬浮条不透明度 0.15-1 */
  setOpacity: (value: number) => Promise<void>
  /** 收起/展开（仅保留内容区） */
  setCollapsed: (collapsed: boolean) => Promise<void>
  /** 让出/收回焦点 */
  setFocusable: (focusable: boolean) => Promise<void>
  /** 展开/收起内容区（出答案时把窗口长高） */
  setExpanded: (expanded: boolean) => Promise<void>
  /** 直接设置窗口尺寸（无边框窗口靠手柄缩放时用） */
  setSize: (width: number, height: number) => Promise<void>
  /**
   * 退出悬浮窗。
   * save=true 时把本次问答存成会话记录；save=false 直接丢弃。
   * 对齐原版：退出时问「保存本次记录？」并给「保存并关闭 / 不保存，直接关闭」。
   */
  exit: (payload: { kind: SessionKind; title: string; items: QaRecord[]; save: boolean }) => Promise<{ savedId: string | null }>
  /** 关闭工具条（不询问、不保存） */
  close: () => Promise<void>
}

export interface QuizWindowApi {
  kind: 'quiz'
  settings: SettingsApi
  chat: ChatApi
  capture: CaptureApi
  live: LiveApi
  app: AppApi
  /** 系统剪贴板（走主进程，悬浮窗不聚焦也能用） */
  clipboard: ClipboardApi
  /** 电脑音频（macOS 原生采集） */
  systemAudio: SystemAudioApi
}

/** AI 面试窗口 */
export interface InterviewWindowApi {
  kind: 'interview'
  settings: SettingsApi
  interview: InterviewApi
  chat: ChatApi
  device: DeviceApi
  diagnostics: DiagnosticsApi
  app: AppApi
  /** 系统剪贴板（走主进程，悬浮窗不聚焦也能用） */
  clipboard: ClipboardApi
  /** 电脑音频（macOS 原生采集） */
  systemAudio: SystemAudioApi
}

/** 选区截图覆盖层窗口 */
export interface CaptureWindowApi {
  kind: 'capture'
  done: (dataUrl: string) => void
  cancel: () => void
  /** 由 capture 窗口向主进程索取待标注的底图 */
  getSource: () => Promise<string>
}

export type WindowApi =
  | MainWindowApi
  | FloatingWindowApi
  | QuizWindowApi
  | InterviewWindowApi
  | CaptureWindowApi
