import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { enroll, VOICEPRINT_MIN_ENROLL_CHUNKS } from '../voiceprint'
import { loadProfile, saveProfile } from '../voiceprint/store'
import { live } from '../live/orchestrator'

/**
 * 声纹录入 / 状态 / 清除。
 *
 * 录入音频由渲染层采集后传进来（16kHz 单声道 PCM16），
 * 因为设备采集只能在渲染进程完成。
 */

function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof ArrayBuffer) return Buffer.from(payload)
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  return Buffer.alloc(0)
}

export function registerVoiceprintIpc(): void {
  ipcMain.handle(IPC.VoiceprintEnroll, (_e, payload: unknown[]) => {
    try {
      const chunks = (Array.isArray(payload) ? payload : []).map(toBuffer).filter((b) => b.length > 0)
      if (chunks.length < VOICEPRINT_MIN_ENROLL_CHUNKS) {
        return { ok: false, error: `采集到的音频段太少（${chunks.length} 段），请重试并持续说话约 6 秒` }
      }
      const profile = enroll('我', chunks)
      saveProfile(profile)
      // 让正在进行的会话立刻用上新声纹
      live.refreshVoiceprint()
      return { ok: true, data: { samples: profile.samples } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.VoiceprintStatus, () => {
    const profile = loadProfile()
    return {
      enrolled: Boolean(profile),
      samples: profile?.samples ?? 0,
      createdAt: profile?.createdAt ?? null
    }
  })

  ipcMain.handle(IPC.VoiceprintReset, () => {
    saveProfile(null)
    live.refreshVoiceprint()
  })
}
