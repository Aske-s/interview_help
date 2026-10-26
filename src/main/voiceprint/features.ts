/**
 * 声纹过滤：从一段音频里提取定长声纹特征向量，以及向量之间的相似度。
 *
 * 特征提取流水线（16k 单声道 PCM16）：
 *   预加重 → 分帧(25ms/10ms) → 汉明窗 → FFT 功率谱 → Mel 滤波器组(26) → 取对数
 *   → DCT 取 13 个倒谱系数 → **丢掉 C0** → 得到每帧的 12 维 MFCC
 *   → 按帧能量做**平滑加权** → 聚合成定长向量
 *
 * 三个关键设计决定，都有自测里的实测数值支撑：
 *
 * 1. **丢掉 C0 = 天然的「对音量不敏感」**。
 *    整体增益 a 在功率谱上是乘性：a²·|X|²；取对数后变成加性：2·ln a + ln|X|²，
 *    在 Mel 频带上等于所有频带加同一个常数，而 DCT 里的常数分量只进 C0。
 *    所以丢掉 C0 后，同一段话小声说和大声说得到的 MFCC 完全相同（只差浮点误差）。
 *
 * 2. **用平滑能量权重代替硬 VAD 门限**。
 *    硬门限的致命问题是「不连续」：帧能量在门限附近抖动就会整帧进/出统计，
 *    音量变化 10dB 就能让一批帧翻面，均值/标准差随之跳变（实测音量 ×0.3 时
 *    相似度从 0.98 掉到 0.85）。改成权重 w = clamp((相对峰值dB + 30)/30)² 之后，
 *    权只依赖「帧能量 / 峰值」这个比值，整体增益变化时所有权重严格不变，
 *    静音帧权重平滑趋近 0：既不误纳底噪帧，也不会让帧集合翻面。
 *
 * 3. **CMN 只用在「动态」块上，不用在均值块上**。
 *    教科书式做法是每帧减整段均值（CMN）抵消信道差异。但说话人的绝对声道形状
 *    （共振峰位置）主要就体现在这段均值里，3-8 秒片段内 phoneme 有限、内容未必相同，
 *    减掉均值等于把最强的说话人线索一起减掉（自测里有 CMN-ALL 对照段的实测数值）。
 *    因此只用 CMN 后的残差做标准差/差分——它们本来就是零均值量，CMN 只帮它去掉
 *    信道带来的直流偏置。
 *
 * 特征向量分三块，每块 12 维（本文件三块都实现了，自测里做消融对照）：
 *   A. 绝对倒谱均值  mean(C1..C12)        —— 声道形状，最强线索（同麦克风自用场景）
 *   B. CMN 后倒谱标准差 std(C1..C12)      —— 发声/内容起伏，已抵消信道直流
 *   C. CMN 后一阶差分均值 mean|ΔC1..ΔC12| —— 动态特性，已抵消信道直流
 *
 * **生产配置只用 A 块**（见 index.ts 的 PRODUCTION_BLOCKS 与自测里的消融表）：
 * B/C 描述的是「段内起伏」，受内容与噪声影响极大，和 A 一起做「每维平均距离」时
 * 会把一半权重让给弱区分度、强噪声敏感的维度，既摊薄区分度又破坏音量不敏感这条硬要求。
 */

import {
  FFT_SIZE,
  FRAME_HOP,
  FRAME_LEN,
  HAMMING_WINDOW,
  MEL_BANDS,
  SAMPLE_RATE,
  decodePcm16,
  dctII,
  logMelEnergies,
  melEnergies,
  powerSpectrum,
  preemphasis
} from './dsp'

/** 保留 C1..C12（丢 C0），12 维 */
export const CEPSTRUM_ORDER = 12
/** 每块的维度 = CEPSTRUM_ORDER */
export const BLOCK_DIM = CEPSTRUM_ORDER
/** 三块合计维度 */
export const VECTOR_DIM = BLOCK_DIM * 3

/** 有效帧数（权重和）下限：8 帧 ≈ 80ms，再少没有统计意义 */
export const MIN_SPEECH_FRAMES = 8
/** 可分析音频的最短时长（秒）：低于它直接返回「无有效特征」，不抛异常 */
export const MIN_ANALYSIS_SECONDS = 0.4
/** 整段峰值低于这个 dBFS 就当静音 */
export const SILENCE_PEAK_DB = -70

