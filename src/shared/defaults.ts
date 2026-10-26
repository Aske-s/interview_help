import type { Mode, Settings } from './types'

export const SETTINGS_VERSION = 1

export const DEFAULT_PROVIDER = {
  id: 'default',
  name: '我的网关',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  supportsVision: false,
  // 默认不发送 reasoning_effort，交由网关/模型决定
  reasoningEffort: 'auto' as const,
  // 默认不发送 temperature：推理模型普遍不接受它
  temperature: undefined as number | undefined,
  maxTokens: 2048,
  // auto：按模型名推断，且网关报错时自动纠正
  maxTokensParam: 'auto' as const,
  extraBody: ''
}

/** 内置智能体模板（可编辑/可删） */
export const BUILTIN_AGENTS = [
  {
    id: 'builtin-meeting',
    name: '会议助手',
    persona: '你是一名资深的会议参谋，擅长在听会时快速抓住对方问题的要点。',
    style:
      '先给出一句话结论，再用 2-4 个要点展开；语气自然、口语化，方便直接照读；不要输出 Markdown 标题和冗余寒暄。',
    knowledgeBaseIds: [],
    // 原版工作流 memory.window 的默认值就是 10 轮
    memoryRounds: 10,
    builtin: true
  },
  {
    id: 'builtin-interview-tech',
    name: '技术面试官（助答）',
    persona:
      '你是一名有 10 年经验的一线工程师，正在帮助候选人回答技术面试问题。熟悉后端、分布式、数据库与算法。',
    style:
      '按「结论 → 关键原理 → 项目落地例子 → 可能的追问」组织；技术细节要准确，不确定的地方要说明边界，不要编造。',
    knowledgeBaseIds: [],
    // 原版工作流 memory.window 的默认值就是 10 轮
    memoryRounds: 10,
    builtin: true
  },
  {
    id: 'builtin-quiz',
    name: '笔试解题',
    persona: '你是一名算法竞赛选手，擅长看图理解题意并快速给出正确解法。',
    style:
      '先用一两句话说明思路与复杂度，再给出完整可运行代码；代码块标注语言；不要多余解释。',
    knowledgeBaseIds: [],
    memoryRounds: 10,
    builtin: true
  }
]


/** 系统预置模式：字段名与取值对齐原版 aim:modes 的存储结构 */
export function createDefaultModes(now = Date.now()): Mode[] {
  const base = {
    kind: 'normal',
    speechToText: true,
    audioSource: 'mic' as const,
    speechLanguage: 'zh-CN',
    microphoneId: '',
    volume: 80,
    excludeSelfVoice: false,
    aliyunMaxSentenceSilenceMs: 800,
    autoAnswer: true,
    responseSpeed: 'balanced' as const,
    knowledgeBaseIds: [] as string[],
    overlayOpacity: 70,
    autoHideMain: false,
    createdAt: now,
    updatedAt: now
  }
  return [
    {
      ...base,
      id: 'system:default:meeting',
      defaultKey: 'system:default:meeting',
      name: '默认会议助手',
      description: '实时转写对方提问并由 AI 生成参考答案',
      type: 'meeting',
      answerStyle: 'concise'
    },
    {
      ...base,
      id: 'system:default:quiz',
      defaultKey: 'system:default:quiz',
      name: '默认笔试助手',
      description: '截屏 + 多模态 AI 快速拿到题解',
      type: 'quiz',
      answerStyle: 'detailed',
      quizConfig: {
        shortcut: 'CommandOrControl+Shift+Q',
        jpegQuality: 80,
        useMediaKey: false,
        systemPrompt: '',
        kind: 'normal',
        codeMode: 'core',
        language: 'auto',
        solveMode: 'normal'
      }
    },
    {
      ...base,
      id: 'system:default:interview',
      defaultKey: 'system:default:interview',
      name: '默认面试助手',
      description: 'AI 面试官提问，实时给出作答建议与复盘',
      type: 'interview',
      answerStyle: 'detailed',
      autoAnswer: false
    }
  ]
}

export function createDefaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    providers: [{ ...DEFAULT_PROVIDER }],
    activeProviderId: DEFAULT_PROVIDER.id,
    modes: createDefaultModes(),
    activeModeId: 'system:default:meeting',
    asr: {
      kind: 'openai-compat',
      baseUrl: '',
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
      binaryPath: '',
      modelPath: '',
      extraArgs: '',
      serverUrl: 'http://127.0.0.1:8178',
      autoStartServer: true,
      serverBinaryPath: '',
      vadModelPath: '',
      // 对齐原版 aliyunMaxSentenceSilenceMs: 800
      vadSilenceMs: 800,
      vadThreshold: 0.5,
      realtimeUrl: '',
      realtimeModel: 'paraformer-realtime-v2',
      // 会议转写场景按官方建议用语义断句；要低延迟可改 false
      semanticPunctuation: false,
      punctuationPrediction: true,
      inverseTextNormalization: true
    },
    asrTuning: {
      silenceMs: 800,
      maxSegmentMs: 12000,
      minSegmentMs: 350,
      hotwords: [],
      autoAnswer: true,
      autoAnswerMinChars: 4,
      cumulative: false,
      // 5 分钟无人发言则自动停止采集，避免长时间空录
      silenceAutoStopSec: 300
    },
    translate: {
      enabled: false,
      target: 'zh'
    },
    voiceprint: {
      enabled: false,
      threshold: 0.72,
      keepInContext: true
    },
    embedding: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: 'text-embedding-3-small'
    },
    ui: {
      theme: 'dark',
      opacity: 0.92,
      language: 'zh-CN'
    },
    stealth: {
      contentProtection: true,
      safeMode: false,
      releaseFocus: true,
      clickThrough: false,
      hoverReveal: false,
      // 移开后几乎全透明，视觉上就是「消失」，但窗口还在（鼠标移回即可恢复）
      hoverRevealOpacity: 0.06,
      autoCollapse: false,
      hideCursor: false,
      rememberSafeMode: false,
      autoSaveOnExit: false
    },
    hotkeys: {
      // 留空 = 用内置兜底键（原版同样设计）
      toggleClickThrough: '',
      toggleHoverReveal: '',
      toggleFloating: 'CommandOrControl+Shift+Space',
      answerNow: 'CommandOrControl+Shift+A',
      screenshot: 'CommandOrControl+Shift+Q',
      clearSession: 'CommandOrControl+Shift+X'
    },
    audio: {
      micDeviceId: '',
      cameraDeviceId: '',
      micEnabled: true,
      systemAudioEnabled: false,
      systemAudioSource: 'loopback',
      virtualDeviceLabel: ''
    },
    agents: BUILTIN_AGENTS.map((a) => ({ ...a, knowledgeBaseIds: [...a.knowledgeBaseIds] })),
    activeAgentId: BUILTIN_AGENTS[0].id,
    // 默认开启：原版会在开始前先确认摄像头与麦克风权限
    preflightCheck: true,
    quizPrep: { lastName: '', saveRecord: true }
  }
}

/** 递归合并补丁，数组整体替换 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return base
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    const current = out[key]
    if (Array.isArray(value)) {
      out[key] = value
    } else if (value && typeof value === 'object' && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeSettings(current as Settings, value)
    } else {
      out[key] = value
    }
  }
  return out as unknown as Settings
}
