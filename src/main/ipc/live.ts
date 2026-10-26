import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { live } from '../live/orchestrator'
import { broadcast } from '../windows'
import type { SessionKind } from '@shared/types'

/** 实时会话 IPC：把编排器事件转发给所有窗口 */

function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof ArrayBuffer) return Buffer.from(payload)
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  if (Array.isArray(payload)) return Buffer.from(payload)
  return Buffer.alloc(0)
}

export function registerLiveIpc(): void {
  live.on('state', (state) => broadcast(IPC.LiveStateChanged, state))
  live.on('transcript', (segment) => broadcast(IPC.LiveTranscript, { segment }))
  live.on('answerStart', (payload) => broadcast(IPC.LiveAnswerStart, payload))
  live.on('answerAborted', (payload) => broadcast(IPC.LiveAnswerAborted, payload))
  live.on('answerDelta', (payload) => broadcast(IPC.LiveAnswerDelta, payload))
  live.on('answerDone', (payload) => broadcast(IPC.LiveAnswerDone, payload))
  live.on('security', (reason) => broadcast(IPC.LiveSecurityAlert, reason))
  live.on('error', (payload) => broadcast(IPC.LiveError, payload))
  live.on('autoStop', (payload) => broadcast(IPC.LiveAutoStopped, payload))

  ipcMain.handle(IPC.LiveStart, (_e, opts?: { kind?: SessionKind; title?: string }) => {
    try {
      return { ok: true, data: live.start(opts?.kind ?? 'meeting', opts?.title) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.LiveStop, () => live.stop())
  ipcMain.handle(IPC.LiveState, () => live.getState())

  ipcMain.handle(IPC.LiveAsk, async (_e, question?: string) => {
    try {
      await live.ask(question)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.LiveClear, () => live.clear())

  ipcMain.handle(IPC.LiveSendAccumulated, () => {
    try {
      live.sendAccumulated()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.LiveClearAccumulated, () => live.clearAccumulated())
  ipcMain.handle(IPC.LiveResumeCapture, () => live.resumeFromAutoStop())

  // 音频用 send（高频、无需响应）
  ipcMain.on(IPC.LivePushAudio, (_e, payload: unknown, source: 'mic' | 'system') => {
    live.pushAudio(toBuffer(payload), source)
  })
}
