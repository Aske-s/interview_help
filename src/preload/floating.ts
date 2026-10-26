import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { createSystemAudioApi, invoke, on, send } from './_common'
import type { FloatingWindowApi } from '@shared/ipc'

/** 悬浮窗 API */

const api: FloatingWindowApi = {
  clipboard: {
    writeText: (text) => invoke(IPC.ClipboardWriteText, text)
  },
  /** 电脑音频（macOS 原生采集） */
  systemAudio: createSystemAudioApi(),
  kind: 'floating',

  settings: {
    get: () => invoke(IPC.SettingsGet),
    patch: (patch) => invoke(IPC.SettingsPatch, patch),
    patchProvider: (id, patch) => invoke(IPC.SettingsPatchProvider, id, patch),
    reset: () => invoke(IPC.SettingsReset),
    onChanged: (cb) => on(IPC.SettingsChanged, (s) => cb(s as never))
  },

  live: {
    start: (opts) => invoke(IPC.LiveStart, opts),
    stop: () => invoke(IPC.LiveStop),
    state: () => invoke(IPC.LiveState),
    // 音频走 send：高频，不需要返回值
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

  floating: {
    // 悬浮窗自身不用「请求开始」，只是满足 API 形状（真正开跑走 onStartRequested）
    start: (opts) => invoke(IPC.FloatingStart, opts),
    toggle: () => invoke(IPC.FloatingToggle),
    show: () => invoke(IPC.FloatingShow),
    hide: () => invoke(IPC.FloatingHide),
    setOpacity: (v) => invoke(IPC.FloatingSetOpacity, v),
    setClickThrough: (v) => invoke(IPC.FloatingSetClickThrough, v),
    setIgnoreFocus: (v) => invoke(IPC.FloatingSetIgnoreFocus, v),
    resize: (w, h) => invoke(IPC.FloatingResize, w, h),
    moveBy: (dx, dy) => invoke(IPC.FloatingMoveBy, dx, dy)
  },

  /** 主窗口点「开始」后，由主进程转达过来：悬浮窗据此自己走设备检查并开跑 */
  onStartRequested: (cb) =>
    on(IPC.FloatingStartRequested, (p: { kind: never; title?: string }) => cb({ kind: p.kind, title: p.title })),

  capture: {
    start: (mode) => invoke(IPC.CaptureStart, mode),
    grabScreen: (displayId) => invoke(IPC.CaptureGrabScreen, displayId),
    readClipboardImage: () => invoke(IPC.CaptureReadClipboardImage),
    onDone: (cb) => on(IPC.CaptureDone, (p: { dataUrl: string }) => cb(p.dataUrl))
  },

  device: {
    // 设备枚举必须在渲染进程用 navigator.mediaDevices 完成
    listAudioDevices: async () => [],
    getPermissions: () => invoke(IPC.GetPermissions),
    requestPermission: (kind) => invoke(IPC.RequestPermission, kind),
    openSystemSettings: (kind) => invoke(IPC.OpenSystemSettings, kind),
    probeScreenCapture: () => invoke(IPC.ProbeScreenCapture)
  },

  diagnostics: {
    saveDeviceCheck: (result) => invoke(IPC.DeviceCheckSave, result),
    scanSecurity: () => invoke(IPC.SecurityScan),
    getCheckState: () => invoke(IPC.CheckStateGet),
    recorders: () => invoke(IPC.CheckRecorders),
    appName: () => invoke(IPC.AppDisplayName),
    onCheckStateChanged: (cb) => on(IPC.CheckStateChanged, (s) => cb(s as never))
  },

  modes: {
    list: () => invoke(IPC.ModesList),
    save: (mode) => invoke(IPC.ModesSave, mode),
    remove: (id) => invoke(IPC.ModesDelete, id),
    activate: (id) => invoke(IPC.ModesActivate, id),
    cycle: (direction) => invoke(IPC.ModesCycle, direction)
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
