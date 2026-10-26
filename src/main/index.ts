import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  Tray,
  nativeImage,
  screen,
  session,
  systemPreferences,
  shell
} from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpc } from './ipc'
import { captureAndAnswer } from './ipc/capture'
import { settingsStore } from './store/settings'
import {
  allWindows,
  applyFloatingOpacity,
  broadcast,
  getWindow,
  openCaptureWindow,
  openFloatingWindow,
  openMainWindow,
  setCursorOverlayVisible
} from './windows'
import { IPC } from '@shared/ipc'
import { live } from './live/orchestrator'
import { setupDevHarness } from './devtools/dev'
import { shutdown as shutdownGuard } from './keyboard-guard'
import { registerClickThroughHotkey, toggleHoverReveal } from './clickthrough'
import { applyDisguiseAll, reapplyAll, releaseAll, setWindowsProvider } from './security/protection'
import { ensureServer, stopServer } from './asr/server'
import { disposeMacSystemAudio } from './system-audio'

/**
 * 隐藏/恢复真实鼠标。
 *
 * cursor 模块是可选的：未构建 native helper、或平台不支持时都不应影响启动，
 * 因此这里用运行期解析 + 兜底，而不是静态 import（静态 import 在模块缺失时会直接崩）。
 */
function applyCursorHiding(hide: boolean): void {
  try {
    // 计算路径：cursor 模块属于可选项（未构建 helper 时也不该崩）
    const modulePath = './cursor'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath) as { hide?: () => Promise<unknown>; show?: () => Promise<unknown> }
    void (hide ? mod.hide?.() : mod.show?.())?.catch(() => undefined)
    // 真实光标藏起来后必须显示替代光标，否则用户会「失去鼠标」
    setCursorOverlayVisible(hide)
    if (hide) startCursorTracking()
    else stopCursorTracking()
  } catch {
    // 模块不存在：静默跳过
  }
}

/** 以约 60fps 把系统光标位置推给替代光标窗口（穿透窗口自己收不到 mousemove） */
let cursorTimer: NodeJS.Timeout | null = null
function startCursorTracking(): void {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    const win = getWindow('cursor')
    if (!win || win.isDestroyed()) {
      stopCursorTracking()
      return
    }
    const p = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    // 转成窗口本地坐标，多显示器下也不会偏
    win.webContents.send(IPC.CursorPosition, { x: p.x - bounds.x, y: p.y - bounds.y, visible: true })
  }, 16)
}
function stopCursorTracking(): void {
  if (!cursorTimer) return
  clearInterval(cursorTimer)
  cursorTimer = null
}

let tray: Tray | null = null
let quitting = false

/**
 * 受限环境下 Chromium 无法初始化自己的沙箱（典型报错：
 * "sandbox initialization failed: Operation not permitted"），
 * 例如在容器、CI 或被外层 sandbox 包裹的 shell 里启动。
 * 这种情况下可用 SUISI_NO_SANDBOX=1 或 --no-sandbox 降级启动。
 * 正常从 Finder / 终端启动不需要这个开关。
 */
const noSandbox = process.env['SUISI_NO_SANDBOX'] === '1' || process.argv.includes('--no-sandbox')
if (noSandbox) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  console.warn('[startup] 已禁用沙箱与 GPU（受限环境降级模式）')
}

/** 只允许单实例：多开会互相抢全局快捷键与悬浮窗 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    openMainWindow()
  })
}

function trayIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../../resources/trayTemplate.png'),
    join(process.cwd(), 'resources/trayTemplate.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function setupTray(): void {
  const iconPath = trayIconPath()
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (!iconPath) image.isEmpty()
  tray = new Tray(image)
  tray.setToolTip('AI 面试助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => openMainWindow() },
      { label: '显示悬浮窗', click: () => openFloatingWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => openMainWindow())
}

/** 注册全局快捷键；返回失败项，供 UI 提示 */
export function registerHotkeys(): string[] {
  globalShortcut.unregisterAll()
  const hk = settingsStore.get().hotkeys
  const failed: string[] = []

  const bind = (accelerator: string, handler: () => void) => {
    if (!accelerator) return
    try {
      if (!globalShortcut.register(accelerator, handler)) failed.push(accelerator)
    } catch {
      failed.push(accelerator)
    }
  }

  bind(hk.toggleFloating, () => {
    const win = getWindow('floating')
    if (win) {
      if (win.isVisible()) win.hide()
      else win.showInactive()
    } else {
      openFloatingWindow()
    }
  })

  bind(hk.answerNow, () => void live.ask())
  // 快捷键必须和界面按钮走同一条链路：先抓屏，成功才开遮罩
  bind(hk.screenshot, () => {
    void captureAndAnswer()
  })
  /*
   * 穿透的逃逸通道：用户没配时自动用内置兜底键（原版 CommandOrControl+Shift+9）。
   * 这条必须在最后注册，避免上面 bind 里的 unregisterAll 把它清掉。
   */
  const ct = registerClickThroughHotkey()
  if (!ct.ok) failed.push(ct.accelerator)
  if (hk.toggleHoverReveal) bind(hk.toggleHoverReveal, () => void toggleHoverReveal())
  bind(hk.clearSession, () => live.clear())

  return failed
}

/**
 * 应用防录屏与安全模式外观。
 *
 * 安全模式 = 强制开启防录屏（原版语义）+ 窗口标题伪装成「笔记」。
 */
function applyContentProtectionToAll(): void {
  const stealth = settingsStore.get().stealth
  const enabled = stealth.contentProtection || stealth.safeMode
  setWindowsProvider(() => allWindows())
  if (enabled) reapplyAll()
  else releaseAll()
  // 标题伪装：安全模式下叫「笔记」，否则恢复「随思」
  applyDisguiseAll(Boolean(stealth.safeMode))
}

