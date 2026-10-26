import { createDefaultModes } from '@shared/defaults'
import type { Mode, Settings } from '@shared/types'
import type { DeepPartial } from '@shared/ipc'

/**
 * 模式（原版 aim:modes）的读写与套用。
 *
 * 原版把「会议 / 笔试 / 面试」各自的一整套参数（音频来源、答题风格、悬浮窗透明度…）
 * 做成可切换的预设，切换模式即切换整场会话的行为。这里保持同样的语义。
 */

/** 从任意（可能是旧版/损坏的）数据里收敛出一个合法模式 */
export function normalizeMode(raw: Partial<Mode> | null | undefined, fallback: Mode): Mode {
  const src = raw ?? {}
  const pick = <K extends keyof Mode>(key: K, def: Mode[K]): Mode[K] => {
    const v = src[key]
    return v === undefined || v === null ? def : (v as Mode[K])
  }
  const clamp = (v: unknown, lo: number, hi: number, def: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def
    return Math.min(hi, Math.max(lo, Math.round(n)))
  }

  const type = src.type === 'quiz' || src.type === 'interview' || src.type === 'meeting' ? src.type : fallback.type
  const audioSource =
    src.audioSource === 'system' || src.audioSource === 'both' || src.audioSource === 'mic'
      ? src.audioSource
      : fallback.audioSource

  return {
    id: typeof src.id === 'string' && src.id.trim() ? src.id.trim() : fallback.id,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : fallback.name,
    description: typeof src.description === 'string' ? src.description : fallback.description,
    type,
    kind: typeof src.kind === 'string' && src.kind ? src.kind : fallback.kind,
    defaultKey: typeof src.defaultKey === 'string' ? src.defaultKey : undefined,
    speechToText: Boolean(pick('speechToText', fallback.speechToText)),
    audioSource,
    speechLanguage:
      typeof src.speechLanguage === 'string' && src.speechLanguage ? src.speechLanguage : fallback.speechLanguage,
    microphoneId: typeof src.microphoneId === 'string' ? src.microphoneId : '',
    volume: clamp(src.volume, 0, 100, fallback.volume),
    excludeSelfVoice: Boolean(pick('excludeSelfVoice', fallback.excludeSelfVoice)),
    aliyunMaxSentenceSilenceMs: clamp(
      src.aliyunMaxSentenceSilenceMs,
      200,
      5000,
      fallback.aliyunMaxSentenceSilenceMs
    ),
    autoAnswer: Boolean(pick('autoAnswer', fallback.autoAnswer)),
    answerStyle: src.answerStyle === 'detailed' ? 'detailed' : src.answerStyle === 'concise' ? 'concise' : fallback.answerStyle,
    responseSpeed:
      src.responseSpeed === 'fast' || src.responseSpeed === 'slow' || src.responseSpeed === 'balanced'
        ? src.responseSpeed
        : fallback.responseSpeed,
    knowledgeBaseIds: Array.isArray(src.knowledgeBaseIds)
      ? src.knowledgeBaseIds.filter((x): x is string => typeof x === 'string')
      : [],
    overlayOpacity: clamp(src.overlayOpacity, 20, 100, fallback.overlayOpacity),
    autoHideMain: Boolean(pick('autoHideMain', fallback.autoHideMain)),
    quizConfig: type === 'quiz' ? normalizeQuizConfig(src.quizConfig) : undefined,
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : Date.now(),
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : Date.now()
  }
}

function normalizeQuizConfig(raw: Partial<Mode['quizConfig']> | undefined): NonNullable<Mode['quizConfig']> {
  return {
    shortcut:
      typeof raw?.shortcut === 'string' && raw.shortcut ? raw.shortcut : 'CommandOrControl+Shift+Q',
    jpegQuality:
      typeof raw?.jpegQuality === 'number' && Number.isFinite(raw.jpegQuality)
        ? Math.min(100, Math.max(10, Math.round(raw.jpegQuality)))
        : 80,
    useMediaKey: raw?.useMediaKey === true,
    systemPrompt: typeof raw?.systemPrompt === 'string' ? raw.systemPrompt : '',
    kind: raw?.kind === 'coding' ? 'coding' : 'normal',
    codeMode: raw?.codeMode === 'acm' ? 'acm' : 'core',
    language: typeof raw?.language === 'string' && raw.language ? raw.language : 'auto',
    solveMode: raw?.solveMode === 'agent' ? 'agent' : 'normal'
  }
}