/**
 * 倒谱用到的 log-mel 动态范围（dB，相对本帧峰值）。
 *
 * 为什么不是更常见的 45dB：帧内高频带能量往往比峰值低 40dB 以上，
 * 那里几乎只剩 PCM16 量化噪声（绝对量级不随音量缩放）。
 * 动态范围取得太大，这些频带就落在「真实值/地板值」交界，小声说话时整段倒谱会漂移
 * （实测 45dB 下音量 ×0.3 相似度从 0.98 掉到 0.85）。30dB 足以覆盖区分说话人
 * 最关键的 F1-F3，又能把量化噪声压到地板以下。
 */
export const MEL_LOG_RANGE_DB = 30

/** 能量权重的动态范围：比峰值低 30dB 的帧权重为 0 */
export const VAD_WEIGHT_SPAN_DB = 30
/** 估计噪声底用的低分位（对每个 Mel 频带单独取） */
export const NOISE_FLOOR_PERCENTILE = 0.1
/** 谱减系数：减去噪声底估计的多少倍 */
export const SPECTRAL_SUBTRACTION_ALPHA = 1
/** 谱减后的残留比例下限：避免过度相减把频带压成 0（那会引入新的不连续） */
export const SPECTRAL_RESIDUAL_RATIO = 0.1

/** 逐带估计稳态噪声底：对每个 Mel 频带取所有帧能量的低分位 */
function estimateNoiseFloorPerBand(mels: Float64Array[]): Float64Array {
  const floor = new Float64Array(MEL_BANDS)
  if (mels.length === 0) return floor
  const column: number[] = new Array(mels.length)
  for (let m = 0; m < MEL_BANDS; m++) {
    for (let f = 0; f < mels.length; f++) column[f] = mels[f][m]
    column.sort((a, b) => a - b)
    const idx = Math.min(column.length - 1, Math.max(0, Math.round((column.length - 1) * NOISE_FLOOR_PERCENTILE)))
    floor[m] = column[idx]
  }
  return floor
}

/** 谱减：E' = max(E - α·N, β·E)，结果恒 ≥ 0 且保持与输入同比缩放 */
function subtractFloor(mel: Float64Array, floor: Float64Array): Float64Array {
  const out = new Float64Array(mel.length)
  for (let m = 0; m < mel.length; m++) {
    const residual = mel[m] - SPECTRAL_SUBTRACTION_ALPHA * floor[m]
    const lowerBound = SPECTRAL_RESIDUAL_RATIO * mel[m]
    out[m] = residual > lowerBound ? residual : lowerBound
  }
  return out
}

export interface FrameCepstra {
  /** 只含权重 > 0 的帧，每帧 12 维 MFCC（C1..C12） */
  frames: number[][]
  /** 与 frames 一一对应的能量权重（0..1） */
  weights: number[]
  /** 各帧在原帧序列里的下标；一阶差分只有真正相邻的两帧才算 */
  indices: number[]
  totalFrames: number
  /** 有效帧数 = 权重之和 */
  effectiveFrames: number
}

export interface FeatureBlocks {
  /** 块 A：绝对倒谱均值 */
  mean: boolean
  /** 块 B：CMN 后标准差 */
  std: boolean
  /** 块 C：CMN 后一阶差分均值 */
  delta: boolean
}

export const ALL_BLOCKS: FeatureBlocks = { mean: true, std: true, delta: true }

export interface UtteranceFeatures {
  vector: number[]
  /** 有效帧数（权重和） */
  effectiveFrames: number
  totalFrames: number
}

/**
 * 提取逐帧 MFCC 与能量权重。
 * 音频过短 / 全静音 / 有效帧不足时返回 null——**绝不抛异常**，
 * 因为调用方在实时会议链路里，抛异常会直接中断助答。
 */