app.whenReady().then(() => {
  // 麦克风权限：提前询问，避免用户点“开始”时才弹窗
  if (process.platform === 'darwin') {
    void systemPreferences.askForMediaAccess('microphone').catch(() => undefined)
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // audioCapture 不在类型联合里，但运行时会传入
    const name = permission as string
    callback(name === 'media' || name === 'display-capture' || name === 'audioCapture')
  })
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    /*
     * 系统音频采集走 loopback。
     *
     * 曾经这里直接 `callback({ video: sources[0], audio: 'loopback' })`，
     * 而 getSources 需要「屏幕录制」权限——权限缺失时它返回**空数组**，
     * 于是 sources[0] 是 undefined：getDisplayMedia 既不成功也不报错，
     * 就那么挂着，一个音频帧都收不到，界面上也没有任何提示。
     * 现在显式判空，并把原因广播给界面。
     */
    try {
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      })
      if (!sources.length) {
        broadcast(IPC.LiveError, {
          scope: 'audio',
          message:
            '未能获取系统音频：未获得「屏幕录制」权限。请在系统设置 → 隐私与安全性 → 屏幕录制中允许本应用，然后完全退出应用重新打开。'
        })
        callback({} as never)
        return
      }
      callback({ video: sources[0], audio: 'loopback' } as never)
    } catch (error) {
      broadcast(IPC.LiveError, {
        scope: 'audio',
        message: `系统音频采集失败：${error instanceof Error ? error.message : String(error)}`
      })
      callback({} as never)
    }
  })

  registerIpc()
  openMainWindow()
  setupTray()
  setupDevHarness()
  const failed = registerHotkeys()
  if (failed.length) {
    console.warn('[hotkeys] 注册失败（可能被占用）：', failed.join(', '))
    broadcast(IPC.LiveError, { scope: 'hotkeys', message: `快捷键被占用：${failed.join(', ')}` })
  }
  applyContentProtectionToAll()

  /*
   * 语音识别用 whisper-server 时，启动就把常驻服务准备好。
   * 模型加载要几秒，放在启动期做，第一次说话时就不用等。
   * 失败只提示、不阻塞启动。
   */
  if (settingsStore.get().asr.kind === 'whisper-server') {
    void ensureServer(settingsStore.get().asr).then((r) => {
      if (!r.ok) console.warn('[asr] whisper-server 未就绪：', r.message)
      else console.log('[asr]', r.message)
    })
  }

  settingsStore.on('changed', () => {
    const next = settingsStore.get()
    // 安全模式会强制开启「不抢焦点」与防录屏（原版语义），并强制隐藏悬浮窗
    const safe = next.stealth.safeMode
    const contentProtection = next.stealth.contentProtection || safe
    const releaseFocus = next.stealth.releaseFocus || safe

    /*
     * 穿透/不透明度/防录屏必须应用到**所有悬浮类窗口**。
     * 曾经这里只处理 floating，而工具条的「穿透」按钮是改设置（不是直接调窗口），
     * 于是按钮看着开了、设置也存了，但工具条窗口从未真的进入穿透 —— 用户点了没反应。
     */
    for (const kind of ['floating', 'quizbar'] as const) {
      const win = getWindow(kind)
      if (!win || win.isDestroyed()) continue
      applyFloatingOpacity(win, next.ui.opacity)
      win.setContentProtection(contentProtection)
      win.setIgnoreMouseEvents(next.stealth.clickThrough, { forward: true })
      // 工具条要能接收「鼠标移入」以恢复悬停显隐，所以不抢焦点但保持可聚焦语义
      if (kind === 'floating') win.setFocusable(!releaseFocus)
    }
    // 安全模式：隐藏真实鼠标（本机仍显示替代光标）——由 cursor 模块负责
    applyCursorHiding(next.stealth.hideCursor || safe)
    applyContentProtectionToAll()

  /*
   * 语音识别用 whisper-server 时，启动就把常驻服务准备好。
   * 模型加载要几秒，放在启动期做，第一次说话时就不用等。
   * 失败只提示、不阻塞启动。
   */
  if (settingsStore.get().asr.kind === 'whisper-server') {
    void ensureServer(settingsStore.get().asr).then((r) => {
      if (!r.ok) console.warn('[asr] whisper-server 未就绪：', r.message)
      else console.log('[asr]', r.message)
    })
  }
    registerHotkeys()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻：关掉窗口不退出（除非显式退出）
  if (process.platform !== 'darwin' && quitting) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  // 必须清理键盘防护的常驻进程：留着它会继续吞掉用户按键
  void shutdownGuard().catch(() => undefined)
  // 关掉由我们拉起的 whisper-server，避免退出后留下占端口的孤儿进程
  stopServer()
  // 必须杀掉系统音频采集组件：残留进程会占住 ScreenCaptureKit 会话，
  // 下次启动时它会一直卡在枚举可采集内容上（实测过，表现为「无帧、无报错」）
  disposeMacSystemAudio()
  // 必须恢复真实光标：留着它用户会「没有鼠标」
  stopCursorTracking()
  try {
    const modulePath = './cursor'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath) as { shutdown?: () => Promise<unknown> }
    void mod.shutdown?.()?.catch(() => undefined)
  } catch {
    /* 没有 cursor 模块也无妨 */
  }
})

// 安全：禁止渲染进程跳转到外部地址，外链一律交给系统浏览器
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    void shell.openExternal(url)
  })
})
