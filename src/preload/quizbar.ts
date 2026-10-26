import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { createSystemAudioApi, invoke, on } from './_common'
import type { QuizbarWindowApi } from '@shared/ipc'

/**
 * 悬浮工具条的预加载。
 *
 * 只暴露它需要的：设置、窗口自身控制、截图、识题流、模式。
 * 与笔试窗口共用主进程的识题逻辑，但不需要文件系统等能力。
 */
const api: QuizbarWindowApi = {
  clipboard: {
    writeText: (text) => invoke(IPC.ClipboardWriteText, text)
  },
  /** 电脑音频（macOS 原生采集） */
  systemAudio: createSystemAudioApi(),
  kind: 'quizbar',
  settings: {
    get: () => invoke(IPC.SettingsGet),
    patch: (patch) => invoke(IPC.SettingsPatch, patch),
    patchProvider: (id, patch) => invoke(IPC.SettingsPatchProvider, id, patch),
    reset: () => invoke(IPC.SettingsReset),
    onChanged: (cb) => on(IPC.SettingsChanged, cb)
  },
  bar: {
    clickThroughHotkey: () => invoke(IPC.ClickThroughHotkey),
    releaseClickThrough: () => invoke(IPC.ClickThroughRelease),
    setClickThrough: (value) => invoke(IPC.QuizbarClickThrough, value),
    setOpacity: (value) => invoke(IPC.QuizbarOpacity, value),
    setCollapsed: (collapsed) => invoke(IPC.QuizbarCollapsed, collapsed),
    setFocusable: (focusable) => invoke(IPC.QuizbarFocusable, focusable),
    setExpanded: (expanded) => invoke(IPC.QuizbarExpanded, expanded),
    setSize: (width, height) => invoke(IPC.QuizbarSetSize, width, height),
    exit: (payload) => invoke(IPC.QuizbarExit, payload),
    close: () => invoke(IPC.QuizbarClose)
  },
  capture: {
    start: (mode) => invoke(IPC.CaptureStart, mode),
    readClipboardImage: () => invoke(IPC.CaptureReadClipboardImage),
    grabScreen: (displayId) => invoke(IPC.CaptureGrabScreen, displayId),
    onDone: (cb) => on(IPC.CaptureDone, cb)
  },
  chat: {
    streamStart: (reqId, messages, opts) => invoke(IPC.ChatStreamStart, reqId, messages, opts),
    complete: (messages, opts) => invoke(IPC.ChatComplete, messages, opts)
  },
  onAnswerDelta: (cb) => on(IPC.AnswerImageDelta, cb),
  onAnswerDone: (cb) => on(IPC.AnswerImageDone, cb),
  onHoverReveal: (cb) => on(IPC.HoverRevealChanged, cb),
  modes: {
    list: () => invoke(IPC.ModesList),
    save: (mode) => invoke(IPC.ModesSave, mode),
    remove: (id) => invoke(IPC.ModesDelete, id),
    activate: (id) => invoke(IPC.ModesActivate, id),
    cycle: (direction) => invoke(IPC.ModesCycle, direction)
  },
  app: {
    openWindow: (kind) => invoke(IPC.WindowOpen, kind),
    closeWindow: () => invoke(IPC.WindowClose),
    openDataDir: () => invoke(IPC.OpenDataDir),
  }
}

contextBridge.exposeInMainWorld('api', api)
