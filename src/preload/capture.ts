import { contextBridge } from 'electron'
import { IPC } from '@shared/ipc'
import { invoke, send } from './_common'
import type { CaptureWindowApi } from '@shared/ipc'

/** 选区截图覆盖层 API（刻意最小化：只负责取底图和回传选区） */

const api: CaptureWindowApi = {
  kind: 'capture',
  getSource: () => invoke(IPC.CaptureGetSource),
  done: (dataUrl) => send(IPC.CaptureDone, dataUrl),
  cancel: () => send(IPC.CaptureCancel)
}

contextBridge.exposeInMainWorld('api', api)
