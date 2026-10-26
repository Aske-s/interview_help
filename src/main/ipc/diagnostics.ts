import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import {
  appName,
  currentRecorders,
  getCheckState,
  scanEnvironment,
  setDeviceCheck,
  setSecurityCheck
} from '../diagnostics/security'
import { currentPermissions, probeScreenCapture, requestPermission } from '../diagnostics/devices'
import { broadcast } from '../windows'
import type { DeviceCheckResult } from '@shared/types'

/** 设备检查 / 环境检查 / 权限 */

export function registerDiagnosticsIpc(): void {
  /* ---- 权限 ---- */
  ipcMain.handle(IPC.GetPermissions, () => currentPermissions())
  ipcMain.handle(IPC.RequestPermission, async (_e, kind: 'microphone' | 'camera' | 'screen' | 'accessibility') =>
    requestPermission(kind)
  )

  /* ---- 屏幕录制可用性实测（能拿到画面才算通过） ---- */
  ipcMain.handle(IPC.ProbeScreenCapture, () => probeScreenCapture())

  /* ---- 设备检查结果：渲染进程负责真实采集，实测后回传由主进程保存并广播 ---- */
  ipcMain.handle(IPC.DeviceCheckSave, (_e, result: DeviceCheckResult) => {
    const state = setDeviceCheck(result)
    broadcast(IPC.CheckStateChanged, state)
    return state
  })

  /* ---- 环境检查：scanEnvironment 内部已写缓存 ---- */
  ipcMain.handle(IPC.SecurityScan, async () => {
    await scanEnvironment()
    const state = getCheckState()
    broadcast(IPC.CheckStateChanged, state)
    return state
  })

  ipcMain.handle(IPC.CheckStateGet, () => getCheckState())

  /* 供设置页展示「当前检测到的风险软件」，也便于安全模式文案复用 */
  ipcMain.handle(IPC.CheckRecorders, () => currentRecorders())
  ipcMain.handle(IPC.AppDisplayName, () => appName())
}
