import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { Mode } from '@shared/types'
import { settingsStore } from '../store/settings'
import { activeMode, modeToSettingsPatch, normalizeMode } from '../store/modes'
import { broadcast } from '../windows'

/**
 * 模式（会议/笔试/面试预设）的 IPC。
 *
 * 切换模式会把整套参数（音频来源、答题风格、悬浮窗透明度…）套用到设置上，
 * 并把回答长度上限同步给当前网关——避免出现「切了模式但行为没变」。
 */
export function registerModesIpc(): void {
  ipcMain.handle(IPC.ModesList, () => settingsStore.get().modes)

  ipcMain.handle(IPC.ModesSave, (_e, input: Partial<Mode> & { name: string; type: Mode['type'] }) => {
    const settings = settingsStore.get()
    const existing = input.id ? settings.modes.find((m) => m.id === input.id) : undefined
    const fallback: Mode = existing ?? { ...activeMode(settings), id: '', name: input.name, type: input.type }
    const mode = normalizeMode(
      { ...input, id: input.id || `mode-${Date.now().toString(36)}`, updatedAt: Date.now() },
      fallback
    )
    // 预置模式的 id/名称不可被改写，避免破坏系统预设
    if (existing?.defaultKey) {
      mode.defaultKey = existing.defaultKey
      mode.id = existing.id
    }
    const modes = existing ? settings.modes.map((m) => (m.id === mode.id ? mode : m)) : [...settings.modes, mode]
    settingsStore.patch({ modes })
    return mode
  })

  ipcMain.handle(IPC.ModesDelete, (_e, id: string) => {
    const settings = settingsStore.get()
    const target = settings.modes.find((m) => m.id === id)
    if (!target) return { ok: false, error: '模式不存在' }
    if (target.defaultKey) return { ok: false, error: '系统预置模式不可删除' }
    const modes = settings.modes.filter((m) => m.id !== id)
    if (!modes.length) return { ok: false, error: '至少保留一个模式' }
    const patch: Record<string, unknown> = { modes }
    // 删掉的是当前激活模式时，切到第一个
    if (settings.activeModeId === id) patch.activeModeId = modes[0].id
    settingsStore.patch(patch)
    return { ok: true }
  })

  ipcMain.handle(IPC.ModesActivate, (_e, id: string) => {
    const settings = settingsStore.get()
    const mode = settings.modes.find((m) => m.id === id)
    if (!mode) return { ok: false, error: '模式不存在' }
    applyMode(mode)
    return { ok: true, data: mode }
  })

  ipcMain.handle(IPC.ModesCycle, (_e, direction: 1 | -1) => {
    const settings = settingsStore.get()
    const list = settings.modes
    if (!list.length) return activeMode(settings)
    const index = Math.max(0, list.findIndex((m) => m.id === settings.activeModeId))
    const next = list[(index + (direction === 1 ? 1 : -1) + list.length) % list.length]
    applyMode(next)
    return next
  })
}

/** 套用模式并把派生的长度上限同步到当前网关 */
function applyMode(mode: Mode): void {
  settingsStore.patch(modeToSettingsPatch(mode))
  const settings = settingsStore.get()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (provider) {
    const maxTokens = { fast: 1024, balanced: 2048, slow: 4096 }[mode.responseSpeed]
    settingsStore.patchProvider(provider.id, { maxTokens })
  }
  broadcast(IPC.SettingsChanged, settingsStore.get())
}
