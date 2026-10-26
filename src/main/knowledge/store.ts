import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JsonCollection, dataFile, readJson } from '../store/store'
import type { KnowledgeBase, KnowledgeDocument } from '@shared/types'

/**
 * 知识库持久化。
 *
 * 文件布局（都在 userData/data 下）：
 *   kb.json                 知识库列表
 *   kb-documents.json       文档元数据
 *   kb-chunks/<kbId>.json   某个知识库的全部分块（纯文本，便于直接查看/备份）
 *   kb-vectors/<kbId>.bin   某个知识库的向量（uint32 头 + Float32 数据）
 *
 * 为什么按知识库分片 + 向量走二进制：
 *  - 分片后一次导入只需要写一个分块文件一次。若沿用"每写一块就整体重写整个集合"的做法，
 *    一个 20MB 文档约 3 万块，等于 3 万次全量写盘，是 O(n²) 的磁盘开销。
 *  - 向量若按 JSON 存，1536 维 × 3 万块会产生几百 MB 文本；二进制是 4 字节/维，
 *    并且落盘只需要一次 writeFileSync。
 */

export interface Chunk {
  id: string
  kbId: string
  docId: string
  docName: string
  text: string
  /** 向量在 kb-vectors/<kbId>.bin 中的行号；未向量化时为 undefined */
  vec?: number
}

/** 向量文件头：两个 uint32（维度、行数），其后是行优先的 Float32 数据 */
const VEC_HEADER_BYTES = 8

/** kbId 由 randomUUID 生成，这里只是防御性处理，避免路径穿越 */
function safeName(kbId: string): string {
  return kbId.replace(/[^A-Za-z0-9_-]/g, '_')
}

function chunkFile(kbId: string): string {
  return dataFile(join('kb-chunks', `${safeName(kbId)}.json`))
}

function vectorFile(kbId: string): string {
  return dataFile(join('kb-vectors', `${safeName(kbId)}.bin`))
}

/** 原子写：先写临时文件再 rename，避免崩溃时留下半截文件 */
function writeAtomic(file: string, data: Buffer | string): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/* ------------------------------------------------------------------ *
 * 分块存储
 * ------------------------------------------------------------------ */

class ChunkStore {
  /** 进程内缓存，避免每次检索都重新读盘 */
  private cache = new Map<string, Chunk[]>()
  /** 每次写盘自增，供检索索引缓存判断失效 */
  private version = 0

  get revision(): number {
    return this.version
  }

  private load(kbId: string): Chunk[] {
    const cached = this.cache.get(kbId)
    if (cached) return cached
    const items = readJson<Chunk[]>(chunkFile(kbId), [])
    const safe = Array.isArray(items) ? items : []
    this.cache.set(kbId, safe)
    return safe
  }

  private save(kbId: string, items: Chunk[]): void {
    this.cache.set(kbId, items)
    this.version++
    writeAtomic(chunkFile(kbId), JSON.stringify(items))
  }

  /** 检索热路径：只加载被检索到的知识库 */
  allFor(kbIds: string[]): Chunk[] {
    const out: Chunk[] = []
    for (const id of kbIds) {
      if (!id) continue
      for (const chunk of this.load(id)) out.push(chunk)
    }
    return out
  }

  countFor(kbId: string): number {
    return this.load(kbId).length
  }

  /** 批量追加：整篇文档只写盘一次 */
  appendMany(kbId: string, items: Chunk[]): void {
    if (!items.length) return
    this.save(kbId, this.load(kbId).concat(items))
  }

  /** 整体替换（删除文档后重建行号时使用） */
  overwrite(kbId: string, items: Chunk[]): void {
    this.save(kbId, items)
  }

  /** 删除某文档的全部分块，返回剩余分块 */
  removeByDoc(kbId: string, docId: string): Chunk[] {
    const rest = this.load(kbId).filter((c) => c.docId !== docId)
    this.save(kbId, rest)
    return rest
  }

  removeKb(kbId: string): void {
    this.cache.delete(kbId)
    this.version++
    rmSync(chunkFile(kbId), { force: true })
  }

  /** 全量分块（仅供兼容/统计，不在检索热路径上） */
  all(): Chunk[] {
    const dir = dirname(chunkFile('placeholder'))
    if (!existsSync(dir)) return []
    const out: Chunk[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const items = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Chunk[]
        if (Array.isArray(items)) out.push(...items)
      } catch {
        // 单个分片损坏不影响其它知识库
      }
    }
    return out
  }
}

/* ------------------------------------------------------------------ *
 * 向量存储
 * ------------------------------------------------------------------ */

interface VectorBlock {
  dim: number
  rows: number
  data: Float32Array
}

class VectorStore {
  private cache = new Map<string, VectorBlock | null>()

