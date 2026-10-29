import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import {
  addDocument,
  distillResume,
  invalidateResumeProfile,
  knowledgeStore,
  removeDocument,
  removeKb,
  search
} from '../knowledge'
import type { KnowledgeBase, KnowledgeDocument, Result, RetrievedChunk, KnowledgePurpose } from '@shared/types'

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

  ipcMain.handle(
    IPC.KbCreate,
    (_e, name: string, description?: string, purpose?: KnowledgePurpose): KnowledgeBase[] => {
      const now = Date.now()
      const kb: KnowledgeBase = {
        id: randomUUID(),
        name: (name ?? '').trim() || '未命名知识库',
        description,
        purpose: purpose ?? 'general',
        createdAt: now,
        updatedAt: now
      }
      knowledgeStore.kbs.upsert(kb)
      return knowledgeStore.kbs.all()
    }
  )

  /** 改知识库用途（简历 / 题库 / 通用） */
  ipcMain.handle(IPC.KbSetPurpose, (_e, kbId: string, purpose: KnowledgePurpose): KnowledgeBase[] => {
    const kb = knowledgeStore.kbs.all().find((item) => item.id === kbId)
    if (kb) {
      kb.purpose = purpose
      kb.updatedAt = Date.now()
      knowledgeStore.kbs.upsert(kb)
    }
    return knowledgeStore.kbs.all()
  })

  ipcMain.handle(IPC.KbDistillResume, (_e, kbId: string) => distillResume(kbId))

  ipcMain.handle(IPC.KbDelete, (_e, id: string): KnowledgeBase[] => {
    removeKb(id)
    return knowledgeStore.kbs.all()
  })

  ipcMain.handle(
    IPC.KbAddDocument,
    async (_e, kbId: string, payload: { path?: string; name?: string; text?: string }): Promise<Result<KnowledgeDocument>> => {
      const result = await addDocument(kbId, payload ?? {})
      if (!result.ok) return result
      const kb = knowledgeStore.kbs.all().find((item) => item.id === kbId)
      if ((kb?.purpose ?? 'general') === 'resume') {
        // 内容变了，旧速查卡作废；后台重新提炼，不拖慢导入
        invalidateResumeProfile(kbId)
        void distillResume(kbId)
      }
      return result
    }
  )

  ipcMain.handle(IPC.KbRemoveDocument, (_e, docId: string): void => {
    const doc = knowledgeStore.docs.all().find((item) => item.id === docId)
    removeDocument(docId)
    // 删掉文档后速查卡就过期了，清掉（下次导入会重新生成）
    if (doc) invalidateResumeProfile(doc.kbId)
  })

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