export function extractFrameCepstra(pcm: Buffer): FrameCepstra | null {
  if (!pcm || pcm.length < FRAME_LEN * 2) return null
  const samples = decodePcm16(pcm)
  if (samples.length < MIN_ANALYSIS_SECONDS * SAMPLE_RATE) return null

  const signal = preemphasis(samples)
  const totalFrames = Math.max(0, Math.floor((signal.length - FRAME_LEN) / FRAME_HOP) + 1)
  if (totalFrames <= 0) return null

  const frameWindow = new Float64Array(FRAME_LEN)
  const mels: Float64Array[] = []
  const dbValues: number[] = []
  for (let f = 0; f < totalFrames; f++) {
    const offset = f * FRAME_HOP
    for (let i = 0; i < FRAME_LEN; i++) frameWindow[i] = signal[offset + i] * HAMMING_WINDOW[i]
    const power = powerSpectrum(frameWindow)
    mels.push(melEnergies(power))
    // 每采样平均功率的 dBFS
    let sum = 0
    for (let i = 0; i < power.length; i++) sum += power[i]
    dbValues.push(10 * Math.log10(sum / FFT_SIZE + 1e-30))
  }

  let peakDb = -Infinity
  for (const db of dbValues) if (db > peakDb) peakDb = db
  if (!Number.isFinite(peakDb) || peakDb < SILENCE_PEAK_DB) return null

  // 谱减：用「各频带的最低能量分位」估计这段音频的稳态噪声底，逐带减掉。
  // 这一步对会议室/风扇底噪很关键——不做谱减时，底噪会把倒谱谷填平、
  // 让 C1 之类的倾斜系数明显漂移（自测的噪声用例会打印减与不减的差别）。
  // 减完仍然只影响数值大小、不影响「整体增益 → 常数偏移」这条性质，
  // 因此音量不敏感不受影响。
  const noiseFloor = estimateNoiseFloorPerBand(mels)

  // 平滑能量权重：只依赖「本帧 dB - 峰值 dB」，因此对整体增益严格不变
  const frames: number[][] = []
  const weights: number[] = []
  const indices: number[] = []
  let effectiveFrames = 0
  for (let f = 0; f < totalFrames; f++) {
    const relDb = dbValues[f] - peakDb
    const raw = (relDb + VAD_WEIGHT_SPAN_DB) / VAD_WEIGHT_SPAN_DB
    const w = raw <= 0 ? 0 : raw >= 1 ? 1 : raw * raw
    if (w <= 1e-6) continue
    const logMel = logMelEnergies(subtractFloor(mels[f], noiseFloor), MEL_LOG_RANGE_DB)
    const cepstrum = dctII(logMel, CEPSTRUM_ORDER + 1)
    const frame: number[] = new Array(CEPSTRUM_ORDER)
    for (let k = 1; k <= CEPSTRUM_ORDER; k++) frame[k - 1] = cepstrum[k] // 丢掉 C0
    frames.push(frame)
    weights.push(w)
    indices.push(f)
    effectiveFrames += w
  }

  if (effectiveFrames < MIN_SPEECH_FRAMES) return null
  return { frames, weights, indices, totalFrames, effectiveFrames }
}

/**
 * 把逐帧倒谱加权聚合成定长向量。
 * @param blocks 启用哪些块（自测里用它做消融对照）
 */
export function buildFeatureVector(framed: FrameCepstra, blocks: FeatureBlocks = ALL_BLOCKS): number[] {
  const { frames, weights, indices } = framed
  const dim = CEPSTRUM_ORDER
  let totalWeight = 0
  for (const w of weights) totalWeight += w
  if (frames.length === 0 || totalWeight <= 0) return new Array(VECTOR_DIM).fill(0)

  // 加权均值：块 A 直接用；块 B/C 用减掉它之后的残差
  const mean = new Float64Array(dim)
  for (let f = 0; f < frames.length; f++) {
    const w = weights[f]
    for (let d = 0; d < dim; d++) mean[d] += frames[f][d] * w
  }
  for (let d = 0; d < dim; d++) mean[d] /= totalWeight

  const out: number[] = []
  if (blocks.mean) {
    for (let d = 0; d < dim; d++) out.push(mean[d])
  }

  if (blocks.std) {
    const acc = new Float64Array(dim)
    for (let f = 0; f < frames.length; f++) {
      const w = weights[f]
      for (let d = 0; d < dim; d++) {
        const r = frames[f][d] - mean[d]
        acc[d] += w * r * r
      }
    }
    // 残差均值为 0，所以这里标准差 == 加权 RMS
    for (let d = 0; d < dim; d++) out.push(Math.sqrt(acc[d] / totalWeight))
  }

  if (blocks.delta) {
    const acc = new Float64Array(dim)
    let deltaWeight = 0
    for (let f = 1; f < frames.length; f++) {
      // 只有原帧序列里真正相邻的两帧才构成一个差分样本（不跨过被丢弃的静音段）
      if (indices[f] !== indices[f - 1] + 1) continue
      const w = Math.min(weights[f], weights[f - 1])
      for (let d = 0; d < dim; d++) acc[d] += w * Math.abs(frames[f][d] - frames[f - 1][d])
      deltaWeight += w
    }
    for (let d = 0; d < dim; d++) out.push(deltaWeight > 0 ? acc[d] / deltaWeight : 0)
  }

  return out
}

