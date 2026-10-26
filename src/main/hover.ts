import { screen, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { settingsStore } from './store/settings'

/**
 * 悬停显隐（对齐原版 hoverReveal）。
 *
 * 原版的做法：主进程用一个 tracker 跟踪鼠标是否在窗口内，变化时给渲染层发
 * `{hoverHidden}`，由渲染层把它变成「消失」——配合「悬停显影透明度」这个设置项。
 * 这里照做：主进程轮询屏幕光标位置与窗口矩形做比较（穿透窗口自己收不到 mousemove），
 * 状态变化时通知渲染层。
 *
 * 为什么不直接 hide() 窗口：hide 之后鼠标再移进来就没有任何事件了，窗口永远回不来。
 * 所以是「降到极低不透明度」，视觉上等同消失，但鼠标一进入就能恢复。
 */

const trackers = new Map<number, NodeJS.Timeout>()
/** 每个窗口当前是否处于「已隐藏」状态，避免重复发送 */
const hiddenState = new Map<number, boolean>()

export function startHoverTracking(win: BrowserWindow, kind: string): void {
  stopHoverTracking(win)

  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      stopHoverTracking(win)
      return
    }
    const stealth = settingsStore.get().stealth
    if (!stealth.hoverReveal) {
      // 关掉时要保证恢复显示，否则窗口会「消失」且无法恢复
      if (hiddenState.get(win.id)) {
        hiddenState.set(win.id, false)
        send(win, false)
      }
      return
    }
    if (!win.isVisible()) return

    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()
    // 留一点外扩，避免贴边时来回抖动
    const pad = 4
    const inside =
      cursor.x >= b.x - pad && cursor.x <= b.x + b.width + pad && cursor.y >= b.y - pad && cursor.y <= b.y + b.height + pad

    const shouldHide = !inside
    if (hiddenState.get(win.id) !== shouldHide) {
      hiddenState.set(win.id, shouldHide)
      send(win, shouldHide)
    }
  }, 120)

  trackers.set(win.id, timer)
  win.once('closed', () => stopHoverTracking(win))
  void kind
}

function send(win: BrowserWindow, hidden: boolean): void {
  try {
    win.webContents.send(IPC.HoverRevealChanged, hidden)
  } catch {
    /* 窗口可能正在销毁 */
  }
}

export function stopHoverTracking(win: BrowserWindow): void {
  const timer = trackers.get(win.id)
  if (timer) clearInterval(timer)
  trackers.delete(win.id)
  hiddenState.delete(win.id)
}
