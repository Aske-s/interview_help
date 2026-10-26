import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { supportsSystemAudioLoopback } from '../system-audio'
import { settingsStore } from '../store/settings'
import { testProvider, listModels } from '../gateway/llm'
import { applyFloatingOpacity, broadcast, getWindow, openQuizbarWindow, openWindowByKind } from '../windows'
import type { SessionKind, Settings } from '@shared/types'
import type { WindowKind } from '@shared/window-kind'

/** 设置 / 网关 / 设备 / 应用信息 / 悬浮窗控制 */

const SETTINGS_PANES: Record<string, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
}

function windowFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerSystemIpc(): void {
  /* ---- 设置 ---- */
  ipcMain.handle(IPC.SettingsGet, () => settingsStore.get())
  ipcMain.handle(IPC.SettingsPatch, (_e, patch: unknown) => settingsStore.patch(patch))
  ipcMain.handle(IPC.SettingsPatchProvider, (_e, id: string, patch: Record<string, unknown>) =>
    settingsStore.patchProvider(id, patch)
  )
  ipcMain.handle(IPC.SettingsReset, () => settingsStore.reset())

  /* ---- 网关 ---- */
  ipcMain.handle(IPC.GatewayTest, async (_e, provider) => testProvider(provider))
  ipcMain.handle(IPC.GatewayTestAsr, async (_e, asr) => {
    const { createAsrProvider } = await import('../asr')
    /*
     * whisper-server 通道：测试前先把服务准备好。
     * 否则用户点「测试」只会看到「连不上」，还得自己去命令行启动服务。
     */
    if (asr.kind === 'whisper-server') {
      const { ensureServer } = await import('../asr/server')
      const ready = await ensureServer(asr)
      if (!ready.ok) return { ok: false, latencyMs: 0, message: ready.message }
    }
    return createAsrProvider(asr).test()
  })
  ipcMain.handle(IPC.GatewayListModels, async (_e, provider) => {
    const res = await listModels(provider)
    return res.ok ? { ok: true, data: res.models } : { ok: false, error: res.message }
  })

  /* ---- 应用信息 ---- */
  ipcMain.handle(IPC.AppInfo, () => ({
    name: 'AI 面试助手',
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    /*
     * 渲染层要靠这几项决定「电脑音频」怎么采：
     * macOS 走原生 ScreenCaptureKit，其它平台才回退到 getDisplayMedia。
     * （原版同样是主进程下发 appPlatform，渲染层不自己判断。）
     */
    isMacOS: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
    supportsSystemAudioLoopback: supportsSystemAudioLoopback(),
    dataDir: app.getPath('userData')
  }))
  ipcMain.handle(IPC.OpenExternal, async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.OpenDataDir, async () => {
    await shell.openPath(app.getPath('userData'))
  })
  ipcMain.handle(IPC.PickFile, async (_e, opts?: { title?: string; extensions?: string[] }) => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      title: opts?.title ?? '选择文件',
      properties: ['openFile'],
      filters: opts?.extensions?.length
        ? [{ name: '支持的文件', extensions: opts.extensions }, { name: '全部文件', extensions: ['*'] }]
        : undefined
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.SaveFile, async (_e, opts: { title?: string; defaultName: string; content: string; extensions?: string[] }) => {
    const { dialog } = await import('electron')
    const { writeFileSync } = await import('node:fs')
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? '保存文件',
      defaultPath: opts?.defaultName,
      filters: opts?.extensions?.length ? [{ name: '文件', extensions: opts.extensions }] : undefined
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, opts.content, 'utf8')
    return result.filePath
  })

  /* ---- 等比缩放：作用于发起请求的那个窗口 ---- */
  ipcMain.handle(IPC.ZoomSet, (event, factor: number) => {
    const win = windowFromEvent(event)
    if (!win) return 1
    const clamped = Math.min(2.5, Math.max(0.5, Number(factor) || 1))
    win.webContents.setZoomFactor(clamped)
    return clamped
  })
  ipcMain.handle(IPC.ZoomGet, (event) => {
    const win = windowFromEvent(event)
    return win ? win.webContents.getZoomFactor() : 1
  })
  ipcMain.handle(IPC.WindowOpen, (_e, kind: WindowKind) => {
    openWindowByKind(kind)
    /*
     * 原版语义：点「笔试」或「面试」会同时弹出一个半透明悬浮工具条（快捷操作），
     * 因为那两个场景下用户需要在别处操作（做题页面 / 面试界面），
     * 全屏大窗口反而挡事。
     */
    if (kind === 'quiz' || kind === 'interview') openQuizbarWindow()
  })
  ipcMain.handle(IPC.WindowClose, (event) => windowFromEvent(event)?.close())
  ipcMain.handle(IPC.WindowMinimize, (event) => windowFromEvent(event)?.minimize())

  /* ---- 悬浮窗控制 ---- */
  ipcMain.handle(IPC.FloatingToggle, () => {
    const win = getWindow('floating')
    if (!win) {
      openWindowByKind('floating')
      return
    }
    if (win.isVisible()) win.hide()
    else win.showInactive()
  })
  /*
   * 「开始会话」的唯一入口：由主窗口发起，但真正开跑的是悬浮窗。
   * 这里只负责把窗打开、显示出来，并把意图转达给悬浮窗渲染层。
   */
  ipcMain.handle(IPC.FloatingStart, (_e, opts?: { kind?: SessionKind; title?: string }) => {
    const win = getWindow('floating') ?? openWindowByKind('floating')
    if (!win) return
    win.showInactive()
    const payload = { kind: opts?.kind ?? 'meeting', title: opts?.title }
    const deliver = (): void => {
      if (!win.isDestroyed()) win.webContents.send(IPC.FloatingStartRequested, payload)
    }
    // 冷启动时渲染层还没挂好监听，等页面加载完再发，否则事件会丢
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver)
    else deliver()
  })
  ipcMain.handle(IPC.FloatingShow, () => {
    const win = getWindow('floating') ?? openWindowByKind('floating')
    win?.showInactive()
  })
  ipcMain.handle(IPC.FloatingHide, () => getWindow('floating')?.hide())
  ipcMain.handle(IPC.FloatingSetOpacity, (_e, value: number) => {
    const win = getWindow('floating')
    if (win) applyFloatingOpacity(win, value)
  })
  ipcMain.handle(IPC.FloatingSetClickThrough, (_e, enabled: boolean) => {
    getWindow('floating')?.setIgnoreMouseEvents(Boolean(enabled), { forward: true })
  })
  ipcMain.handle(IPC.FloatingSetIgnoreFocus, (_e, enabled: boolean) => {
    getWindow('floating')?.setFocusable(!enabled)
  })
  ipcMain.handle(IPC.FloatingResize, (_e, width: number, height: number) => {
    const win = getWindow('floating')
    if (!win) return
    const bounds = win.getBounds()
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(240, Math.round(width)),
      height: Math.max(140, Math.round(height))
    })
  })
  ipcMain.handle(IPC.FloatingMoveBy, (_e, dx: number, dy: number) => {
    const win = getWindow('floating')
    if (!win) return
    const b = win.getBounds()
    win.setBounds({ ...b, x: b.x + Math.round(dx), y: b.y + Math.round(dy) })
  })

  /* ---- 设置变更广播给所有窗口 ---- */
  settingsStore.on('changed', (next: Settings) => {
    broadcast(IPC.SettingsChanged, next)
  })
}
