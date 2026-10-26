import { embed } from '../gateway/llm'
import { settingsStore } from '../store/settings'
import type { RetrievedChunk } from '@shared/types'
import type { Chunk } from './store'
import { chunkStore, vectorStore } from './store'

/**
 * 检索：向量（余弦相似度）优先，关键词（BM25）作为兜底与补齐。
 *
 * 降级策略是刻意的：知识库不该因为没配向量模型就不可用，
 * 也不该因为向量网关临时抽风就整场会议没有上下文。
 */

/** BM25 参数：k1 控制词频饱和速度，b 控制文档长度归一化强度 */
const K1 = 1.2
const B = 0.75
/** 单次检索的结果上限，避免渲染进程传超大 topK 拖慢主进程 */
const MAX_TOP_K = 50
/** 检索索引缓存条数上限（实时会话通常只用到一两个知识库组合） */
const MAX_CACHED_INDEXES = 8

/* ------------------------------------------------------------------ *
 * 分词与词元权重
 * ------------------------------------------------------------------ */

export interface Token {
  term: string
  /** 词元权重：数字与专有名词更重要 */
  boost: number
}

/** 高频英文虚词：首字母大写多半只是句首，不该按专有名词加权 */
const CAPITALIZED_STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'of', 'to',
  'for', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'we', 'our', 'you',
  'your', 'he', 'she', 'they', 'i', 'not', 'no', 'do', 'does', 'did', 'can', 'will', 'would', 'should', 'there'
])

/**
 * 词元权重规则（任务要求"数字与专有名词加权"）：
 *  - 含数字（2024 / gpt-4 / qwen2）→ 1.6，数字通常是硬事实，命中价值高
 *  - 全大写（API / PDF）或首字母大写且非虚词（DeepSeek）→ 1.5，专有名词
 *  - 长词（≥8）→ 1.1，长词区分度通常更好
 */
function tokenBoost(surface: string): number {
  if (/\d/.test(surface)) return 1.6
  const isAllCaps = surface.length >= 2 && surface === surface.toUpperCase() && /^[A-Z]/.test(surface)
  const isCapitalized = /^[A-Z]/.test(surface) && !CAPITALIZED_STOPWORDS.has(surface.toLowerCase())
  if (isAllCaps || isCapitalized) return 1.5
  if (surface.length >= 8) return 1.1
  return 1
}

/**
 * 分词：中文按 2-gram（中文没有空格，2-gram 是零依赖且够稳的方案），
 * 英文/数字按词。返回带权重的词元列表（含重复，用于统计词频）。
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = []
  if (!text) return out

  // 中文（含扩展 A 区）按 2-gram 切分
  for (const run of text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
    if (run.length === 1) {
      out.push({ term: run, boost: 1 })
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) out.push({ term: run.slice(i, i + 2), boost: 1 })
  }

  // 英文/数字：保留内部连字符、下划线、加号与点号（gpt-4o、c++、node.js）
  for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_+#.-]*/g)) {
    const surface = match[0].replace(/[.\-+#]+$/, '')
    if (surface.length < 2 && !/\d/.test(surface)) continue
    out.push({ term: surface.toLowerCase(), boost: tokenBoost(surface) })
  }

  return out
}

/* ------------------------------------------------------------------ *
 * BM25 索引
 * ------------------------------------------------------------------ */

interface Bm25Index {
  chunks: Chunk[]
  n: number
  avgdl: number
  df: Map<string, number>
  /** term → (chunk 下标 → 加权词频) */
  postings: Map<string, Map<number, number>>
  /** 每块的词元总数，用于长度归一化 */
  dl: number[]
}

function buildIndex(chunks: Chunk[]): Bm25Index {
  const postings = new Map<string, Map<number, number>>()
  const dl = new Array<number>(chunks.length).fill(0)

  for (let i = 0; i < chunks.length; i++) {
    const counts = new Map<string, number>()
    let length = 0
    for (const token of tokenize(chunks[i].text)) {
      counts.set(token.term, (counts.get(token.term) ?? 0) + token.boost)
      length++
    }
    dl[i] = length || 1
    for (const [term, weightedTf] of counts) {
      let posting = postings.get(term)
      if (!posting) {
        posting = new Map<number, number>()
        postings.set(term, posting)
      }
      posting.set(i, weightedTf)
    }
  }

  const df = new Map<string, number>()
  for (const [term, posting] of postings) df.set(term, posting.size)

  const total = dl.reduce((sum, value) => sum + value, 0)
  return { chunks, n: chunks.length, avgdl: dl.length ? total / dl.length : 1, df, postings, dl }
}

const indexCache = new Map<string, { revision: number; size: number; index: Bm25Index }>()

/** 取（带缓存的）BM25 索引；分块一旦写盘 revision 变化即自动重建 */
function getIndex(kbIds: string[], pool: Chunk[]): Bm25Index {
  const key = [...kbIds].sort().join('|')
  const hit = indexCache.get(key)
  if (hit && hit.revision === chunkStore.revision && hit.size === pool.length) return hit.index

  const index = buildIndex(pool)
  indexCache.set(key, { revision: chunkStore.revision, size: pool.length, index })
  if (indexCache.size > MAX_CACHED_INDEXES) {
    const oldest = indexCache.keys().next().value
    if (oldest !== undefined) indexCache.delete(oldest)
  }
  return index
}

function toRetrieved(hit: { chunk: Chunk; score: number }): RetrievedChunk {
  return { docId: hit.chunk.docId, docName: hit.chunk.docName, text: hit.chunk.text, score: hit.score }
}

/** BM25 打分并取 top-k */
function bm25Top(pool: Chunk[], kbIds: string[], query: string, topK: number): RetrievedChunk[] {
  const index = getIndex(kbIds, pool)
  if (!index.n) return []

  const queryTokens = tokenize(query)
  if (!queryTokens.length) return []

  const scores = new Map<number, number>()
  const seen = new Set<string>()
  for (const token of queryTokens) {
    // 查询词去重：重复出现的词不该重复加分
    if (seen.has(token.term)) continue
    seen.add(token.term)

    const df = index.df.get(token.term)
    const posting = index.postings.get(token.term)
    if (!df || !posting) continue

    // BM25 的 idf，用 +0.5 平滑，避免高频词出现 0 或负数
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5))
    for (const [docIndex, weightedTf] of posting) {
      const lengthNorm = 1 - B + B * (index.dl[docIndex] / index.avgdl)
      const denominator = weightedTf + K1 * lengthNorm
      if (denominator <= 0) continue
      const contribution = token.boost * idf * ((weightedTf * (K1 + 1)) / denominator)
      scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution)
    }
  }

  if (!scores.size) return []
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([docIndex, score]) => toRetrieved({ chunk: index.chunks[docIndex], score }))
}

