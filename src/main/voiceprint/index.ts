/**
 * 声纹过滤（自用版「对话中排除自己的声音」）。
 *
 * 解决的问题：用麦克风时自己的发言也会被 ASR 认出来，AI 就去回答你自己说的话。
 * 开启声纹过滤后，先录入一段自己的声音作为模板；实时链路里每段识别结果
 * 先过一遍 isSelf()，命中自己就**不作为提问来源**（按原版语义仍可留在上下文里）。
 *
 * 本模块是纯函数层：不读文件、不写文件、不碰 electron，持久化由调用方负责。
 * 输入统一是 16kHz / 单声道 / PCM16 裸流（Buffer）。
 *
 * ## 为什么要「距离 + 个人基线校准」（重要，这里是踩过坑的地方）
 *
 * 最初直接用白化余弦当相似度，**功能完全不可用**：MFCC 统计向量在高维空间里高度同向
 * （都带着「典型语音频谱包络」这个巨大的公共分量），余弦被压缩在 0.7~1.0 的窄区间里，
 * 实测同一批合成音频：
 *   同一个人 0.958 / 明显不同的人 0.899 / 更不同的人 0.72
 * 固定阈值 0.72 于是把**所有人**都判成「自己」——每一句别人的提问都被丢掉，
 * 悬浮窗永远不出答案，比不做声纹过滤更糟。
 *
 * 两处修正：
 *
 * 1. **用白化距离而不是余弦**。余弦只看方向不看幅度，而说话人差异恰恰大量体现为
 *    「某一维差了几个 spread」。同一批音频用距离（每维按 spread 归一化后的平均平方差）：
 *      同一个人 d²≈0.7~0.9  /  明显不同的人 d²≈4~30
 *    区分度从「0.06 的余弦差」变成「4 倍以上的距离差」，阈值才有意义。
 *
 * 2. **按个人基线校准**。录入时用留一法（每段 vs 其余段组成的模板）算出这个人自己的
 *    距离分布（均值 m、标准差 s），判定时
 *      center = m + K·s          （K=2.5：同人内距离再大也大不过这么多）
 *      score  = 1 / (1 + exp((d - center) / scale)),  scale = clamp(s, 0.06, 0.25)
 *    于是 d 小于个人基线 → 接近 1，明显超出 → 接近 0，
 *    默认阈值 0.72 落在「比个人基线大 1.6 个标准差」附近，正好是合理的判定边界。
 *
 * 注意 scale 的下限 0.06 是为了防止「录入片段几乎相同 → s≈0」时分数退化成阶跃；
 * 上限 0.25 是为了防止「录入片段差异很大 → s 很大」时判定被放得过宽。
 *
 * ## 失败方向刻意选成「返回低分（= 判为他人）」
 * 把用户的话误判成自己 → 静默丢掉一个真问题，现象是「AI 不回答」，很难排查；
 * 把用户的话误判成他人 → 最多多答一次，用户立刻能看出来。
 * 所以任何不确定情况（无模板、维度不符、音频过短、静音、非有限数）一律返回 0。
 */

import { createHash } from 'node:crypto'
import {
  BLOCK_DIM,
  MIN_ANALYSIS_SECONDS,
  extractUtteranceFeatures,
  whitenedCosine,
  whitenedDistanceSq,
  type FeatureBlocks
} from './features'

export type { FeatureBlocks, FrameCepstra, UtteranceFeatures } from './features'
export {
  ALL_BLOCKS,
  BLOCK_DIM,
  CEPSTRUM_ORDER,
  MEL_LOG_RANGE_DB,
  MIN_ANALYSIS_SECONDS,
  VECTOR_DIM,
  extractFrameCepstra,
  extractUtteranceFeatures,
  whitenedCosine,
  whitenedDistanceSq,
  whitenedDot
} from './features'

/**
 * 生产用的特征块组合：**只用「绝对倒谱均值」一块**（12 维，即倒谱域的长期平均谱）。
 *
 * 这是实测选出来的，不是省事：三块（均值 12 + CMN 后标准差 12 + 一阶差分 12）都实现了，
 * 自测脚本里可以直接跑消融对照。结果（同人正常样本最大 d² / 异人最小 d²，比值越大越好）：
 * ```
 *   A  仅均值              dim=12  0.88 / 4.02  → 4.57×
 *   AB 均值+标准差          dim=24  2.00 / 2.84  → 1.42×
 *   AC 均值+差分            dim=24  超大 / 2.40  → 重叠
 *   ABC 均值+标准差+差分     dim=36  超大 / 2.16  → 重叠
 * BC 只用 CMN 后的量(无均值)  dim=24  超大 / 0.86  → 重叠
 * ```
 * 原因：标准差与一阶差分描述的是「段内起伏」，受内容与噪声影响极大，且它们和均值一起
 * 参与「每维平均」的距离时，等于把一半权重给了弱区分度、强噪声敏感的维度，
 * 既把区分度摊薄，又让音量 ×0.3 / 加噪声时距离明显漂移（破坏硬要求）。
 * 均值块则是说话人声道形状的直接体现（经典 LTAS），单独用最稳。
 */
