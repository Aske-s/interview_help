import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { on } from './_common'

/**
 * 替代光标窗口的预加载。
 *
 * 只需要接收主进程推送的光标位置——它不读写设置、不访问文件。
 * 用主进程轮询 `screen.getCursorScreenPoint()` 推位置，比在窗口内监听 mousemove 可靠：
 * 这个窗口是鼠标穿透的，forward:true 下事件并不总是到达。
 */
contextBridge.exposeInMainWorld('api', {
  kind: 'cursor',
  onCursorPosition: (cb: (pos: { x: number; y: number; visible: boolean }) => void) =>
    on(IPC.CursorPosition, (payload) => cb(payload as { x: number; y: number; visible: boolean }))
})
