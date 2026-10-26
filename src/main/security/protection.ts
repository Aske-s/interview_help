import type { BrowserWindow } from 'electron'
import { settingsStore } from '../store/settings'

/**
 * 内容保护登记表（对齐原版 CaptureProtectionRegistry）。
 *
 * 原版的核心不是「开一次 setContentProtection」，而是**每次窗口要显示/尺寸变化时都重新应用**：
 *   · 包装 win.show / showInactive / restore：调用前先重新保护
 *   · 监听 show / restore / resize / move / enter-full-screen / leave-full-screen
 * macOS 上 setContentProtection 会在窗口重新显示、缩放、进出全屏后被系统重置，
 * 只做一次性设置会出现「共享时有时能看到随思」的偶发漏光。
 *
 * 需要明确的是：原版**没有**隐藏进程、没有改进程名、没有隐藏 Dock 图标。
 * 防识别完全依赖 setContentProtection —— 让窗口内容在系统录屏/截屏 API 里变成空白。
 * 腾讯会议、飞书的屏幕共享走的正是这个 API；只截图监考的笔试平台同理看不到。
 */

interface Entry {
  protected: boolean
  cleanups: Array<() => void>
}

const entries = new Map<number, Entry>()

/** 显示相关方法：调用前先重新保护，避免「先露出来再遮上」 */
const SHOW_METHODS = ['show', 'showInactive', 'restore'] as const
/** 会让保护失效的事件：发生后重新保护 */
const RESET_EVENTS = [
  'show',
  'restore',
  'resize',
  'move',
  'enter-full-screen',
  'leave-full-screen'
] as const

/** 由 index.ts 注入窗口清单，避免这里直接依赖 windows 模块造成循环引用 */
let windowsProvider: () => BrowserWindow[] = () => []
export function setWindowsProvider(fn: () => BrowserWindow[]): void {
  windowsProvider = fn
}

/** 是否需要保护（安全模式或防录屏开关任一开启） */
function protectionWanted(): boolean {
  const s = settingsStore.get().stealth
  return Boolean(s.safeMode || s.contentProtection)
}

/**
 * 给窗口套上内容保护，并保证它持续有效。幂等。
 */
export function trackProtectedWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || entries.has(win.id)) return

  const cleanups: Array<() => void> = []
  // 注意：包装 show 会改 window 上的方法，必须在窗口创建后、显示前完成
  for (const method of SHOW_METHODS) {
    const original = win[method] as unknown
    if (typeof original !== 'function') continue
    const wrapped = function (this: BrowserWindow, ...args: unknown[]): unknown {
      if (!win.isDestroyed()) reapply(win)
      return (original as (...a: unknown[]) => unknown).apply(win, args)
    }
    ;(win[method] as unknown) = wrapped
    cleanups.push(() => {
      if ((win[method] as unknown) === wrapped) (win[method] as unknown) = original
    })
  }

  for (const event of RESET_EVENTS) {
    const handler = (): void => {
      reapply(win)
    }
    win.on(event as never, handler)
    cleanups.push(() => win.removeListener(event as never, handler))
  }

  entries.set(win.id, { protected: false, cleanups })
  win.once('closed', () => {
    for (const fn of cleanups) fn()
    entries.delete(win.id)
  })

  reapply(win)
}

/** 记住这个窗口需要保护（原版 remember） */
export function rememberProtected(win: BrowserWindow, shouldProtect: boolean): void {
  trackProtectedWindow(win)
  const entry = entries.get(win.id)
  if (entry) entry.protected = shouldProtect
}

/** 重新应用保护；返回 true 表示「已处理/无需处理」 */
export function reapply(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return true
  const entry = entries.get(win.id)
  // 没登记过、且当前不需要保护 → 不用管
  if (!entry && !protectionWanted()) return true
  if (entry && !entry.protected && !protectionWanted()) return true
  return protect(win)
}

function protect(win: BrowserWindow): boolean {
  try {
    win.setContentProtection(true)
    const entry = entries.get(win.id)
    if (entry) entry.protected = true
    return true
  } catch (error) {
    console.warn('[protection] setContentProtection 失败：', error)
    return false
  }
}

/** 对所有窗口重新应用（安全模式开关切换时调用） */
export function reapplyAll(): void {
  for (const win of windowsProvider()) {
    if (win && !win.isDestroyed()) reapply(win)
  }
}

/**
 * 关闭所有窗口的内容保护。
 * 安全模式关闭后必须能恢复正常显示，否则用户会以为软件坏了。
 */
export function releaseAll(): void {
  for (const win of windowsProvider()) {
    if (!win || win.isDestroyed()) continue
    try {
      win.setContentProtection(false)
      const entry = entries.get(win.id)
      if (entry) entry.protected = false
    } catch {
      /* 忽略 */
    }
  }
}

/** 仅测试用：清空登记 */
export function __resetForTest(): void {
  entries.clear()
}

/* ------------------------------------------------------------------ *
 * 窗口标题伪装（原版：安全模式下把「随思」换成中性的「笔记」）
 * ------------------------------------------------------------------ */

/** 正常显示名 / 安全模式下的伪装名 */
export const TITLE_NORMAL = 'AI 面试助手'
export const TITLE_DISGUISED = '笔记'

/**
 * 应用标题伪装。
 *
 * 原版（dist-electron/main.js）：
 *   var Xs="笔记", Zs="随思"
 *   function he(win, secure) { win.setTitle(secure ? Xs : Zs) }
 * 只是标题层面改名，用来避免被「按窗口标题扫描」的工具一眼认出。
 * 注意它**不改进程名、不隐藏 Dock**——原版没做那两件事。
 */
export function applyDisguise(win: BrowserWindow, disguised: boolean): void {
  if (!win || win.isDestroyed()) return
  try {
    win.setTitle(disguised ? TITLE_DISGUISED : TITLE_NORMAL)
  } catch {
    /* 某些窗口不允许改标题 */
  }
}

/** 对所有窗口应用/取消伪装 */
export function applyDisguiseAll(disguised: boolean): void {
  for (const win of windowsProvider()) applyDisguise(win, disguised)
}
