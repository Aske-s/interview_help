import { clipboard, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'

/**
 * 系统剪贴板。
 *
 * 为什么必须有这条主进程通道：
 * 悬浮窗是 `focusable: false` 的（为了不抢焦点、避免打断会议/考试），
 * 而 `navigator.clipboard.writeText()` 要求文档已经聚焦，否则抛
 * `NotAllowedError: Document is not focused`。
 * 于是「复制代码」按钮点了没反应，剪贴板里什么都没有。
 * 主进程的 clipboard 模块不受渲染层焦点状态影响。
 */
export function registerClipboardIpc(): void {
  ipcMain.handle(IPC.ClipboardWriteText, (_e, text: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch (error) {
      console.warn('[clipboard] 写入失败：', error)
      return false
    }
  })
}
