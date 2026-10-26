import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { QaRecord, SessionKind } from '@shared/types'
import { getWindow, openQuizbarWindow } from '../windows'
import { activeClickThroughHotkey, releaseClickThrough } from '../clickthrough'
import { appendQa, createSession } from './data'

/**
 * 悬浮工具条的窗口自身控制。
 *
 * 与悬浮窗共用同一套语义：
 *  - 鼠标穿透：窗口不响应鼠标（用快捷键解除）
 *  - 不透明度、让出焦点、收起
 */
export function registerQuizbarIpc(): void {
  const target = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? getWindow('quizbar')

  ipcMain.handle(IPC.QuizbarOpen, () => {
    openQuizbarWindow()
    return true
  })
  ipcMain.handle(IPC.QuizbarClickThrough, (e, on: boolean) => {
    target(e)?.setIgnoreMouseEvents(Boolean(on), { forward: true })
  })
  ipcMain.handle(IPC.QuizbarOpacity, (e, value: number) => {
    const v = Number.isFinite(value) ? value : 0.7
    target(e)?.setOpacity(Math.min(1, Math.max(0.15, v)))
  })
  ipcMain.handle(IPC.QuizbarCollapsed, (e, collapsed: boolean) => {
    const win = target(e)
    if (!win) return
    // 收起时只保留一条窄把手；展开恢复完整工具条
    const [w] = win.getSize()
    win.setSize(w, collapsed ? 14 : 56, false)
  })
  ipcMain.handle(IPC.QuizbarFocusable, (e, focusable: boolean) => {
    target(e)?.setFocusable(Boolean(focusable))
  })
  ipcMain.handle(IPC.QuizbarExpanded, (e, expanded: boolean) => {
    const win = target(e)
    if (!win) return
    const [w] = win.getSize()
    // 展开时把窗口长高，让答案区有空间显示
    win.setSize(w, expanded ? 380 : 56, false)
  })
  ipcMain.handle(IPC.ClickThroughHotkey, () => activeClickThroughHotkey())
  ipcMain.handle(IPC.ClickThroughRelease, () => releaseClickThrough())

  ipcMain.handle(IPC.QuizbarSetSize, (e, width: number, height: number) => {
    const win = target(e)
    if (!win) return
    // 无边框窗口没有原生缩放边，靠渲染层的手柄调这里
    const w = Math.max(360, Math.min(1200, Math.round(width)))
    const h = Math.max(48, Math.min(900, Math.round(height)))
    win.setSize(w, h, false)
  })
  /*
   * 退出悬浮窗。
   * 原版语义：退出前问「保存本次记录？」，用户选保存才落库；
   * 「不保存，直接关闭」就是丢弃。保存时用首个问题当标题，方便历史列表辨认。
   */
  ipcMain.handle(
    IPC.QuizbarExit,
    (
      e,
      payload: { kind: SessionKind; title: string; items: QaRecord[]; save: boolean }
    ): { savedId: string | null } => {
      const win = target(e)
      const items = Array.isArray(payload?.items) ? payload.items : []
      let savedId: string | null = null
      if (payload?.save && items.length > 0) {
        const first = items.find((it) => it.question?.trim())
        const title = (payload.title || '').trim() || first?.question?.slice(0, 30) || '未命名会话'
        const session = createSession(payload.kind ?? 'quiz', title)
        for (const item of items) appendQa(session.id, item)
        savedId = session.id
      }
      win?.close()
      return { savedId }
    }
  )

  ipcMain.handle(IPC.QuizbarClose, (e) => {
    target(e)?.close()
  })
}