  /** 编码为「uint32 头 + 行优先 Float32」的 Buffer */
  private encode(vectors: number[][], dim: number): Buffer {
    const rows = vectors.length
    const payload = Buffer.allocUnsafe(rows * dim * 4)
    let offset = 0
    for (const row of vectors) {
      const floats = new Float32Array(dim)
      for (let i = 0; i < dim; i++) floats[i] = row[i] ?? 0
      payload.set(Buffer.from(floats.buffer, 0, dim * 4), offset)
      offset += dim * 4
    }
    return Buffer.concat([this.header(dim, rows), payload])
  }

  private header(dim: number, rows: number): Buffer {
    const head = Buffer.allocUnsafe(VEC_HEADER_BYTES)
    head.writeUInt32LE(dim, 0)
    head.writeUInt32LE(rows, 4)
    return head
  }

  /**
   * 追加若干行向量，返回起始行号。
   *
   * 若已有向量的维度不同（例如用户换了向量模型），旧向量无法与新向量共存，
   * 此时整体作废并从第 0 行重写，reset=true 提醒调用方清掉分块上的旧行号。
   */
  appendRows(kbId: string, vectors: number[][]): { startRow: number; reset: boolean } {
    const dim = vectors[0]?.length ?? 0
    if (!dim || !vectors.length) return { startRow: 0, reset: false }

    const previous = this.load(kbId)
    if (!previous) {
      writeAtomic(vectorFile(kbId), this.encode(vectors, dim))
      this.cache.delete(kbId)
      return { startRow: 0, reset: false }
    }
    if (previous.dim !== dim) {
      writeAtomic(vectorFile(kbId), this.encode(vectors, dim))
      this.cache.delete(kbId)
      return { startRow: 0, reset: true }
    }

    // 维度一致：保留旧行，后面追加新行
    const startRow = previous.rows
    const oldPayload = Buffer.from(previous.data.buffer, previous.data.byteOffset, previous.data.byteLength)
    const newPayload = this.encode(vectors, dim).subarray(VEC_HEADER_BYTES)
    writeAtomic(vectorFile(kbId), Buffer.concat([this.header(dim, startRow + vectors.length), oldPayload, newPayload]))
    this.cache.delete(kbId)
    return { startRow, reset: false }
  }

  /** 整体重写（删除文档后重整行号） */
  save(kbId: string, vectors: number[][]): number {
    const dim = vectors[0]?.length ?? 0
    if (!dim || !vectors.length) {
      this.removeKb(kbId)
      return 0
    }
    writeAtomic(vectorFile(kbId), this.encode(vectors, dim))
    this.cache.delete(kbId)
    return vectors.length
  }

  /** 读向量；文件缺失/损坏/长度不符时返回 null（调用方自动降级为关键词检索） */
  load(kbId: string): VectorBlock | null {
    const hit = this.cache.get(kbId)
    if (hit !== undefined) return hit
    const block = this.readFromDisk(kbId)
    this.cache.set(kbId, block)
    return block
  }

  private readFromDisk(kbId: string): VectorBlock | null {
    try {
      const file = vectorFile(kbId)
      if (!existsSync(file)) return null
      const buf = readFileSync(file)
      if (buf.length < VEC_HEADER_BYTES) return null
      const dim = buf.readUInt32LE(0)
      const rows = buf.readUInt32LE(4)
      if (!dim || !rows) return null
      const expected = VEC_HEADER_BYTES + rows * dim * 4
      if (buf.length !== expected) {
        console.warn(`[knowledge] 向量文件长度异常，按无向量处理：${file}`)
        return null
      }
      // 复制到独立 ArrayBuffer：Buffer 来自内存池，byteOffset 可能不满足 Float32 对齐
      const ab = new ArrayBuffer(rows * dim * 4)
      Buffer.from(ab).set(buf.subarray(VEC_HEADER_BYTES, expected))
      return { dim, rows, data: new Float32Array(ab) }
    } catch (error) {
      console.warn('[knowledge] 读取向量失败，按无向量处理：', error instanceof Error ? error.message : error)
      return null
    }
  }

  removeKb(kbId: string): void {
    this.cache.delete(kbId)
    rmSync(vectorFile(kbId), { force: true })
  }

  pathOf(kbId: string): string {
    return vectorFile(kbId)
  }
}

export const kbs = new JsonCollection<KnowledgeBase>(dataFile('kb.json'))
export const docs = new JsonCollection<KnowledgeDocument>(dataFile('kb-documents.json'))
export const chunkStore = new ChunkStore()
export const vectorStore = new VectorStore()

/** 供 IPC 层与自测使用的聚合入口 */
export const knowledgeStore = { kbs, docs, chunks: chunkStore, vectors: vectorStore }
