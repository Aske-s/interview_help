import { desktopCapturer, systemPreferences } from 'electron'
import type { AppPermissions, PermissionState } from '@shared/types'

/**
 * 设备与权限（主进程侧）。
 *
 * 分工说明：
 *  - 主进程能可靠拿到的是「系统权限状态」；
 *  - 「设备到底能不能用」（能否打开、有没有声音、画面是不是黑的）
 *    必须在渲染进程用 navigator.mediaDevices 真实采集一次才能确认，
 *    见 src/renderer/src/diagnostics/deviceCheck.ts。
 */

function mediaStatus(kind: 'microphone' | 'camera' | 'screen'): PermissionState {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted'
  try {
    const status = systemPreferences.getMediaAccessStatus(kind)
    if (status === 'granted' || status === 'denied' || status === 'not-determined' || status === 'restricted') {
      return status
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function accessibilityState(): PermissionState {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

export function currentPermissions(): AppPermissions {
  return {
    microphone: mediaStatus('microphone'),
    camera: mediaStatus('camera'),
    screen: mediaStatus('screen'),
    accessibility: accessibilityState()
  }
}

/** 主动申请权限（屏幕录制没有编程式弹窗，只能触发系统登记后引导用户去设置） */
export async function requestPermission(kind: 'microphone' | 'camera' | 'screen' | 'accessibility'): Promise<AppPermissions> {
  if (process.platform === 'darwin') {
    if (kind === 'microphone' || kind === 'camera') {
      await systemPreferences.askForMediaAccess(kind).catch(() => undefined)
    }
    if (kind === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true)
    }
  }
  if (kind === 'screen') {
    // 调一次采集接口，让系统把本应用登记进「屏幕录制」列表
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined)
  }
  return currentPermissions()
}

/** 屏幕录制是否真的可用：能拿到画面才算通过 */
export async function probeScreenCapture(): Promise<{ ok: boolean; message: string }> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 64, height: 64 }
    })
    if (!sources.length) {
      return { ok: false, message: '未能获取屏幕画面，请在系统设置中授予「屏幕录制」权限' }
    }
    const empty = sources.every((s) => s.thumbnail.isEmpty())
    if (empty) {
      return { ok: false, message: '截图内容为空，通常是「屏幕录制」权限未生效（授权后需重启应用）' }
    }
    return { ok: true, message: `可正常截取屏幕（检测到 ${sources.length} 个屏幕）` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 打开 macOS 系统设置里对应的隐私面板。
 *
 * 原版在权限缺失时会引导用户去系统设置；直接跳过去比让用户自己找体验好得多。
 */
export async function openPrivacySettings(kind: 'microphone' | 'camera' | 'screen' | 'accessibility'): Promise<void> {
  if (process.platform !== 'darwin') return
  const pane: Record<typeof kind, string> = {
    microphone: 'Privacy_Microphone',
    camera: 'Privacy_Camera',
    screen: 'Privacy_ScreenCapture',
    accessibility: 'Privacy_Accessibility'
  }
  const { shell } = await import('electron')
  await shell
    .openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane[kind]}`)
    .catch(() => undefined)
}