export const PRODUCTION_BLOCKS: FeatureBlocks = { mean: true, std: false, delta: false }

export interface VoiceprintProfile {
  id: string
  name: string
  createdAt: number
  /** 特征维度 */
  dim: number
  /** 声纹模板（均值向量） */
  centroid: number[]
  /** 每个维度的标准差，用于归一化距离 */
  spread: number[]
  /** 录入用了多少段音频 */
  samples: number
  /**
   * 「同人内」白化距离基线：录入时用留一法（每段 vs 其余段的模板）算出的平均 d²。
   * 可选项：老 profile 可能没有，缺失时按 DEFAULT_INTRA_DIST_MEAN 降级，不会崩。
   */
  intraDistMean?: number
  /** 「同人内」距离基线的标准差；缺失时按 DEFAULT_INTRA_DIST_STD 降级 */
  intraDistStd?: number
}

/** 原版默认阈值 0.72（越高越严格，即越难被判成「自己」） */
export const VOICEPRINT_DEFAULT_THRESHOLD = 0.72
/** 录入至少需要的有效片段数 */
export const VOICEPRINT_MIN_ENROLL_CHUNKS = 2
/** 单个录入片段的最短时长（秒） */
export const VOICEPRINT_MIN_ENROLL_SECONDS = 1

/** spread 的绝对下限：防止某维波动为 0 时权重变成无穷大 */
const SPREAD_ABS_FLOOR = 1e-3
/**
 * spread 的相对下限（相对本块模板值的平均幅度）。
 * 录入只有 2-3 段时逐维标准差本身是噪声估计；某一维碰巧波动极小就会拿到
 * 1/spread² 的巨大权重，把测试段的数值误差放大成主成分。分块设下限可以压住它。
 */
const SPREAD_REL_FLOOR = 0.05

/** 校准：判定中心 = 同人基线均值 + K 个标准差（即「同人内距离还可以大这么多」） */
export const CALIBRATION_K = 2.5
/** 校准：尺度下限。太小会让分数退化成阶跃（录入片段几乎相同时会这样） */
export const CALIBRATION_MIN_STD = 0.06
/** 校准：尺度上限。录入片段差异很大时 sd 会被拉得很大，不设上限判定会变得过于宽松 */
export const CALIBRATION_MAX_STD = 0.25
/** 老 profile（没有 intraDist* 字段）的降级基线 */
export const DEFAULT_INTRA_DIST_MEAN = 1.3
export const DEFAULT_INTRA_DIST_STD = 0.08
/** 尺寸：特征向量维度（= 启用块数 × 12） */
export const PROFILE_DIM = activeDim(PRODUCTION_BLOCKS)

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/** 已启用块在向量里的 [start, end) 区间，用于逐块设 spread 下限 */
function blockRanges(blocks: FeatureBlocks): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = 0
  for (const enabled of [blocks.mean, blocks.std, blocks.delta]) {
    if (!enabled) continue
    out.push([start, start + BLOCK_DIM])
    start += BLOCK_DIM
  }
  return out
}

function activeDim(blocks: FeatureBlocks): number {
  return blockRanges(blocks).length * BLOCK_DIM
}

/**
 * 逐维标准差 + 分块下限。
 * 分块而不是全局：块 A（绝对倒谱）、块 B（标准差）、块 C（差分）的数值量级差一个
 * 数量级，用全局尺度做下限会把 B/C 两块的维度整体压没。
 */
function computeSpread(vectors: number[][], centroid: number[], dim: number, blocks: FeatureBlocks): number[] {
  const n = vectors.length
  const spread: number[] = new Array(dim).fill(SPREAD_ABS_FLOOR)
  for (const [start, end] of blockRanges(blocks)) {
    let scale = 0
    for (let i = start; i < end; i++) scale += Math.abs(centroid[i])
    scale /= end - start
    const floor = Math.max(SPREAD_ABS_FLOOR, SPREAD_REL_FLOOR * scale)
    for (let i = start; i < end; i++) {
      let acc = 0
      if (n >= 2) {
        for (const v of vectors) {
          const r = v[i] - centroid[i]
          acc += r * r
        }
      }
      spread[i] = Math.max(Math.sqrt(acc / Math.max(1, n - 1)), floor)
    }
  }
  return spread
}

