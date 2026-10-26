import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 轻量本地持久化：JSON 文件 + 原子写入。
 *
 * 之所以不用 electron-store / sqlite：数据量是个人级（几千条记录、几千个文本块），
 * JSON 足够，且零原生依赖、零迁移成本、方便直接查看和备份。
 */

export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function dataFile(name: string): string {
  return join(dataDir(), name)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch (error) {
    // 损坏的文件不致命：备份后回退默认值，避免整个应用起不来
    console.error(`[store] 读取失败 ${file}`, error)
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 忽略 */
    }
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 通用集合：整体读入内存、写回整文件 */
export class JsonCollection<T extends { id: string }> {
  private items: T[] = []
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly fallback: T[] = []
  ) {}

  private ensure(): void {
    if (this.loaded) return
    this.items = readJson<T[]>(this.file, this.fallback)
    this.loaded = true
  }

  all(): T[] {
    this.ensure()
    return this.items
  }

  get(id: string): T | null {
    this.ensure()
    return this.items.find((i) => i.id === id) ?? null
  }

  upsert(item: T): T {
    this.ensure()
    const index = this.items.findIndex((i) => i.id === item.id)
    if (index >= 0) this.items[index] = item
    else this.items.unshift(item)
    this.flush()
    return item
  }

  patch(id: string, patch: Partial<T>): T | null {
    this.ensure()
    const index = this.items.findIndex((i) => i.id === id)
    if (index < 0) return null
    this.items[index] = { ...this.items[index], ...patch }
    this.flush()
    return this.items[index]
  }

  remove(id: string): void {
    this.ensure()
    this.items = this.items.filter((i) => i.id !== id)
    this.flush()
  }

  replaceAll(items: T[]): void {
    this.items = items
    this.loaded = true
    this.flush()
  }

  flush(): void {
    writeJson(this.file, this.items)
  }
}