/**
 * 收敛整份模式列表：保证预置模式存在、id 唯一、字段合法。
 * 旧数据（或用户手工编辑 settings.json 出错）不能把界面搞崩。
 */
export function normalizeModes(raw: unknown, now = Date.now()): Mode[] {
  const defaults = createDefaultModes(now)
  const list = Array.isArray(raw) ? raw : []
  const byId = new Map<string, Mode>()

  // 先放入用户模式（非预置）
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const partial = item as Partial<Mode>
    // 预置模式以代码里的定义为准，避免用户误删后功能缺失
    if (typeof partial.id === 'string' && partial.id.startsWith('system:default:')) continue
    /*
     * 注意：fallback 的 type 必须是**合法值**。
     * 早期写法把 partial.type 直接塞进 fallback，导致非法 type 绕过校验又被回退逻辑捡回去，
     * 校验形同虚设（测试抓到的真实缺陷）。
     */
    const safeType: Mode['type'] =
      partial.type === 'quiz' || partial.type === 'interview' || partial.type === 'meeting' ? partial.type : 'meeting'
    const fallback: Mode = {
      ...defaults[0],
      id: partial.id ?? `mode-${byId.size + 1}`,
      type: safeType
    }
    const mode = normalizeMode(partial, fallback)
    if (!byId.has(mode.id)) byId.set(mode.id, mode)
  }

  // 预置模式始终存在，且放在前面
  return [...defaults, ...byId.values()]
}

/** 解析当前激活模式；找不到就回退到第一个 */
export function activeMode(settings: Settings): Mode {
  return settings.modes.find((m) => m.id === settings.activeModeId) ?? settings.modes[0]
}

/**
 * 把模式套用到设置上。
 *
 * 模式是「会话行为」的集合，因此切换模式会同步 asrTuning / voiceprint / ui.opacity 等，
 * 这与原版「切换模式即改变整场会话行为」一致。
 *
 * 注意：**不要**在这里返回 modes 数组本身。模式数组由 settingsStore 维护，
 * 这里只负责把「当前激活哪个模式」以及它派生的全局项写进去。
 */
export function modeToSettingsPatch(mode: Mode): DeepPartial<Settings> {
  return {
    activeModeId: mode.id,
    asrTuning: {
      autoAnswer: mode.autoAnswer,
      silenceMs: mode.aliyunMaxSentenceSilenceMs
    },
    voiceprint: { enabled: mode.excludeSelfVoice },
    /*
     * 单位换算：模式的 overlayOpacity 是 0-100（对齐原版 70 这个口径），
     * 而 ui.opacity 是 0-1（直接喂给 BrowserWindow.setOpacity 与 --ss-panel-alpha）。
     * 不换算会把透明度写成 70 → 被 clamp 成 1 → 悬浮窗变全不透明。
     */
    ui: { opacity: overlayOpacityToUi(mode.overlayOpacity) },
    audio: { micDeviceId: mode.microphoneId }
  }
}

/** 模式口径（0-100）→ 界面口径（0.15-1） */
export function overlayOpacityToUi(overlayOpacity: number): number {
  const pct = Math.min(100, Math.max(20, Number.isFinite(overlayOpacity) ? overlayOpacity : 70))
  return Math.min(1, Math.max(0.15, Math.round(pct) / 100))
}

/** 界面口径（0.15-1）→ 模式口径（0-100） */
export function uiOpacityToOverlay(opacity: number): number {
  const v = Number.isFinite(opacity) ? opacity : 0.7
  return Math.min(100, Math.max(20, Math.round(v * 100)))
}

/** 模式里与「回答速度」对应的长度上限，供网关侧套用 */
export function modeMaxTokens(mode: Mode): number {
  return { fast: 1024, balanced: 2048, slow: 4096 }[mode.responseSpeed]
}
