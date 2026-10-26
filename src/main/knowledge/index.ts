import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { KnowledgeDocument, Result } from '@shared/types'
import { embed } from '../gateway/llm'
import { settingsStore } from '../store/settings'
import { chunkText } from './chunk'
import { extractText } from './extract'
import { chunkStore, docs, kbs, vectorStore, type Chunk } from './store'

/**
 * 本地知识库子系统：导入 → 分块 →（可选）向量化 → 检索。
 *
 * 对外只有两块入口：
 *  - registerKnowledgeIpc()  见 ./ipc/knowledge.ts，给渲染进程用
 *  - retrieveContext()       给实时会话编排器注入上下文用，保证永不抛错
 */

export { MAX_FILE_BYTES, extractText } from './extract'
export { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from './chunk'
export { knowledgeStore } from './store'
export type { Chunk } from './store'
export { retrieveContext, search, tokenize } from './retrieval'
export type { Token } from './retrieval'

/** 校验网关返回的向量是否可用（行数、维度都要对齐，否则宁可不存） */
function usableVectors(vectors: number[][] | null, expectedRows: number): number[][] | null {
  if (!vectors || expectedRows <= 0 || vectors.length !== expectedRows) return null
  const dim = vectors[0]?.length ?? 0
  if (!dim) return null
  for (const row of vectors) {
    if (row.length !== dim) return null
  }
  return vectors
}

/** 内容变化时刷新 updatedAt（知识库列表按它排序） */
function touchKb(kbId: string): void {
  if (kbs.get(kbId)) kbs.patch(kbId, { updatedAt: Date.now() })
}

/**
 * 导入文档：path 指文件，或直接用 text 粘贴文本。
 * 返回 Result：文件超限、格式不支持、抽取失败等都通过 error 字段返回，不抛异常。
 */
export async function addDocument(
  kbId: string,
  payload: { path?: string; name?: string; text?: string }
): Promise<Result<KnowledgeDocument>> {
  try {
    if (!kbId || !kbs.get(kbId)) return { ok: false, error: '知识库不存在' }

    const name = (payload?.name ?? (payload?.path ? basename(payload.path) : '粘贴文本')).trim() || '未命名文档'
    const pasted = typeof payload?.text === 'string' ? payload.text : ''
    const text = pasted.trim() ? pasted : payload?.path ? await extractText(payload.path) : ''
    if (!text.trim()) return { ok: false, error: '未能提取到文本内容（空文件，或既未提供 text 也未提供 path）' }

    const pieces = chunkText(text)
    if (!pieces.length) return { ok: false, error: '文本为空，无法分块' }

    // 向量是可选增强：未配置、或网关调用失败，都只降级为关键词检索，不让导入失败
    const cfg = settingsStore.get().embedding
    let vectors: number[][] | null = null
    if (cfg.enabled && cfg.baseUrl && cfg.model) {
      try {
        vectors = usableVectors(
          await embed({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }, pieces),
          pieces.length
        )
      } catch (error) {
        console.warn('[knowledge] 向量化失败，退化为关键词检索：', error instanceof Error ? error.message : error)
        vectors = null
      }
    }

    const doc: KnowledgeDocument = {
      id: randomUUID(),
      kbId,
      name,
      path: payload?.path,
      chars: text.length,
      chunks: pieces.length,
      createdAt: Date.now()
    }

    // 先把向量落盘拿到起始行号，再一次性写分块文件（整篇文档只写一次盘）
    let items: Chunk[] = pieces.map((piece) => ({
      id: randomUUID(),
      kbId,
      docId: doc.id,
      docName: name,
      text: piece
    }))

    if (vectors) {
      const { startRow, reset } = vectorStore.appendRows(kbId, vectors)
      if (reset) {
        // 向量模型换了、维度对不上：旧分块的行号已失效，清空后重建
        const existing = chunkStore.allFor([kbId])
        for (const chunk of existing) delete chunk.vec
        if (existing.length) chunkStore.overwrite(kbId, existing)
      }
      items = items.map((item, index) => ({ ...item, vec: startRow + index }))
    }

    chunkStore.appendMany(kbId, items)
    docs.upsert(doc)
    touchKb(kbId)
    return { ok: true, data: doc }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 删除文档后重整向量行号，保持 vec 与 .bin 行一一对应 */
function rebuildVectors(kbId: string, remaining: Chunk[]): void {
  const block = vectorStore.load(kbId)
  if (!block) {
    // 向量文件丢了：清掉残留行号，检索自动回到 BM25
    let changed = false
    for (const chunk of remaining) {
      if (typeof chunk.vec === 'number') {
        delete chunk.vec
        changed = true
      }
    }
    if (changed) chunkStore.overwrite(kbId, remaining)
    return
  }

  const vectorized = remaining.filter((chunk) => typeof chunk.vec === 'number' && (chunk.vec as number) < block.rows)
  const rows = vectorized.map((chunk) => {
    const start = (chunk.vec as number) * block.dim
    const row: number[] = new Array(block.dim)
    for (let i = 0; i < block.dim; i++) row[i] = block.data[start + i]
    return row
  })

  vectorized.forEach((chunk, index) => {
    chunk.vec = index
  })
  const kept = new Set(vectorized)
  for (const chunk of remaining) {
    if (!kept.has(chunk)) delete chunk.vec
  }

  chunkStore.overwrite(kbId, remaining)
  if (rows.length) vectorStore.save(kbId, rows)
  else vectorStore.removeKb(kbId)
}

/** 删除单个文档及其全部分块 */
export function removeDocument(docId: string): void {
  const doc = docs.get(docId)
  if (!doc) return
  const hadVectors = chunkStore.allFor([doc.kbId]).some((chunk) => typeof chunk.vec === 'number')
  docs.remove(docId)
  const rest = chunkStore.removeByDoc(doc.kbId, docId)
  if (hadVectors) rebuildVectors(doc.kbId, rest)
  touchKb(doc.kbId)
}

/** 删除知识库：级联清掉文档元数据、分块文件与向量文件 */
export function removeKb(kbId: string): void {
  const all = docs.all()
  const remaining = all.filter((doc) => doc.kbId !== kbId)
  if (remaining.length !== all.length) docs.replaceAll(remaining)
  chunkStore.removeKb(kbId)
  vectorStore.removeKb(kbId)
  kbs.remove(kbId)
}
