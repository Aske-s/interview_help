import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { activeProvider, settingsStore } from '../store/settings'
import { runStream, cancelStream } from '../gateway/stream-manager'
import { chatComplete } from '../gateway/llm'
import type { ChatMessage, ProviderConfig } from '@shared/types'

/** 对话：流式与非流式。请求方（窗口）通过事件接收增量。 */

function targetFor(event: Electron.IpcMainInvokeEvent): WebContents {
  return event.sender
}

export function registerChatIpc(): void {
  ipcMain.handle(
    IPC.ChatComplete,
    async (_e, messages: ChatMessage[], opts?: { providerId?: string; json?: boolean; model?: string; temperature?: number }) => {
      const provider = resolveProvider(opts?.providerId)
      if (!provider) return { ok: false, error: '未配置模型网关，请到「设置 → 模型网关」填写' }
      try {
        const result = await chatComplete({
          provider,
          messages,
          json: opts?.json,
          model: opts?.model,
          temperature: opts?.temperature
        })
        return { ok: true, data: result }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    IPC.ChatStreamStart,
    (event, requestId: string, messages: ChatMessage[], opts?: { providerId?: string; model?: string }) => {
      const provider = resolveProvider(opts?.providerId)
      if (!provider) {
        return { ok: false, error: '未配置模型网关，请到「设置 → 模型网关」填写 baseUrl / API Key / 模型名' }
      }
      const target = targetFor(event)
      runStream(
        { requestId, provider, messages, model: opts?.model },
        {
          onDelta: (delta) => {
            if (!target.isDestroyed()) target.send(IPC.ChatStreamDelta, { requestId, delta })
          },
          onDone: (result) => {
            if (!target.isDestroyed()) target.send(IPC.ChatStreamDone, { requestId, result })
          },
          onError: (message) => {
            if (!target.isDestroyed()) target.send(IPC.ChatStreamError, { requestId, error: message })
          }
        }
      )
      return { ok: true }
    }
  )

  ipcMain.handle(IPC.ChatStreamCancel, (_e, requestId: string) => {
    cancelStream(requestId)
  })
}

export function resolveProvider(providerId?: string): ProviderConfig | undefined {
  const active = activeProvider()
  if (!providerId) return active
  return settingsStore.get().providers.find((p) => p.id === providerId) ?? active
}