/**
 * 确定性 id：由「名字 + 模板向量」哈希得到，不含时间戳与随机数。
 * 同样输入两次 enroll 得到同一个 id（便于去重与自测复现），也让本模块不依赖熵源。
 */
function profileId(name: string, centroid: number[]): string {
  const material = `${name}|${centroid.map(round4).join(',')}`
  return `vp_${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
}

/**
 * 录入：把若干段 PCM 合成一个声纹模板。
 *
 * 第三个参数 blocks 只给自测做特征块消融用，生产调用只传前两个参数
 * （默认就是 PRODUCTION_BLOCKS）。加可选参数不影响冻结的调用签名。
 *
 * 抛错的情况（只有录入路径会抛，实时判定路径永远不抛）：
 *  - pcmChunks 为空；
 *  - 有效片段（≥1 秒且含足够语音）少于 2 段——1 段算不出「段间波动」，
 *    白化与个人分数基线都没有依据，硬做出来的模板在同人测试上会虚高。
 */
export function enroll(name: string, pcmChunks: Buffer[], blocks: FeatureBlocks = PRODUCTION_BLOCKS): VoiceprintProfile {
  if (!Array.isArray(pcmChunks) || pcmChunks.length === 0) {
    throw new Error(
      `声纹录入失败：没有提供音频（至少需要 ${VOICEPRINT_MIN_ENROLL_CHUNKS} 段、每段 ${VOICEPRINT_MIN_ENROLL_SECONDS} 秒以上的清晰人声）`
    )
  }

  const dim = activeDim(blocks)
  const vectors: number[][] = []
  let tooShort = 0
  let noSpeech = 0
  for (const chunk of pcmChunks) {
    if (!chunk || chunk.length < VOICEPRINT_MIN_ENROLL_SECONDS * 16000 * 2) {
      tooShort++
      continue
    }
    const features = extractUtteranceFeatures(chunk, blocks)
    if (!features) {
      noSpeech++
      continue
    }
    vectors.push(features.vector)
  }

  if (vectors.length < VOICEPRINT_MIN_ENROLL_CHUNKS) {
    const skipped: string[] = []
    if (tooShort) skipped.push(`${tooShort} 段短于 ${VOICEPRINT_MIN_ENROLL_SECONDS} 秒`)
    if (noSpeech) skipped.push(`${noSpeech} 段没检测到语音`)
    throw new Error(
      `声纹录入失败：有效片段只有 ${vectors.length} 段（共 ${pcmChunks.length} 段${skipped.length ? `，其中 ${skipped.join('、')}` : ''}），` +
        `至少需要 ${VOICEPRINT_MIN_ENROLL_CHUNKS} 段、每段 ${VOICEPRINT_MIN_ENROLL_SECONDS} 秒以上的清晰人声`
    )
  }

  const centroid: number[] = new Array(dim).fill(0)
  for (const v of vectors) {
    for (let d = 0; d < dim; d++) centroid[d] += v[d]
  }
  for (let d = 0; d < dim; d++) centroid[d] /= vectors.length

  const spread = computeSpread(vectors, centroid, dim, blocks)

  // 同人基线：留一法（每段 vs 「其余段组成的模板」）的白化距离。
  // 用留一而不是「片段 vs 全体均值」：留一的几何和判定时完全一致（一段音频 vs 一个模板），
  // 而且它天然把「内容/环境在录入里本来就有的波动」算进基线，不需要任何全局语料。
  const looDistances: number[] = []
  if (vectors.length >= 2) {
    for (let i = 0; i < vectors.length; i++) {
      const others: number[] = new Array(dim).fill(0)
      for (let j = 0; j < vectors.length; j++) {
        if (j === i) continue
        for (let d = 0; d < dim; d++) others[d] += vectors[j][d] / (vectors.length - 1)
      }
      const dist = whitenedDistanceSq(others, spread, vectors[i])
      if (Number.isFinite(dist)) looDistances.push(dist)
    }
  }
  let intraDistMean = DEFAULT_INTRA_DIST_MEAN
  let intraDistStd = DEFAULT_INTRA_DIST_STD
  if (looDistances.length > 0) {
    intraDistMean = looDistances.reduce((a, b) => a + b, 0) / looDistances.length
    if (looDistances.length >= 2) {
      let acc = 0
      for (const c of looDistances) acc += (c - intraDistMean) * (c - intraDistMean)
      intraDistStd = Math.sqrt(acc / (looDistances.length - 1))
    } else {
      // 只有 1 个留一值（录入 2 段）时算不出标准差，交给 CALIBRATION_MIN_STD 兜底
      intraDistStd = 0
    }
    // 留一法用的参考模板只有 n-1 段，比判定时用的模板（n 段）更"吵"，距离天然偏大。
    // 按参考模板方差比归一化掉这个偏置：((1+1/(n-1)) / (1+1/n))（n=2 时约 1.33）。
    // 不做这一步的话，只录 2 段时基线会偏高约 1.5 倍、判定明显偏宽松——
    // 偏宽松正是「把别人误判成自己」的危险方向，必须收紧。
    const referenceBias = (1 + 1 / (vectors.length - 1)) / (1 + 1 / vectors.length)
    intraDistMean /= referenceBias
    intraDistStd /= referenceBias
  }

  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : '未命名'
  return {
    id: profileId(trimmedName, centroid),
    name: trimmedName,
    createdAt: Date.now(),
    dim,
    centroid,
    spread,
    samples: vectors.length,
    intraDistMean,
    intraDistStd
  }
}

/** 该音频相对模板的原始白化距离 d²（未校准）。诊断/自测/调参用，业务判定不要直接用。 */
export function rawDistance(profile: VoiceprintProfile, pcm: Buffer, blocks: FeatureBlocks = PRODUCTION_BLOCKS): number {
  if (!isUsable(profile, blocks)) return Number.NaN
  const features = extractUtteranceFeatures(pcm, blocks)
  if (!features) return Number.NaN
  return whitenedDistanceSq(profile.centroid, profile.spread, features.vector)
}

/** 该音频相对模板的原始白化余弦（未校准）。仅作诊断参考：它被公共分量压缩，区分度远不如距离。 */
export function rawCosine(profile: VoiceprintProfile, pcm: Buffer, blocks: FeatureBlocks = PRODUCTION_BLOCKS): number {
  if (!isUsable(profile, blocks)) return 0
  const features = extractUtteranceFeatures(pcm, blocks)
  if (!features) return 0
  return whitenedCosine(profile.centroid, profile.spread, features.vector)
}

/** 模板是否可用（维度、数组长度、音频长度都检查一遍；任何不符都返回 false） */
function isUsable(profile: VoiceprintProfile | null | undefined, blocks: FeatureBlocks = PRODUCTION_BLOCKS): profile is VoiceprintProfile {
  if (!profile) return false
  if (!Number.isFinite(profile.dim) || profile.dim !== activeDim(blocks)) return false
  if (!Array.isArray(profile.centroid) || !Array.isArray(profile.spread)) return false
  if (profile.centroid.length !== profile.dim || profile.spread.length !== profile.dim) return false
  return true
}

/**
 * 判定某段音频是否属于该声纹，返回 0-1 相似度（已按个人基线校准）。
 * 无模板 / 无有效语音 / 音频过短时返回 0，任何情况都不抛异常。
 */
export function similarity(profile: VoiceprintProfile, pcm: Buffer, blocks: FeatureBlocks = PRODUCTION_BLOCKS): number {
  // 类型上 profile 非空，但调用方来自 IPC/持久化，可能出现 null/半残对象；这里防御性处理
  if (!isUsable(profile, blocks)) return 0
  if (!pcm || pcm.length < MIN_ANALYSIS_SECONDS * 16000 * 2) return 0

  const features = extractUtteranceFeatures(pcm, blocks)
  if (!features) return 0
  const distance = whitenedDistanceSq(profile.centroid, profile.spread, features.vector)
  if (!Number.isFinite(distance)) return 0

  // 个人基线：老 profile 没有 intraDist* 字段时降级到保守常量
  const baselineMean = Number.isFinite(profile.intraDistMean) ? Math.max(profile.intraDistMean as number, 0) : DEFAULT_INTRA_DIST_MEAN
  const measuredStd = Number.isFinite(profile.intraDistStd) ? Math.max(profile.intraDistStd as number, 0) : DEFAULT_INTRA_DIST_STD
  const scale = clamp(measuredStd, CALIBRATION_MIN_STD, CALIBRATION_MAX_STD)
  const center = baselineMean + CALIBRATION_K * scale
  // 距离越大越不像本人 → 用 (center - d) 的 sigmoid 映射到 0-1
  const score = 1 / (1 + Math.exp((distance - center) / scale))
  return clamp(score, 0, 1)
}

/**
 * 便捷判定。
 * 注意 `score > 0` 这个条件：相似度为 0 意味着「没有可比证据」（静音、过短、维度不符），
 * 即使调用方把阈值设成 0，也不该把静音判成自己——否则一场会议的问题会被整段丢掉。
 */
export function isSelf(profile: VoiceprintProfile | null, pcm: Buffer, threshold: number): boolean {
  if (!profile) return false
  const t = Number.isFinite(threshold) ? clamp(threshold, 0, 1) : VOICEPRINT_DEFAULT_THRESHOLD
  const score = similarity(profile, pcm)
  return score > 0 && score >= t
}
