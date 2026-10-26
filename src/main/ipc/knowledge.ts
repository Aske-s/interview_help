import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { addDocument, knowledgeStore, removeDocument, removeKb, search } from '../knowledge'
import type { KnowledgeBase, KnowledgeDocument, Result, RetrievedChunk } from '@shared/types'

/**
 * 知识库 IPC：与 shared/ipc.ts 的 KnowledgeApi 一一对应，共 7 个通道。
 * handler 只做参数兜底与转发，业务逻辑都在 ../knowledge。
 */

export function registerKnowledgeIpc(): void {
  ipcMain.handle(IPC.KbList, (): KnowledgeBase[] =>
    knowledgeStore.kbs
      .all()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  ipcMain.handle(IPC.KbCreate, (_e, name: string, description?: string): KnowledgeBase[] => {
    const now = Date.now()
    const kb: KnowledgeBase = {
      id: randomUUID(),
      name: (name ?? '').trim() || '未命名知识库',
      description,
      createdAt: now,
      updatedAt: now
    }
    knowledgeStore.kbs.upsert(kb)
    return knowledgeStore.kbs.all()
  })

  ipcMain.handle(IPC.KbDelete, (_e, id: string): KnowledgeBase[] => {
    removeKb(id)
    return knowledgeStore.kbs.all()
  })

  ipcMain.handle(
    IPC.KbAddDocument,
    (_e, kbId: string, payload: { path?: string; name?: string; text?: string }): Promise<Result<KnowledgeDocument>> =>
      addDocument(kbId, payload ?? {})
  )

  ipcMain.handle(IPC.KbRemoveDocument, (_e, docId: string): void => removeDocument(docId))

  ipcMain.handle(IPC.KbListDocuments, (_e, kbId: string): KnowledgeDocument[] =>
    knowledgeStore.docs
      .all()
      .filter((doc) => doc.kbId === kbId)
      .sort((a, b) => a.createdAt - b.createdAt)
  )

  // 渲染进程可能传任意参数（未选知识库、空查询等）：这里兜底成空数组，
  // 避免 IPC reject 让界面直接红屏
  ipcMain.handle(
    IPC.KbSearch,
    async (_e, kbIds: string[], query: string, topK?: number): Promise<RetrievedChunk[]> => {
      try {
        return await search(kbIds, query, topK)
      } catch (error) {
        console.warn('[knowledge] IPC 检索失败：', error instanceof Error ? error.message : error)
        return []
      }
    }
  )
}
