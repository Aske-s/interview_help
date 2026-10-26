/**
 * 系统音频采集 IPC + 屏幕录制权限提示。
 *
 * 对应原版 `mac-system-audio:start/stop` 与 `media-permission:ensure`。
 * 权限提示之所以要有：macOS 的「屏幕录制」授权改动后**必须完全退出应用**才生效，
 * 只在弹窗里说「请去开启」用户会以为没生效。所以这里给一个明确的引导对话框。
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import {
  SCREEN_PERMISSION_DENIED,
  getMacSystemAudioService,
  mediaAccessStatus,
  supportsSystemAudioLoopback
} from '../system-audio'

/** 同一类权限同一时刻只弹一个框 */
const pendingPrompts = new Map<string, Promise<void>>()

type PermissionKind = 'microphone' | 'camera' | 'screen'

function privacyUrl(kind: PermissionKind): string {
  const pane = kind === 'microphone' ? 'Microphone' : kind === 'camera' ? 'Camera' : 'ScreenCapture'
  return `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`
}

function promptLabels(kind: PermissionKind): { title: string; detail: string } {
  if (kind === 'microphone') {
    return {
      title: '麦克风暂不可用',
      detail: '请在系统设置 → 隐私与安全性 → 麦克风中允许本应用。'
    }
  }
  if (kind === 'camera') {
    return {
      title: '摄像头暂不可用',
      detail: '请在系统设置 → 隐私与安全性 → 摄像头中允许本应用。'
    }
  }
  return {
    title: '屏幕与系统音频采集暂不可用',
    detail:
      '请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许本应用。\n' +
      '如果已经开启，请完全退出本应用后重新打开，使 macOS 的权限变更生效。\n' +
      '关闭窗口不等于退出应用。'
  }
}

/**
 * 引导用户去开权限。返回后不重试采集 —— 权限变更通常需要重启应用。
 * 原版也是这样：只负责引导，不假装能修好。
 */
export function ensureMediaPermission(kind: PermissionKind): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  // 麦克风/摄像头未授权才有必要引导；屏幕录制即使 granted 也可能「授权过但没重启」
  if (kind !== 'screen' && mediaAccessStatus(kind) === 'granted') return Promise.resolve()

  const existing = pendingPrompts.get(kind)
  if (existing) return existing

  const task = (async () => {
    const { title, detail } = promptLabels(kind)
    const result = await dialog.showMessageBox({
      type: 'info',
      message: title,
      detail,
      buttons: ['打开系统设置', '稍后'],
      defaultId: 0,
      cancelId: 1
    })
    if (result.response === 0) await shell.openExternal(privacyUrl(kind))
  })().finally(() => pendingPrompts.delete(kind))

  pendingPrompts.set(kind, task)
  return task
}

export function registerSystemAudioIpc(): void {
  ipcMain.handle(IPC.SystemAudioStart, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, error: '未找到发起采集的窗口。' }
    if (!supportsSystemAudioLoopback()) {
      return { ok: false, error: '当前系统不支持直接采集电脑音频（需要 macOS 13 及以上）。' }
    }
    const service = getMacSystemAudioService()
    if (!service) return { ok: false, error: 'macOS 系统音频采集仅在 macOS 上可用。' }

    const result = service.start(win)
    if (!result.ok) return result

    /*
     * 拉起后立刻探一次权限：若 helper 因为没授权而起不来，
     * 用户需要的是「去开权限」而不是干等 60 秒超时。
     * 探活复用同一个 helper 会冲突，所以这里只看系统侧的权限状态。
     */
    if (mediaAccessStatus('screen') === 'denied') {
      service.stop(false)
      void ensureMediaPermission('screen')
      return { ok: false, error: SCREEN_PERMISSION_DENIED }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.SystemAudioStop, () => {
    getMacSystemAudioService()?.stop()
  })

  ipcMain.handle(IPC.SystemAudioCheckAccess, async () => {
    const service = getMacSystemAudioService()
    if (!service) return { ok: false, error: 'SCREEN_CAPTURE_UNAVAILABLE' }
    const result = await service.checkAccess()
    if (!result.ok && result.error === SCREEN_PERMISSION_DENIED) {
      void ensureMediaPermission('screen')
    }
    return result
  })

  ipcMain.handle(IPC.OpenSystemSettings, async (_event, kind: PermissionKind) => {
    await ensureMediaPermission(kind ?? 'screen')
  })
}
