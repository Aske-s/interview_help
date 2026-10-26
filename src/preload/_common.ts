import { ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { SystemAudioApi } from '@shared/ipc'

/**
 * 预加载公共工具。
 * 渲染进程一律通过 contextBridge 暴露的 api 访问主进程，不直接接触 ipcRenderer。
 */

export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

export function send(channel: string, ...args: unknown[]): void {
  ipcRenderer.send(channel, ...args)
}

/** 订阅事件，返回取消订阅函数 */
export function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_event: unknown, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

/**
 * 电脑音频（macOS 原生 ScreenCaptureKit 采集）。
 *
 * 事件名与主进程侧同名，便于和原版逐条对照。
 * 注意：`start()` 成功不代表能收到音频，必须等 `onReady`；
 * 而且必须消费 `onData`，否则管道写满会把采集组件卡住。
 */
export function createSystemAudioApi(): SystemAudioApi {
  return {
    supported: () =>
      invoke<{ supportsSystemAudioLoopback?: boolean }>(IPC.AppInfo)
        .then((info) => Boolean(info?.supportsSystemAudioLoopback))
        .catch(() => false),
    checkAccess: () => invoke(IPC.SystemAudioCheckAccess),
    start: () => invoke(IPC.SystemAudioStart),
    stop: () => invoke(IPC.SystemAudioStop),
    onData: (cb) => on(IPC.SystemAudioData, (pcm: ArrayBuffer) => cb(pcm)),
    onReady: (cb) => on(IPC.SystemAudioReady, () => cb()),
    onError: (cb) => on(IPC.SystemAudioError, (message: string) => cb(String(message ?? '')))
  }
}
