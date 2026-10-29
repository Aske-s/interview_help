import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { createSystemAudioApi, invoke, on } from './_common'
import type { MainWindowApi } from '@shared/ipc'

/** 主窗口（控制台）API */

const api: MainWindowApi = {
  clipboard: {
    writeText: (text) => invoke(IPC.ClipboardWriteText, text)
  },
  /** 电脑音频（macOS 原生采集） */
  systemAudio: createSystemAudioApi(),
  kind: 'main',

  settings: {
    get: () => invoke(IPC.SettingsGet),
    patch: (patch) => invoke(IPC.SettingsPatch, patch),
    patchProvider: (id, patch) => invoke(IPC.SettingsPatchProvider, id, patch),
    reset: () => invoke(IPC.SettingsReset),
    onChanged: (cb) => on(IPC.SettingsChanged, (s) => cb(s as never))
  },

  gateway: {
    test: (provider) => invoke(IPC.GatewayTest, provider),
    listModels: (provider) => invoke(IPC.GatewayListModels, provider),
    testAsr: (asr) => invoke(IPC.GatewayTestAsr, asr)
  },

  chat: {
    complete: (messages, opts) => invoke(IPC.ChatComplete, messages, opts),
    streamStart: (requestId, messages, opts) => invoke(IPC.ChatStreamStart, requestId, messages, opts),
    streamCancel: (requestId) => invoke(IPC.ChatStreamCancel, requestId),
    onDelta: (cb) => on(IPC.ChatStreamDelta, (payload: { requestId: string; delta: never }) => cb(payload.requestId, payload.delta)),
    onDone: (cb) => on(IPC.ChatStreamDone, (payload: { requestId: string; result: never }) => cb(payload.requestId, payload.result)),
    onError: (cb) => on(IPC.ChatStreamError, (payload: { requestId: string; error: string }) => cb(payload.requestId, payload.error))
  },

  sessions: {
    list: (kind) => invoke(IPC.SessionList, kind),
    get: (id) => invoke(IPC.SessionGet, id),
    create: (kind, title) => invoke(IPC.SessionCreate, kind, title),
    update: (id, patch) => invoke(IPC.SessionUpdate, id, patch),
    remove: (id) => invoke(IPC.SessionDelete, id),
    appendTranscript: (id, segment) => invoke(IPC.SessionAppendTranscript, id, segment),
    appendQa: (id, qa) => invoke(IPC.SessionAppendQa, id, qa)
  },

  agents: {
    list: () => invoke(IPC.AgentList),
    save: (agent) => invoke(IPC.AgentSave, agent),
    remove: (id) => invoke(IPC.AgentDelete, id)
  },

  knowledge: {
    list: () => invoke(IPC.KbList),
    create: (name, description, purpose) => invoke(IPC.KbCreate, name, description, purpose),
    setPurpose: (kbId, purpose) => invoke(IPC.KbSetPurpose, kbId, purpose),
    distillResume: (kbId) => invoke(IPC.KbDistillResume, kbId),
    remove: (id) => invoke(IPC.KbDelete, id),
    addDocument: (kbId, payload) => invoke(IPC.KbAddDocument, kbId, payload),
    removeDocument: (docId) => invoke(IPC.KbRemoveDocument, docId),
    listDocuments: (kbId) => invoke(IPC.KbListDocuments, kbId),
    search: (kbIds, query, topK) => invoke(IPC.KbSearch, kbIds, query, topK)
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

  todos: {
    list: () => invoke(IPC.TodoList),
    add: (text, sessionId) => invoke(IPC.TodoAdd, text, sessionId),
    toggle: (id) => invoke(IPC.TodoToggle, id),
    remove: (id) => invoke(IPC.TodoDelete, id)
  },

  live: {
    start: (opts) => invoke(IPC.LiveStart, opts),
    stop: () => invoke(IPC.LiveStop),
    state: () => invoke(IPC.LiveState),
    pushAudio: (pcm, source) => invoke(IPC.LivePushAudio, pcm, source),
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

  voiceprint: {
    enroll: (chunks) => invoke(IPC.VoiceprintEnroll, chunks),
    status: () => invoke(IPC.VoiceprintStatus),
    reset: () => invoke(IPC.VoiceprintReset)
  },

  guard: {
    support: () => invoke(IPC.GuardSupport),
    status: () => invoke(IPC.GuardStatus),
    enable: (side) => invoke(IPC.GuardEnable, side),
    disable: () => invoke(IPC.GuardDisable),
    setSecureInput: (on) => invoke(IPC.SecureInputSet, on)
  },

  floating: {
    start: (opts) => invoke(IPC.FloatingStart, opts)
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
