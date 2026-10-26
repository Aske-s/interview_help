import { desktopCapturer, screen, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../store/store'
import type { ChatContentPart } from '@shared/types'

/** 判断一个错误是否属于「屏幕录制权限缺失」 */
export function isScreenPermissionError(error: unknown): boolean {
  return error instanceof ScreenPermissionError || (error instanceof Error && error.name === 'ScreenPermissionError')
}

/** 屏幕录制权限缺失（原版会据此弹出授权引导） */
export class ScreenPermissionError extends Error {
  constructor() {
    super('未获得屏幕录制权限，请在系统设置 → 隐私与安全性 → 屏幕录制中允许本应用；如果已开启，请完全退出应用后重新打开')
    this.name = 'ScreenPermissionError'
  }
}

/**
 * 屏幕截图。
 *
 * 实现对齐原版 ScreenshotService.capture：
 *  - 默认把宽度缩到 1920（不是原生 2880）——识题不需要原生分辨率，缩下来更快更小
 *  - 输出 JPEG（质量默认 80），不是 PNG：PNG 一张 1.8MB，传 IPC 和送模型都慢
 *  - **截图前先把自己应用的窗口藏起来**，等 90ms 让窗口真的消失，抓完再恢复。
 *    否则截出来的图里会有我们自己的悬浮窗/工具条。
 *  - 不做区域选择：原版的普通截图就是整屏直出。选区遮罩是**长截图专属**，
 *    而且全屏遮罩容易被在线笔试平台检测到。
 */

export interface CaptureOptions {
  /** 最大宽度，默认 1920 */
  maxWidth?: number
  /** JPEG 质量，默认 80 */
  jpegQuality?: number
  /** 要隐藏的窗口（通常传自己应用的窗口） */
  hideWindows?: BrowserWindow[]
  /** 指定显示器 */
  displayId?: number
  /** 超时（毫秒），默认 8000 */
  timeoutMs?: number
}

/** 等比缩放到最大宽度 */
function scaleToMaxWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  const ratio = Math.min(1, maxWidth / Math.max(1, width))
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/** 带超时的 Promise（原版用 8 秒，权限未决定时给 60 秒） */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 临时隐藏窗口再执行抓屏。
 *
 * 90ms 的等待是必须的：hide() 之后窗口不会立刻从合成器消失，
 * 不等待就会把还没消失的窗口拍进截图里。
 */
async function withHiddenWindows<T>(windows: BrowserWindow[], fn: () => Promise<T>): Promise<T> {
  const targets = windows.filter((w) => w && !w.isDestroyed() && w.isVisible())
  for (const win of targets) {
    try {
      win.hide()
    } catch {
      /* 忽略：某个窗口隐藏失败不该影响截图 */
    }
  }
  if (targets.length > 0) await new Promise((resolve) => setTimeout(resolve, 90))
  try {
    return await fn()
  } finally {
    for (const win of targets) {
      try {
        if (!win.isDestroyed()) win.showInactive()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 抓取整屏，返回 JPEG dataURL。
 *
 * 不再接受 displayId 之外的选择参数——需要区域请用长截图那条独立的链路。
 */
export async function captureScreenDataUrl(options: CaptureOptions = {}): Promise<string> {
  const maxWidth = options.maxWidth ?? 1920
  const jpegQuality = Math.min(100, Math.max(10, options.jpegQuality ?? 80))
  const timeoutMs = options.timeoutMs ?? 8000

  const displays = screen.getAllDisplays()
  const target = displays.find((d) => d.id === options.displayId) ?? screen.getPrimaryDisplay()
  const scale = target.scaleFactor || 1
  const size = scaleToMaxWidth(
    Math.round(target.size.width * scale),
    Math.round(target.size.height * scale),
    maxWidth
  )

  const sources = await withHiddenWindows(options.hideWindows ?? [], () =>
    withTimeout(
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: size.width, height: size.height }
      }),
      timeoutMs,
      '屏幕采集超时，请重试；如果刚修改权限，请完全退出应用后重新打开'
    )
  )

  if (!sources.length) {
    /*
     * 原版在这里会区分「权限被拒」并引导用户去系统设置授权。
     * getSources 返回空数组就是权限缺失的典型表现（不是没有显示器）。
     */
    throw new ScreenPermissionError()
  }

  const source = sources.find((s) => String(s.display_id) === String(target.id)) ?? sources[0]
  if (source.thumbnail.isEmpty()) throw new ScreenPermissionError()

  /*
   * 输出 JPEG：比 PNG 小一个数量级，识题足够。
   * NativeImage 没有 toDataURL('image/jpeg', q) 这种签名，必须走 toJPEG(quality)。
   */
  return `data:image/jpeg;base64,${source.thumbnail.toJPEG(jpegQuality).toString('base64')}`
}

/** 把 dataURL 包成多模态消息里的图片片段 */
export function imagePart(dataUrl: string): ChatContentPart {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

/** 把 dataURL 落盘到 data/captures，返回文件路径（调试/留档用） */
export function saveDataUrl(dataUrl: string, prefix = 'capture'): string {
  const match = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw new Error('图片数据格式不正确')
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const dir = join(dataDir(), 'captures')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `${prefix}-${Date.now()}.${ext}`)
  writeFileSync(file, Buffer.from(match[2], 'base64'))
  return file
}
