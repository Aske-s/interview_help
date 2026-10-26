import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { settingsStore } from './store/settings'
import { startHoverTracking, stopHoverTracking } from './hover'
import { trackProtectedWindow, applyDisguise } from './security/protection'
import type { WindowKind } from '@shared/window-kind'

const DEV_URL = process.env['ELECTRON_RENDERER_URL']

function preloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`)
}

function rendererFile(html: string): string {
  // 生产：out/renderer/<html>；开发：走 dev server
  return join(__dirname, `../renderer/${html}`)
}

export function loadPage(win: BrowserWindow, html: string, query: Record<string, string> = {}): void {
  const search = new URLSearchParams(query).toString()
  if (DEV_URL) {
    const url = `${DEV_URL}/${html}${search ? `?${search}` : ''}`
    void win.loadURL(url)
  } else {
    const file = rendererFile(html)
    if (!existsSync(file)) {
      console.error(`[window] 渲染入口缺失：${file}`)
    }
    void win.loadFile(file, { search })
  }
}

const windows = new Map<WindowKind, BrowserWindow>()

export function getWindow(kind: WindowKind): BrowserWindow | null {
  const win = windows.get(kind)
  if (win && !win.isDestroyed()) return win
  if (win) windows.delete(kind)
  return null
}

export function allWindows(): BrowserWindow[] {
  return [...windows.values()].filter((w) => !w.isDestroyed())
}

/** 带窗口种类的窗口列表，供开发期截图等场景使用 */
export function windowEntries(): Array<[WindowKind, BrowserWindow]> {
  return [...windows.entries()].filter(([, w]) => !w.isDestroyed())
}

/** 向所有窗口广播（预加载层据此分发事件） */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of allWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/* ------------------------------------------------------------------ *
 * 主窗口
 * ------------------------------------------------------------------ */

export function openMainWindow(): BrowserWindow {
  const existing = getWindow('main')
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'AI 面试助手',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#12121a',
    show: false,
    webPreferences: {
      preload: preloadPath('index'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  windows.set('main', win)
  loadPage(win, 'index.html')
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => windows.delete('main'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

/* ------------------------------------------------------------------ *
 * 悬浮窗
 * ------------------------------------------------------------------ */

export function openFloatingWindow(): BrowserWindow {
  const existing = getWindow('floating')
  if (existing) {
    existing.showInactive()
    return existing
  }

  const settings = settingsStore.get()
  const display = screen.getPrimaryDisplay().workArea

  const win = new BrowserWindow({
    // 两栏布局（实时转写 + 答案）需要足够宽度
    width: 920,
    height: 620,
    x: Math.max(display.x, display.x + display.width - 960),
    y: display.y + 80,
    minWidth: 480,
    minHeight: 260,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 悬浮窗需要压过全屏的会议/面试软件
    alwaysOnTop: true,
    acceptFirstMouse: true,
    // “放弃焦点”：默认不抢焦点，避免切换窗口被察觉
    focusable: !settings.stealth.releaseFocus,
    webPreferences: {
      preload: preloadPath('floating'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  windows.set('floating', win)

  // screen-saver 层级才能真正浮在全屏应用之上
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(settings.stealth.contentProtection)
  if (settings.stealth.clickThrough) {
    win.setIgnoreMouseEvents(true, { forward: true })
  }

  loadPage(win, 'floating.html')
  win.once('ready-to-show', () => {
    win.showInactive()
    applyFloatingOpacity(win, settings.ui.opacity)
  })
  win.on('closed', () => windows.delete('floating'))
  return win
}

export function applyFloatingOpacity(win: BrowserWindow, opacity: number): void {
  const clamped = Math.min(1, Math.max(0.15, opacity))
  // 透明窗口用整体透明度最稳（避免 setOpacity 在部分 macOS 版本上的闪烁）
  win.setOpacity(clamped)
}

/* ------------------------------------------------------------------ *
 * 笔试 / 面试 / 截图
 * ------------------------------------------------------------------ */

interface SimpleWindowOptions {
  kind: WindowKind
  html: string
  preload: string
  width: number
  height: number
  title: string
  alwaysOnTop?: boolean
  transparent?: boolean
  frame?: boolean
}

function openSimpleWindow(opts: SimpleWindowOptions): BrowserWindow {
  const existing = getWindow(opts.kind)
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    minWidth: 420,
    minHeight: 360,
    title: opts.title,
    show: false,
    frame: opts.frame ?? true,
    transparent: opts.transparent ?? false,
    backgroundColor: opts.transparent ? '#00000000' : '#12121a',
    titleBarStyle: opts.frame === false ? undefined : 'hiddenInset',
    alwaysOnTop: opts.alwaysOnTop ?? false,
    webPreferences: {
      preload: preloadPath(opts.preload),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (opts.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  if (settingsStore.get().stealth.contentProtection) win.setContentProtection(true)

  windows.set(opts.kind, win)
  // 登记内容保护：原版在每次 show/resize/全屏切换后都会重新应用，避免共享时偶发漏光
  trackProtectedWindow(win)
  applyDisguise(win, settingsStore.get().stealth.safeMode)
  loadPage(win, opts.html)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => windows.delete(opts.kind))
  return win
}

export function openQuizWindow(): BrowserWindow {
  return openSimpleWindow({
    kind: 'quiz',
    html: 'quiz.html',
    preload: 'quiz',
    width: 900,
    height: 700,
    title: '笔试 / 截图解题',
    alwaysOnTop: true
  })
}

export function openInterviewWindow(): BrowserWindow {
  return openSimpleWindow({
    kind: 'interview',
    html: 'interview.html',
    preload: 'interview',
    width: 940,
    height: 720,
    title: 'AI 面试',
    alwaysOnTop: false
  })
}

/** 全屏选区截图覆盖层 */
export function openCaptureWindow(displayId?: number): BrowserWindow {
  const existing = getWindow('capture')
  if (existing) {
    existing.close()
  }

  const displays = screen.getAllDisplays()
  const target = displays.find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
  const { x, y, width, height } = target.bounds

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    fullscreenable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath('capture'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 选区窗口本身绝不能被录屏/截图捕获，否则会拍到遮罩
  win.setContentProtection(true)

  windows.set('capture', win)
  loadPage(win, 'capture.html', { displayId: String(target.id) })
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
    win.focus()
  }
  win.once('ready-to-show', showOnce)
  // 兜底：透明页面若一直不触发 ready-to-show，遮罩就永远不出现（用户会以为没反应）
  setTimeout(showOnce, 350)
  win.on('closed', () => windows.delete('capture'))
  return win
}

export function openWindowByKind(kind: WindowKind): BrowserWindow | null {
  if (kind === 'quizbar') return openQuizbarWindow()
  switch (kind) {
    case 'main':
      return openMainWindow()
    case 'floating':
      return openFloatingWindow()
    case 'quiz':
      return openQuizWindow()
    case 'interview':
      return openInterviewWindow()
    case 'capture':
      return openCaptureWindow()
    default:
      return null
  }
}

export function closeWindowByKind(kind: WindowKind): void {
  getWindow(kind)?.close()
}

/**
 * 笔试/面试悬浮工具条（对齐原版「快捷操作」）。
 *
 * 特点：半透明、无边框、置顶、默认不抢焦点、可整体穿透。
 * 尺寸刻意做得很小（一条横向工具条），它不是主界面。
 */
export function openQuizbarWindow(): BrowserWindow {
  const existing = getWindow('quizbar')
  if (existing) {
    existing.showInactive()
    return existing
  }
  const settings = settingsStore.get()
  const area = screen.getPrimaryDisplay().workArea
  const BAR_W = 460
  const BAR_H = 320

  const win = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    // 默认放在屏幕右上角，避开常见软件的工具栏，也不挡答题区域中心
    x: Math.round(area.x + area.width - BAR_W - 24),
    y: area.y + 24,
    /*
     * 尺寸约束：
     * 这是一个可拖拽、可缩放的浮窗（原版就是这种形态），不是一条只能看的横条。
     * 早先把高度锁在 56 且 maxHeight=320，导致「巨小、拉不大」——这里放开。
     */
    minWidth: 360,
    minHeight: 48,
    maxWidth: 1200,
    maxHeight: 900,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 与悬浮窗一致：不抢焦点，避免打断会议/答题
    focusable: false,
    webPreferences: {
      preload: preloadPath('quizbar'),
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * 必须与其它窗口一致用 false。
       * 曾经这里写成 !process.env['SUISI_NO_SANDBOX']，在没设环境变量时等于 true；
       * sandbox 开启后 preload 无法 require 相对路径的 chunk，window.api 不会暴露，
       * 界面会直接报「Cannot read properties of undefined (reading 'settings')」。
       */
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(settings.stealth.contentProtection || settings.stealth.safeMode)
  win.setIgnoreMouseEvents(settings.stealth.clickThrough, { forward: true })
  win.setOpacity(clampBarOpacity(settings.ui.opacity))
  // 允许用户按自己的习惯调整大小（记得住）
  win.setMinimumSize(360, 48)

  // 必须注册进 Map，否则 getWindow 查不到、每次都会新建重复窗口
  windows.set('quizbar', win)
  startHoverTracking(win, 'quizbar')
  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    stopHoverTracking(win)
    if (windows.get('quizbar') === win) windows.delete('quizbar')
  })
  loadPage(win, 'quizbar.html')
  return win
}

/** 工具条不透明度：与悬浮窗同一口径（0.15-1） */
function clampBarOpacity(value: number): number {
  const v = Number.isFinite(value) ? value : 0.7
  return Math.min(1, Math.max(0.15, v))
}

/**
 * 替代光标窗口（安全模式隐藏真实鼠标时使用）。
 *
 * 必须覆盖全屏、完全透明、且鼠标穿透——否则它会挡住用户所有点击。
 * `forward: true` 让窗口在穿透状态下仍能拿到 mousemove（保险起见位置由主进程推送）。
 */
export function openCursorWindow(): BrowserWindow {
  const existing = getWindow('cursor')
  if (existing) return existing
  const area = screen.getPrimaryDisplay().bounds

  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath('cursor'),
      contextIsolation: true,
      nodeIntegration: false,
      // 同 quizbar：必须 false，否则 preload 加载不了相对 chunk
      sandbox: false
    }
  })

  // 压过一切：光标必须始终在最上层
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 关键：整窗鼠标穿透，否则用户点不到任何东西
  win.setIgnoreMouseEvents(true, { forward: true })

  windows.set('cursor', win)
  win.on('closed', () => {
    if (windows.get('cursor') === win) windows.delete('cursor')
  })
  loadPage(win, 'cursor.html')
  return win
}

/** 显示/隐藏替代光标窗口 */
export function setCursorOverlayVisible(visible: boolean): void {
  const win = visible ? openCursorWindow() : getWindow('cursor')
  if (!win) return
  if (visible) win.showInactive()
  else win.hide()
}
