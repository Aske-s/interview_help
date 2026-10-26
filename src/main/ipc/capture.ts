import { clipboard, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { broadcast, closeWindowByKind, openCaptureWindow } from '../windows'
import { captureScreenDataUrl, imagePart, saveDataUrl } from '../capture'
import { allWindows } from '../windows'
import { activeMode } from '../store/modes'
import { isScreenPermissionError, ScreenPermissionError } from '../capture'
import { openPrivacySettings, requestPermission } from '../diagnostics/devices'
import { activeProvider, settingsStore } from '../store/settings'
import { runStream } from '../gateway/stream-manager'
import { randomUUID } from 'node:crypto'
import type { ChatContentPart, ChatMessage } from '@shared/types'

/** 截图解题：选区截图 → 多模态识别 → 流式答案 */

let pendingSource = ''
let currentRequestId: string | null = null

/** 默认解题提示词；编程题会要求给代码 */
function defaultPrompt(): string {
  return [
    '请识别图片中的题目，并给出解题过程。',
    '如果是编程题：先用一两句话说明思路与复杂度，再给出完整可运行代码（标注语言）。',
    '如果是选择题或问答题：直接给出正确答案，再简要说明理由。',
    '不要复述题目全文，不要输出与解题无关的客套话。'
  ].join('\n')
}

async function answerImage(dataUrl: string, prompt?: string): Promise<void> {
  const provider = activeProvider()
  if (!provider?.baseUrl) {
    broadcast(IPC.AnswerImageDone, 'error', '', '未配置模型网关，请到「设置 → 模型网关」填写')
    return
  }
  if (!provider.supportsVision) {
    broadcast(
      IPC.AnswerImageDone,
      'error',
      '',
      `当前模型「${provider.model}」未开启图片输入。请到「设置 → 模型网关」勾选「支持图片」，或换用多模态模型。`
    )
    return
  }

  if (currentRequestId) return // 上一题还在解，避免重复请求
  const reqId = randomUUID()
  currentRequestId = reqId

  const content: ChatContentPart[] = [{ type: 'text', text: prompt?.trim() || defaultPrompt() }, imagePart(dataUrl)]
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是一名擅长读题与解题的助手，输出要直接可用。' },
    { role: 'user', content }
  ]

  runStream(
    { requestId: reqId, provider, messages },
    {
      onDelta: (delta) => broadcast(IPC.AnswerImageDelta, reqId, delta),
      onDone: (result) => {
        currentRequestId = null
        broadcast(IPC.AnswerImageDone, reqId, result.text)
      },
      onError: (message) => {
        currentRequestId = null
        broadcast(IPC.AnswerImageDone, reqId, '', message)
      }
    }
  )
}

/**
 * 开始一次选区截图：**先抓屏，成功了才开遮罩**。
 *
 * 这是按钮、快捷键、悬浮窗相机共用的唯一入口。
 * 曾经快捷键直接调 openCaptureWindow() 而没抓屏，导致遮罩拿到空底图：
 * 用户看到的是一个全屏置顶、什么都点不了的透明窗口，像卡死一样。
 */
/**
 * 抓取整屏并直接识题。
 *
 * 对齐原版：普通截图就是**整屏直出**，不做区域选择。
 * 原因（用户指出，也是原版的设计）：全屏选区遮罩容易被在线笔试平台检测到；
 * 而且选区交互本身比"直接出答案"慢得多。
 */
export async function captureAndAnswer(): Promise<{ ok: boolean; error?: string }> {
  try {
    const settings = settingsStore.get()
    const mode = activeMode(settings)
    const dataUrl = await captureScreenDataUrl({
      // 截图质量跟着笔试模式走（原版 quizConfig.jpegQuality）
      jpegQuality: mode?.quizConfig?.jpegQuality ?? 80,
      // 关键：截图前把自己应用的窗口藏起来，否则会拍到我们自己的悬浮窗
      hideWindows: allWindows()
    })
    /*
     * 先把截图广播给悬浮窗——原版是「截图直接进框，用户能看到自己截到了什么」，
     * 卡片上还有 共N张/上一张/下一张/长截图 这些标记。
     * 漏了这一步，卡片里的截图区就永远是空的。
     */
    broadcast(IPC.CaptureDone, { dataUrl })
    await answerImage(dataUrl)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    /*
     * 权限缺失是可恢复的：原版会引导用户去系统设置。
     * 这里额外打开系统设置的「屏幕录制」面板，省得用户自己找。
     */
    if (isScreenPermissionError(error)) {
      broadcast(IPC.AnswerImageDone, '', '', message)
      // 先让系统把本应用登记进「屏幕录制」列表，再跳到对应设置面板
      void requestPermission('screen').then(() => openPrivacySettings('screen'))
      return { ok: false, error: message }
    }
    broadcast(IPC.AnswerImageDone, '', '', `截图失败：${message}`)
    return { ok: false, error: message }
  }
}

export function registerCaptureIpc(): void {
  ipcMain.handle(IPC.CaptureStart, async (_e, mode?: 'region' | 'fullscreen' | 'long') => {
    // 区域选择已移除：整屏直出（原版行为）
    void mode
    return captureAndAnswer()
  })

  ipcMain.handle(IPC.CaptureGetSource, () => pendingSource)

  /* 直接抓一屏（无遮罩），供长截图/批量截图累加 */
  ipcMain.handle(IPC.CaptureGrabScreen, async (_e, displayId?: number) => {
    try {
      const dataUrl = await captureScreenDataUrl({ displayId, hideWindows: allWindows() })
      return { ok: true, data: dataUrl }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on(IPC.CaptureDone, (_e, dataUrl: string) => {
    closeWindowByKind('capture')
    pendingSource = ''
    if (!dataUrl) return
    broadcast(IPC.CaptureDone, { dataUrl })
    void answerImage(dataUrl)
  })

  ipcMain.on(IPC.CaptureCancel, () => {
    closeWindowByKind('capture')
    pendingSource = ''
  })

  ipcMain.handle(IPC.CaptureSave, (_e, dataUrl: string) => {
    try {
      return { ok: true, data: saveDataUrl(dataUrl) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IPC.CaptureReadClipboardImage, async () => {
    // Electron 45 的 clipboard 已改为异步 API，图片需要通过 read() 取 Blob
    const items = await clipboard.read()
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'))
      if (!imageType) continue
      const payload = await item.getType(imageType)
      if (!(payload instanceof Blob)) continue
      const buffer = Buffer.from(await payload.arrayBuffer())
      return `data:${imageType};base64,${buffer.toString('base64')}`
    }
    return null
  })

  ipcMain.handle(IPC.AnswerImage, async (_e, dataUrl: string, prompt?: string) => {
    await answerImage(dataUrl, prompt)
    return { ok: true }
  })

  // 安全模式会影响文件选择器等系统能力，这里给出统一提示位
  settingsStore.on('changed', () => {
    if (!settingsStore.get().stealth.contentProtection) return
  })
}
