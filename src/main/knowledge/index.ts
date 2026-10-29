import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { KnowledgeDocument, Result, KnowledgePurpose } from '@shared/types'
import { chatComplete, embed } from '../gateway/llm'
import { settingsStore } from '../store/settings'
import { activeProvider } from '../store/settings'
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

/* ------------------------------------------------------------------ *
 * 按用途整份注入
 * ------------------------------------------------------------------ */

/**
 * 把某个用途的知识库拼成一段上下文（按字符预算截断）。
 *
 * 为什么不用相似度检索：简历、题库这类内容是"稳定背景"，回答时几乎总会用到，
 * 而检索是按当前问题的关键词捞片段的 —— 问「介绍一下你自己」时，
 * 简历里最关键的「工作经历 / 技术栈」很可能因为不含这些词而捞不到，
 * 于是答得断断续续。这类内容就该整份给。
 *
 * 多份同用途的知识库按更新时间从新到旧拼接，超预算就从后往前截。
 */
export function contextByPurpose(purpose: KnowledgePurpose, maxChars: number): string {
  const matched = kbs
    .all()
    .filter((kb) => (kb.purpose ?? 'general') === purpose)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!matched.length) return ''

  const allDocs = docs.all()
  const allChunks = chunkStore.all()
  const blocks: string[] = []
  let budget = maxChars
  for (const kb of matched) {
    if (budget <= 0) break

    /*
     * 简历：有速查卡就只用速查卡。
     * 速查卡是上传时一次性提炼的（~1200 字），比原文短得多、信息密度更高，
     * 而且整场面试不变 —— 直接注入，不必每轮重算。
     */
    if (purpose === 'resume' && kb.profile) {
      const slice = kb.profile.length <= budget ? kb.profile : kb.profile.slice(0, budget)
      blocks.push(`《${kb.name}》（速查卡）\n${slice}`)
      budget -= slice.length
      continue
    }

    /*
     * 注意集合的存储顺序：JsonCollection.upsert 用的是 unshift（新项在前），
     * 所以 docs.all() 是「最后导入的在前」。这里反转回来才是导入顺序 ——
     * 否则简历会从最后一页开始读、题库从最后一题开始读。
     */
    const kbDocs = allDocs
      .filter((doc) => doc.kbId === kb.id)
      .slice()
      .reverse()
    if (!kbDocs.length) continue
    const kbChunks = allChunks.filter((chunk) => chunk.kbId === kb.id)
    // 按导入顺序拼，读起来才像一份完整的文档
    const full = kbDocs
      .map((doc) => kbChunks.filter((chunk) => chunk.docId === doc.id).map((chunk) => chunk.text).join('\n'))
      .filter(Boolean)
      .join('\n')
    if (!full) continue
    const slice = full.length <= budget ? full : full.slice(0, budget)
    blocks.push(`《${kb.name}》\n${slice}${slice.length < full.length ? '\n…（内容较长，已截断）' : ''}`)
    budget -= slice.length
  }
  return blocks.join('\n\n')
}

/* ------------------------------------------------------------------ *
 * 简历：上传后一次性提炼成「速查卡」
 * ------------------------------------------------------------------ */

/** 提炼时喂给模型的简历原文上限（防超长简历把请求撑爆） */
const RESUME_SOURCE_MAX_CHARS = 8000
/** 速查卡的目标长度（写进提示词 + 生成后再兜底截断） */
export const RESUME_PROFILE_MAX_CHARS = 1200

/** 提炼提示词：只认原文事实、结构化、压到 1200 字内 */
function resumeProfilePrompt(source: string): string {
  return [
    '把下面的简历提炼成一份给「面试实时助答」用的速查卡。',
    '硬性要求：',
    `1. 总长必须控制在 ${RESUME_PROFILE_MAX_CHARS} 字以内，宁可少写也不要啰嗦；`,
    '2. 只用简历里出现的事实，绝对不要补充、外推或编造任何经历与技术；',
    '3. 输出纯文本，不要 Markdown 标题符号，严格按下面五段：',
    '基本信息：<工作年限> / <岗位方向> / <学历或专业>',
    '技术栈：<按后端/前端/数据/运维等分组，只列简历里出现的>',
    '项目经历：（每条一行）<项目名>｜<一句话背景>｜我的职责：<做了什么>｜技术点：<关键技术>｜亮点：<量化结果，没有就写 无>',
    '可讲的强项：<3-5 条，用于回答「介绍一下你自己」「为什么选你」>',
    '常见追问备料：<针对上面项目最容易被追问的 2-3 个点，各给一句要点>',
    '',
    '简历原文：',
    source
  ].join('\n')
}

/** 取某个知识库的全部原文（按导入顺序） */
function rawTextOf(kbId: string): string {
  const kbDocs = docs
    .all()
    .filter((doc) => doc.kbId === kbId)
    .slice()
    .reverse()
  const all = chunkStore.all().filter((chunk) => chunk.kbId === kbId)
  return kbDocs
    .map((doc) => all.filter((chunk) => chunk.docId === doc.id).map((chunk) => chunk.text).join('\n'))
    .filter(Boolean)
    .join('\n')
}

export interface DistillResult {
  ok: boolean
  /** 速查卡字数 */
  chars?: number
  error?: string
}

/**
 * 把简历知识库提炼成速查卡并存下来。
 *
 * 只在「导入/更新简历」时跑一次；失败不抛出（返回 ok:false），
 * 调用方可以继续用原文兜底 —— 提炼是优化，不是必需路径。
 */
export async function distillResume(kbId: string): Promise<DistillResult> {
  const kb = kbs.all().find((item) => item.id === kbId)
  if (!kb) return { ok: false, error: '知识库不存在' }
  if ((kb.purpose ?? 'general') !== 'resume') return { ok: false, error: '只有「简历」用途的知识库需要提炼' }

  const source = rawTextOf(kbId).slice(0, RESUME_SOURCE_MAX_CHARS)
  if (!source.trim()) return { ok: false, error: '这个知识库还没有内容' }

  const provider = activeProvider()
  if (!provider?.baseUrl) return { ok: false, error: '未配置模型网关，暂时无法解析简历' }

  try {
    const result = await chatComplete({
      provider,
      messages: [
        { role: 'system', content: '你是简历结构化助手，只做提炼，不添加原文没有的信息。' },
        { role: 'user', content: resumeProfilePrompt(source) }
      ],
      maxTokens: 1200
    })
    const profile = result.text.trim()
    if (!profile) return { ok: false, error: '模型没有返回内容' }
    // 兜底截断：模型偶尔会写超
    const clipped = profile.length > RESUME_PROFILE_MAX_CHARS
      ? `${profile.slice(0, RESUME_PROFILE_MAX_CHARS)}…`
      : profile
    kb.profile = clipped
    kb.profileAt = Date.now()
    kb.profileModel = provider.model
    kbs.upsert(kb)
    console.log('[knowledge] 简历速查卡已生成：', kb.name, `${clipped.length} 字`)
    return { ok: true, chars: clipped.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[knowledge] 简历提炼失败：', message)
    return { ok: false, error: message }
  }
}

/** 内容变动后清掉旧速查卡，避免用过期信息答题 */
export function invalidateResumeProfile(kbId: string): void {
  const kb = kbs.all().find((item) => item.id === kbId)
  if (!kb || !kb.profile) return
  kb.profile = undefined
  kb.profileAt = undefined
  kb.profileModel = undefined
  kbs.upsert(kb)
}