/** 一步到位：PCM → 特征向量（含能量加权）。无有效语音时返回 null */
export function extractUtteranceFeatures(pcm: Buffer, blocks: FeatureBlocks = ALL_BLOCKS): UtteranceFeatures | null {
  const framed = extractFrameCepstra(pcm)
  if (!framed) return null
  return {
    vector: buildFeatureVector(framed, blocks),
    effectiveFrames: framed.effectiveFrames,
    totalFrames: framed.totalFrames
  }
}

/* ------------------------------------------------------------------ *
 * 相似度
 * ------------------------------------------------------------------ */

/**
 * 白化内积：sum(a_i·b_i / spread_i²)。对称，用来算「白化空间里的余弦」。
 * 白化权重取 1/spread²：spread 是**同一个人各段之间**的逐维波动，
 * 某维波动小 == 这个人在这维上稳定 == 更能代表他，于是给更大权重。
 */
export function whitenedDot(a: readonly number[], spread: readonly number[], b: readonly number[]): number {
  const dim = a.length
  if (dim === 0 || b.length !== dim || spread.length !== dim) return Number.NaN
  let dot = 0
  for (let i = 0; i < dim; i++) {
    const s = spread[i]
    if (!Number.isFinite(s) || s <= 0) return Number.NaN
    dot += (a[i] * b[i]) / (s * s)
  }
  return dot
}

/**
 * 白化后的**归一化平方距离**（每维平均）：d² = mean_i ((a_i-b_i)/spread_i)²。
 *
 * 为什么最终用距离而不是余弦：余弦只看方向、不看幅度，而说话人差异恰恰大量体现为
 * 「某一维差了几个 spread」这种幅度差异。实测（自测脚本打印）同一批音频：
 *   同人 d²≈0.8  vs 明显异人 d²≈2.2~16          → 差 3 倍以上，干净可分
 *   同人 cos≈0.958 vs 相似嗓音异人 cos≈0.899    → 只差 0.06，且被公共分量压缩
 * 也就是说余弦的排序是对的但尺度被压扁，距离天然没有这个公共分量问题。
 * 注意 d² 里每个维度的 spread 都不同，所以这个「平均」是无量纲的（单位是 spread²）。
 */
export function whitenedDistanceSq(a: readonly number[], spread: readonly number[], b: readonly number[]): number {
  const dim = a.length
  if (dim === 0 || b.length !== dim || spread.length !== dim) return Number.NaN
  let sum = 0
  for (let i = 0; i < dim; i++) {
    const s = spread[i]
    if (!Number.isFinite(s) || s <= 0) return Number.NaN
    const t = (a[i] - b[i]) / s
    sum += t * t
  }
  const out = sum / dim
  return Number.isFinite(out) ? out : Number.NaN
}

/**
 * 白化后的余弦相似度（原始余弦，0-1）。
 *
 * 注意：**这个值不能直接当相似度分数用**。MFCC 统计向量在高维空间里高度同向
 * （都带有「典型语音频谱包络」这个公共分量），余弦天然挤在 0.7~1.0：
 * 同人 ≈0.98、异人 ≈0.90、明显不同的人 ≈0.72。固定阈值切不开这种被压缩的分布。
 * 所以这里只提供原始余弦，交给调用方的分数是 index.ts 里经过个人基线校准后的值。
 */
export function whitenedCosine(centroid: readonly number[], spread: readonly number[], vector: readonly number[]): number {
  const normA = whitenedDot(centroid, spread, centroid)
  const normB = whitenedDot(vector, spread, vector)
  const dot = whitenedDot(centroid, spread, vector)
  if (!Number.isFinite(dot) || !Number.isFinite(normA) || !Number.isFinite(normB)) return 0
  if (normA <= 0 || normB <= 0) return 0
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  if (!Number.isFinite(cos)) return 0
  return cos <= 0 ? 0 : cos > 1 ? 1 : cos
}
