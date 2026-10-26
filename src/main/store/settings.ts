import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dataFile, readJson, writeJson } from './store'
import { createDefaultSettings, mergeSettings, SETTINGS_VERSION } from '@shared/defaults'
import type { Settings } from '@shared/types'

/**
 * 设置存储：单文件 JSON，进程内单例，变更广播给所有窗口。
 */

const FILE = () => dataFile('settings.json')

class SettingsStore extends EventEmitter {
  private cached: Settings | null = null

  get(): Settings {
    if (!this.cached) {
      const file = FILE()
      const existed = existsSync(file)
      const raw = readJson<Partial<Settings>>(file, {})
      const defaults = createDefaultSettings()
      const merged = mergeSettings(defaults, raw)
      // 版本升级钩子：将来字段迁移写在这里
      if (merged.version !== SETTINGS_VERSION) merged.version = SETTINGS_VERSION
      this.cached = merged
      // 首次启动就把默认值落盘，便于用户直接查看/手工编辑配置文件
      if (!existed) writeJson(file, merged)
    }
    return this.cached
  }

  patch(patch: unknown): Settings {
    const next = mergeSettings(this.get(), patch)
    this.cached = next
    writeJson(FILE(), next)
    this.emit('changed', next)
    return next
  }

  /**
   * 定向更新某个网关的若干字段。
   *
   * 关键点：合并发生在主进程，基于「当前已保存的值」而不是渲染层的快照，
   * 因此连续快速输入不会互相覆盖（整份数组回写就会有这个问题）。
   */
  patchProvider(id: string, patch: Partial<Settings['providers'][number]>): Settings {
    const current = this.get()
    const index = current.providers.findIndex((p) => p.id === id)
    if (index < 0) return current

    const providers = [...current.providers]
    providers[index] = { ...providers[index], ...patch }
    // 用空值删除语义：显式传 undefined 表示「清空该项」（例如 temperature 允许留空）
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (providers[index] as unknown as Record<string, unknown>)[key]
    }

    const next: Settings = { ...current, providers }
    this.cached = next
    writeJson(FILE(), next)
    this.emit('changed', next)
    return next
  }

  replace(next: Settings): Settings {
    this.cached = next
    writeJson(FILE(), next)
    this.emit('changed', next)
    return next
  }

  reset(): Settings {
    return this.replace(createDefaultSettings())
  }
}

export const settingsStore = new SettingsStore()

/** 取当前生效的 provider */
export function activeProvider() {
  const s = settingsStore.get()
  return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0]
}