/* ------------------------------------------------------------------ *
 * 向量检索
 * ------------------------------------------------------------------ */

function cosineRow(data: Float32Array, rowOffset: number, query: Float32Array, dim: number): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < dim; i++) {
    const x = data[rowOffset + i]
    const y = query[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 向量检索；没有可用向量时返回空数组，由调用方回落到 BM25 */
async function vectorSearch(kbIds: string[], pool: Chunk[], query: string, topK: number): Promise<RetrievedChunk[]> {
  const blocks = new Map<string, { dim: number; rows: number; data: Float32Array }>()
  for (const kbId of kbIds) {
    const block = vectorStore.load(kbId)
    if (block) blocks.set(kbId, block)
  }

  let covered = 0
  for (const chunk of pool) {
    if (typeof chunk.vec === 'number' && blocks.has(chunk.kbId)) covered++
  }
  if (!covered) return []

  const cfg = settingsStore.get().embedding
  // 向量调用失败会抛错，由 search() 捕获后降级，这里不做静默吞错
  const [vector] = await embed({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }, [query])
  if (!vector?.length) return []
  const queryVector = Float32Array.from(vector)

  const scored: Array<{ chunk: Chunk; score: number }> = []
  for (const chunk of pool) {
    if (typeof chunk.vec !== 'number') continue
    const block = blocks.get(chunk.kbId)
    if (!block || block.dim !== queryVector.length || chunk.vec >= block.rows) continue
    scored.push({ chunk, score: cosineRow(block.data, chunk.vec * block.dim, queryVector, block.dim) })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK).map(toRetrieved)
}

/* ------------------------------------------------------------------ *
 * 对外检索
 * ------------------------------------------------------------------ */

/**
 * 知识库检索。
 *
 * 结果策略：
 *  1. 未启用向量 / 向量不可用 → 纯 BM25 关键词结果
 *  2. 启用向量且有命中 → 向量结果优先；池子里"没有向量"的分块（例如后来才配向量模型）
 *     用 BM25 结果补齐，保证这些文档不会永远检索不到
 */
export async function search(kbIds: string[], query: string, topK = 5): Promise<RetrievedChunk[]> {
  const text = typeof query === 'string' ? query.trim() : ''
  const ids = Array.isArray(kbIds) ? kbIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  if (!text || !ids.length) return []

  const requested = Number.isFinite(topK) ? Math.floor(topK) : 5
  const limit = Math.max(1, Math.min(requested, MAX_TOP_K))

  const pool = chunkStore.allFor(ids)
  if (!pool.length) return []

  // 关键词结果始终先算：它既是兜底，也是向量未覆盖分块的补充
  const keywordHits = bm25Top(pool, ids, text, limit)

  const cfg = settingsStore.get().embedding
  if (!cfg.enabled || !cfg.baseUrl) return keywordHits

  let vectorHits: RetrievedChunk[] = []
  try {
    vectorHits = await vectorSearch(ids, pool, text, limit)
  } catch (error) {
    console.warn('[knowledge] 向量检索失败，降级为关键词：', error instanceof Error ? error.message : error)
    return keywordHits
  }
  if (!vectorHits.length) return keywordHits

  const merged = [...vectorHits]
  const seen = new Set(vectorHits.map((hit) => `${hit.docId}\u0000${hit.text}`))
  for (const hit of keywordHits) {
    if (merged.length >= limit) break
    const key = `${hit.docId}\u0000${hit.text}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(hit)
  }
  return merged
}

/**
 * 实时会话注入上下文用。
 *
 * 契约：任何异常都必须返回空数组，绝不抛错——
 * 一次检索失败不能让正在进行的会议助答中断。
 */
export async function retrieveContext(kbIds: string[], query: string, topK = 4): Promise<RetrievedChunk[]> {
  try {
    return await search(kbIds, query, topK)
  } catch (error) {
    console.warn('[knowledge] retrieveContext 失败，返回空上下文：', error instanceof Error ? error.message : error)
    return []
  }
}
