import { globalShortcut } from 'electron'
import { IPC } from '@shared/ipc'
import { settingsStore } from './store/settings'
import { getWindow, broadcast } from './windows'

/**
 * 鼠标穿透的「逃逸通道」。
 *
 * 穿透开启后窗口完全不响应鼠标——如果没有快捷键能解除，用户就被永久困住了。
 * 原版的做法（dist-electron/main.js）：
 *   var mi = "CommandOrControl+Shift+9"
 *   registerClickThroughUnlockFallback() { register(mi, () => releaseOverlayClickThrough()) }
 *   并且在用户自己配了 toggleClickThrough 时注销兜底键。
 * 这里照做。
 */

/** 内置兜底键（与原版一致） */
export const CLICK_THROUGH_FALLBACK = 'CommandOrControl+Shift+9'

let fallbackRegistered = false

/** 解除所有悬浮窗的鼠标穿透，并落盘 */
export function releaseClickThrough(): void {
  const settings = settingsStore.get()
  settingsStore.patch({ stealth: { clickThrough: false, hoverReveal: settings.stealth.hoverReveal } })
  for (const kind of ['floating', 'quizbar'] as const) {
    const win = getWindow(kind)
    if (win && !win.isDestroyed()) {
      try {
        win.setIgnoreMouseEvents(false)
      } catch {
        /* 忽略 */
      }
    }
  }
  broadcast(IPC.SettingsChanged, settingsStore.get())
  console.log('[clickThrough] 已解除所有悬浮窗的鼠标穿透')
}

/** 切换穿透；返回切换后的状态 */
export function toggleClickThrough(): boolean {
  const next = !settingsStore.get().stealth.clickThrough
  settingsStore.patch({ stealth: { clickThrough: next } })
  const settings = settingsStore.get()
  for (const kind of ['floating', 'quizbar'] as const) {
    const win = getWindow(kind)
    if (win && !win.isDestroyed()) {
      try {
        win.setIgnoreMouseEvents(next, { forward: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  broadcast(IPC.SettingsChanged, settings)
  return next
}

/** 切换悬停显隐 */
export function toggleHoverReveal(): boolean {
  const next = !settingsStore.get().stealth.hoverReveal
  settingsStore.patch({ stealth: { hoverReveal: next } })
  broadcast(IPC.SettingsChanged, settingsStore.get())
  return next
}

/**
 * 注册穿透快捷键。
 *
 * 与界面上的开关保持同步：每次调用先清掉旧的，避免重复注册。
 */
export function registerClickThroughHotkey(): { accelerator: string; ok: boolean; isFallback: boolean } {
  globalShortcut.unregister(CLICK_THROUGH_FALLBACK)
  fallbackRegistered = false

  const userKey = (settingsStore.get().hotkeys.toggleClickThrough || '').trim()
  if (userKey) {
    try {
      globalShortcut.unregister(userKey)
      const ok = globalShortcut.register(userKey, () => {
        toggleClickThrough()
      })
      // 用户配了自己的键 → 不需要兜底（原版同样逻辑）
      return { accelerator: userKey, ok, isFallback: false }
    } catch (e) {
      console.warn('[clickThrough] 用户快捷键注册失败，回退到兜底键：', e)
    }
  }

  try {
    globalShortcut.unregister(CLICK_THROUGH_FALLBACK)
    const ok = globalShortcut.register(CLICK_THROUGH_FALLBACK, () => {
      releaseClickThrough()
    })
    fallbackRegistered = ok
    return { accelerator: CLICK_THROUGH_FALLBACK, ok, isFallback: true }
  } catch {
    return { accelerator: CLICK_THROUGH_FALLBACK, ok: false, isFallback: true }
  }
}

/** 当前生效的穿透快捷键（界面用来提示用户怎么关） */
export function activeClickThroughHotkey(): string {
  const userKey = (settingsStore.get().hotkeys.toggleClickThrough || '').trim()
  return userKey || CLICK_THROUGH_FALLBACK
}

export function isFallbackRegistered(): boolean {
  return fallbackRegistered
}
