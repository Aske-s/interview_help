import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { createSystemAudioApi, invoke, on } from './_common'
import type { InterviewWindowApi } from '@shared/ipc'

/** AI 面试窗口 API */

const api: InterviewWindowApi = {
  clipboard: {
    writeText: (text) => invoke(IPC.ClipboardWriteText, text)
  },
  /** 电脑音频（macOS 原生采集） */
  systemAudio: createSystemAudioApi(),
  kind: 'interview',

  settings: {
    get: () => invoke(IPC.SettingsGet),
    patch: (patch) => invoke(IPC.SettingsPatch, patch),
    patchProvider: (id, patch) => invoke(IPC.SettingsPatchProvider, id, patch),
    reset: () => invoke(IPC.SettingsReset),
    onChanged: (cb) => on(IPC.SettingsChanged, (s) => cb(s as never))
  },

  interview: {
    list: () => invoke(IPC.InterviewList),
    get: (id) => invoke(IPC.InterviewGet, id),
    create: (role, background) => invoke(IPC.InterviewCreate, role, background),
    start: (id) => invoke(IPC.InterviewStart, id),
    answer: (id, answer, elapsedMs) => invoke(IPC.InterviewAnswer, id, answer, elapsedMs),
    finish: (id) => invoke(IPC.InterviewFinish, id),
    remove: (id) => invoke(IPC.InterviewDelete, id),
    parseResume: (path) => invoke(IPC.InterviewParseResume, path),
    generateReview: (id) => invoke(IPC.InterviewGenerateReview, id)
  },

  chat: {
    complete: (messages, opts) => invoke(IPC.ChatComplete, messages, opts),
    streamStart: (requestId, messages, opts) => invoke(IPC.ChatStreamStart, requestId, messages, opts),
    streamCancel: (requestId) => invoke(IPC.ChatStreamCancel, requestId),
    onDelta: (cb) => on(IPC.ChatStreamDelta, (p: { requestId: string; delta: never }) => cb(p.requestId, p.delta)),
    onDone: (cb) => on(IPC.ChatStreamDone, (p: { requestId: string; result: never }) => cb(p.requestId, p.result)),
    onError: (cb) => on(IPC.ChatStreamError, (p: { requestId: string; error: string }) => cb(p.requestId, p.error))
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
