import { dataFile, readJson, writeJson } from '../store/store'
import type { VoiceprintProfile } from './index'

/**
 * 声纹模板的本地持久化。
 *
 * 只存一份模板（当前使用者自己的声纹），因为这是单人自用工具；
 * 将来要多人的话把这里换成集合即可。
 */

const FILE = () => dataFile('voiceprint.json')

let cached: VoiceprintProfile | null | undefined

export function loadProfile(): VoiceprintProfile | null {
  if (cached !== undefined) return cached
  const raw = readJson<VoiceprintProfile | null>(FILE(), null)
  // 基本形状校验：损坏或旧格式一律丢弃，避免实时链路里拿到脏数据炸掉
  cached = raw && Array.isArray(raw.centroid) && raw.centroid.length > 0 ? raw : null
  return cached
}

export function saveProfile(profile: VoiceprintProfile | null): void {
  cached = profile
  writeJson(FILE(), profile)
}
