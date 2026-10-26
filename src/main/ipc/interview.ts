import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { basename } from 'node:path'
import { extractText } from '../knowledge'
import {
  answerInterview,
  generateInterviewReview,
  createInterview,
  deleteInterview,
  finishInterview,
  getInterview,
  listInterviews,
  startInterview
} from '../interview'
import type { InterviewConfig } from '@shared/types'

/** AI 面试 IPC */

export function registerInterviewIpc(): void {
  ipcMain.handle(IPC.InterviewList, () => listInterviews())
  ipcMain.handle(IPC.InterviewGet, (_e, id: string) => getInterview(id))

  /**
   * 创建面试。预加载层按 `invoke(channel, role, background)` 透传参数：
   * - 新 UI 把整份 InterviewConfig 当作第一个参数传入（第二个为 undefined）
   * - 旧调用仍可能是 (role, background) 两个字符串
   * 两种形态都要能工作。
   */
  ipcMain.handle(IPC.InterviewCreate, (_e, configOrRole: InterviewConfig | string, background?: string) => {
    return typeof configOrRole === 'string' ? createInterview(configOrRole, background ?? '') : createInterview(configOrRole)
  })

  ipcMain.handle(IPC.InterviewStart, (_e, id: string) => startInterview(id))
  ipcMain.handle(IPC.InterviewAnswer, (_e, id: string, answer: string, elapsedMs?: number) =>
    answerInterview(id, answer, typeof elapsedMs === 'number' ? elapsedMs : undefined)
  )
  ipcMain.handle(IPC.InterviewFinish, (_e, id: string) => finishInterview(id))
  ipcMain.handle(IPC.InterviewDelete, (_e, id: string) => deleteInterview(id))
  ipcMain.handle(IPC.InterviewGenerateReview, (_e, id: string) => generateInterviewReview(id, { finish: false }))

  /** 解析简历：复用知识库的文本抽取（PDF/Word/纯文本） */
  ipcMain.handle(IPC.InterviewParseResume, async (_e, filePath: string) => {
    try {
      const text = await extractText(filePath)
      if (!text.trim()) return { ok: false, error: '未能从该文件中提取到文本内容' }
      return { ok: true, data: { text: text.trim(), name: basename(filePath) } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
