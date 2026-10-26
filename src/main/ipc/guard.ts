import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { disable, enable, getStatus, getSupport, setSecureInput, type GuardSide } from '../keyboard-guard'

/**
 * 键盘防护 / 安全输入 IPC。
 *
 * 注意：底层 getSupport() 是同步的（内部 spawnSync 跑 --probe），
 * 最坏会阻塞主进程约 1.5 秒，所以这里只在设置页主动请求时才调用，
 * 不在启动流程里调用。
 */
export function registerGuardIpc(): void {
  ipcMain.handle(IPC.GuardSupport, () => getSupport())
  ipcMain.handle(IPC.GuardStatus, () => getStatus())
  ipcMain.handle(IPC.GuardEnable, (_e, side: GuardSide) => enable(side))
  ipcMain.handle(IPC.GuardDisable, () => disable())
  ipcMain.handle(IPC.SecureInputSet, (_e, on: boolean) => setSecureInput(on))
}
