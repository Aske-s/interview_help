import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { JsonCollection, dataFile } from '../store/store'
import { settingsStore } from '../store/settings'
import type { AgentTemplate, QaRecord, SessionKind, SessionRecord, TodoItem, TranscriptSegment } from '@shared/types'

/** 本地数据：会话记录、智能体模板、待办 */

export const sessions = new JsonCollection<SessionRecord>(dataFile('sessions.json'))
export const todos = new JsonCollection<TodoItem>(dataFile('todos.json'))

export function createSession(kind: SessionKind, title = '未命名会话'): SessionRecord {
  const now = Date.now()
  const record: SessionRecord = {
    id: randomUUID(),
    kind,
    title,
    createdAt: now,
    updatedAt: now,
    transcript: [],
    qa: []
  }
  // QaRecord 里的 createdAt 用于列表排序
  return sessions.upsert(record)
}

export function appendTranscript(sessionId: string, segment: TranscriptSegment): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.transcript.push(segment)
  session.updatedAt = Date.now()
  sessions.upsert(session)
}

/** 尚未命名的会话标题；首个问题出现后会被替换 */
const PLACEHOLDER_TITLES = new Set(['未命名会话', '会议会话', '实时会话', ''])

export function appendQa(sessionId: string, qa: QaRecord): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.qa.push(qa)
  session.updatedAt = Date.now()
  // 用首个问题做标题，方便历史列表辨认
  if (PLACEHOLDER_TITLES.has(session.title) && qa.question.trim()) {
    session.title = qa.question.trim().slice(0, 30)
  }
  sessions.upsert(session)
}

export function registerDataIpc(): void {
  /* ---- 会话 ---- */
  ipcMain.handle(IPC.SessionList, (_e, kind?: SessionKind) => {
    const all = sessions.all().slice().sort((a, b) => b.updatedAt - a.updatedAt)
    return kind ? all.filter((s) => s.kind === kind) : all
  })
  ipcMain.handle(IPC.SessionGet, (_e, id: string) => sessions.get(id))
  ipcMain.handle(IPC.SessionCreate, (_e, kind: SessionKind, title?: string) => createSession(kind, title))
  ipcMain.handle(IPC.SessionUpdate, (_e, id: string, patch: Partial<SessionRecord>) =>
    sessions.patch(id, { ...patch, updatedAt: Date.now() })
  )
  ipcMain.handle(IPC.SessionDelete, (_e, id: string) => sessions.remove(id))
  ipcMain.handle(IPC.SessionAppendTranscript, (_e, id: string, segment: TranscriptSegment) => appendTranscript(id, segment))
  ipcMain.handle(IPC.SessionAppendQa, (_e, id: string, qa: QaRecord) => appendQa(id, qa))

  /* ---- 智能体模板（存在 settings 里，便于随设置一起备份） ---- */
  ipcMain.handle(IPC.AgentList, () => settingsStore.get().agents)
  ipcMain.handle(IPC.AgentSave, (_e, agent: AgentTemplate) => {
    const list = [...settingsStore.get().agents]
    const index = list.findIndex((a) => a.id === agent.id)
    if (index >= 0) list[index] = agent
    else list.push({ ...agent, id: agent.id || randomUUID() })
    settingsStore.patch({ agents: list })
    return list
  })
  ipcMain.handle(IPC.AgentDelete, (_e, id: string) => {
    const list = settingsStore.get().agents.filter((a) => a.id !== id)
    settingsStore.patch({ agents: list })
    return list
  })

  /* ---- 待办 ---- */
  ipcMain.handle(IPC.TodoList, () => todos.all().slice().sort((a, b) => b.createdAt - a.createdAt))
  ipcMain.handle(IPC.TodoAdd, (_e, text: string, sessionId?: string) => {
    todos.upsert({ id: randomUUID(), text, done: false, createdAt: Date.now(), sessionId })
    return todos.all()
  })
  ipcMain.handle(IPC.TodoToggle, (_e, id: string) => {
    const item = todos.get(id)
    if (item) todos.patch(id, { done: !item.done })
    return todos.all()
  })
  ipcMain.handle(IPC.TodoDelete, (_e, id: string) => {
    todos.remove(id)
    return todos.all()
  })
}
