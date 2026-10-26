import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { createSystemAudioApi, invoke, on, send } from './_common'
import type { QuizWindowApi } from '@shared/ipc'

/** 笔试 / 截图解题窗口 API */

const api: QuizWindowApi = {
  clipboard: {
    writeText: (text) => invoke(IPC.ClipboardWriteText, text)
  },
  /** 电脑音频（macOS 原生采集） */
  systemAudio: createSystemAudioApi(),
  kind: 'quiz',

  settings: {
    get: () => invoke(IPC.SettingsGet),
    patch: (patch) => invoke(IPC.SettingsPatch, patch),
    patchProvider: (id, patch) => invoke(IPC.SettingsPatchProvider, id, patch),
    reset: () => invoke(IPC.SettingsReset),
    onChanged: (cb) => on(IPC.SettingsChanged, (s) => cb(s as never))
  },

  chat: {
    complete: (messages, opts) => invoke(IPC.ChatComplete, messages, opts),
    streamStart: (requestId, messages, opts) => invoke(IPC.ChatStreamStart, requestId, messages, opts),
    streamCancel: (requestId) => invoke(IPC.ChatStreamCancel, requestId),
    onDelta: (cb) => on(IPC.ChatStreamDelta, (p: { requestId: string; delta: never }) => cb(p.requestId, p.delta)),
    onDone: (cb) => on(IPC.ChatStreamDone, (p: { requestId: string; result: never }) => cb(p.requestId, p.result)),
    onError: (cb) => on(IPC.ChatStreamError, (p: { requestId: string; error: string }) => cb(p.requestId, p.error))
  },

  capture: {
    start: (mode) => invoke(IPC.CaptureStart, mode),
    grabScreen: (displayId) => invoke(IPC.CaptureGrabScreen, displayId),
    done: (dataUrl) => send(IPC.CaptureDone, dataUrl),
    cancel: () => send(IPC.CaptureCancel),
    save: (dataUrl) => invoke(IPC.CaptureSave, dataUrl),
    readClipboardImage: () => invoke(IPC.CaptureReadClipboardImage),
    onDone: (cb) => on(IPC.CaptureDone, (p: { dataUrl: string }) => cb(p.dataUrl)),
    answerImage: (dataUrl, prompt) => invoke(IPC.AnswerImage, dataUrl, prompt),
    onAnswerDelta: (cb) => on(IPC.AnswerImageDelta, (p: { reqId: string; delta: never }) => cb(p.reqId, p.delta)),
    onAnswerDone: (cb) =>
      on(IPC.AnswerImageDone, (p: { reqId: string; text: string; error?: string }) => cb(p.reqId, p.error ? `【出错了】${p.error}` : p.text))
  },

  live: {
    start: (opts) => invoke(IPC.LiveStart, opts),
    stop: () => invoke(IPC.LiveStop),
    state: () => invoke(IPC.LiveState),
    pushAudio: (pcm, source) => send(IPC.LivePushAudio, pcm, source),
    ask: (question) => invoke(IPC.LiveAsk, question),
    clear: () => invoke(IPC.LiveClear),
    sendAccumulated: () => invoke(IPC.LiveSendAccumulated),
    clearAccumulated: () => invoke(IPC.LiveClearAccumulated),
    resumeCapture: () => invoke(IPC.LiveResumeCapture),
    onAutoStopped: (cb) => on(IPC.LiveAutoStopped, (p) => cb(p as { seconds: number })),
    onState: (cb) => on(IPC.LiveStateChanged, (s) => cb(s as never)),
    onTranscript: (cb) => on(IPC.LiveTranscript, (p: { segment: never }) => cb(p.segment)),
    onAnswerStart: (cb) =>
      on(IPC.LiveAnswerStart, (info: { qaId: string; question: string; trigger: never }) => cb(info)),
    onAnswerAborted: (cb) => on(IPC.LiveAnswerAborted, (p: { qaId: string }) => cb(p.qaId)),
    onAnswerDelta: (cb) => on(IPC.LiveAnswerDelta, (p: { qaId: string; delta: never }) => cb(p.qaId, p.delta)),
    onAnswerDone: (cb) =>
      on(IPC.LiveAnswerDone, (p: { record: never; firstTokenMs?: number; totalMs?: number }) =>
        cb(p.record, { firstTokenMs: p.firstTokenMs, totalMs: p.totalMs })
      ),
    onSecurityAlert: (cb) => on(IPC.LiveSecurityAlert, (reason: string) => cb(reason)),
    onError: (cb) => on(IPC.LiveError, (p: { scope: string; message: string }) => cb(p.scope, p.message))
  },

  app: {
    info: () => invoke(IPC.AppInfo),
    openExternal: (url) => invoke(IPC.OpenExternal, url),
    openDataDir: () => invoke(IPC.OpenDataDir),
    pickFile: (opts) => invoke(IPC.PickFile, opts),
    saveFile: (opts) => invoke(IPC.SaveFile, opts),
    setZoom: (factor) => invoke(IPC.ZoomSet, factor),
    getZoom: () => invoke(IPC.ZoomGet),
    openWindow: (kind) => invoke(IPC.WindowOpen, kind),
    closeWindow: () => invoke(IPC.WindowClose),
    minimizeWindow: () => invoke(IPC.WindowMinimize)
  }
}

contextBridge.exposeInMainWorld('api', api)
