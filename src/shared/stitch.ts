/**
 * 长截图纵向拼接。
 *
 * 纯函数实现，输入输出都是 RGBA 像素缓冲，因此可以在 Node 里直接单测，
 * 不依赖 canvas 或真实屏幕。
 *
 * 算法：
 *  1. 把每张图转成行签名（每行按步长采样转灰度），用于快速比较
 *  2. 相邻两张图搜索最佳重叠高度：取上一张末尾 o 行与下一张开头 o 行比较平均差，
 *     选差值最小且低于阈值的 o 作为重叠
 *  3. 找到重叠就裁掉重复部分拼接；找不到就原样堆叠并标记（提示用户滚动过快）
 */

export interface RasterImage {
  width: number
  height: number
  /** RGBA，长度 = width * height * 4 */
  data: Uint8ClampedArray
}

export interface StitchOptions {
  /** 行签名采样步长（像素），越大越快越粗糙 */
  sampleStep?: number
  /** 最小重叠：绝对像素下限（优先于比例） */
  minOverlapPx?: number
  /** 最小重叠：相对高度的比例，仅作补充下限 */
  minOverlapRatio?: number
  /** 最大重叠比例 */
  maxOverlapRatio?: number
  /** 平均差阈值，越小越严格；超过则认为没有重叠 */
  tolerance?: number
}

export interface StitchResult {
  image: RasterImage
  /** 每张图贡献的有效高度 */
  contributed: number[]
  /** 相邻图之间检测到的重叠像素数（0 表示没找到） */
  overlaps: number[]
  /** 是否所有相邻图都成功找到重叠 */
  allMatched: boolean
  notes: string[]
}

/** 行签名：把一行按步长采样成灰度数组 */
function rowSignature(image: RasterImage, y: number, sampleStep: number): number[] {
  const out: number[] = []
  const rowOffset = y * image.width * 4
  for (let x = 0; x < image.width; x += sampleStep) {
    const i = rowOffset + x * 4
    // 亮度加权；忽略完全透明像素
    const a = image.data[i + 3]
    if (a < 8) {
      out.push(-1)
      continue
    }
    out.push(0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2])
  }
  return out
}

/** 两个行签名的平均绝对差 */
function signatureDiff(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (!n) return Number.POSITIVE_INFINITY
  let sum = 0
  let counted = 0
  for (let i = 0; i < n; i++) {
    // 任一侧是透明像素则跳过（例如滚动时出现的固定浮层）
    if (a[i] < 0 || b[i] < 0) continue
    sum += Math.abs(a[i] - b[i])
    counted++
  }
  if (!counted) return Number.POSITIVE_INFINITY
  return sum / counted
}

/**
 * 判断两帧是否内容相同（例如用户没滚动就又截了一次）。
 * 抽样若干行逐一比较，代价很低。
 */
function framesIdentical(prev: RasterImage, next: RasterImage, sampleStep: number, tolerance: number): boolean {
  if (prev.width !== next.width || prev.height !== next.height) return false
  const rows = 12
  for (let i = 0; i < rows; i++) {
    const y = Math.floor((prev.height - 1) * (i / (rows - 1 || 1)))
    const diff = signatureDiff(rowSignature(prev, y, sampleStep), rowSignature(next, y, sampleStep))
    if (!Number.isFinite(diff) || diff > tolerance) return false
  }
  return true
}

/** 在两张相邻图之间寻找最佳重叠高度（像素） */
export function findOverlap(prev: RasterImage, next: RasterImage, opts: StitchOptions = {}): { overlap: number; diff: number } {
  const sampleStep = opts.sampleStep ?? 4
  const minRatio = opts.minOverlapRatio ?? 0.01
  /*
   * 上限必须是 1.0，不能是 0.95。
   * 因为「整屏几乎没有变化」（例如用户只滚动了屏幕上的某个小区域）的正确答案就是
   * 重叠 = 整帧高度；若上限压到 0.95，这种情况会被迫去比较错位的行，
   * 差异必然偏大，于是误判成「没有重叠」并叠一份重复内容。
   */
  const maxRatio = opts.maxOverlapRatio ?? 1
  const tolerance = opts.tolerance ?? 6

  /*
   * 先处理「整帧重复」：用户没有滚动就又截了一次。
   * 这种情况的正确答案是「重叠 = 整帧高度」，但那样会超出 maxRatio 上限，
   * 于是会被误判成「找不到重叠」并把完全一样的内容再叠一份。
   */
  if (framesIdentical(prev, next, sampleStep, Math.max(1.5, tolerance / 2))) {
    return { overlap: Math.min(prev.height, next.height), diff: 0 }
  }

  const upper = Math.floor(Math.min(prev.height, next.height) * maxRatio)
  /*
   * 最小重叠用「绝对像素」而不是「高度的比例」。
   * 比例下限在 1800px 高的屏幕上意味着至少重叠 144px——用户滚动超过
   * 一屏减 144px 时就检测不到重叠，进而叠一份重复内容。
   * 绝对下限（24px）配合「严格匹配占比」判据足以避免误匹配。
   */
  const lower = Math.max(opts.minOverlapPx ?? 24, Math.floor(Math.min(prev.height, next.height) * minRatio))
  if (upper < lower) return { overlap: 0, diff: Number.POSITIVE_INFINITY }

  /*
   * 行签名缓存 + 逐像素扫描。
   *
   * 为什么不做「粗扫再精扫」：粗扫步长一旦跳过真实重叠值，精扫窗口又没覆盖到，
   * 就会误判成「没有重叠」。而差一行造成的平均差异通常有十几，远超容差，
   * 所以这种误判很常见。有了签名缓存后，逐像素扫描的代价是可以接受的。
   */
  const signatureCache = new Map<string, number[]>()
  const sigOf = (image: RasterImage, y: number): number[] => {
    const key = `${image === prev ? 'p' : 'n'}:${y}`
    let sig = signatureCache.get(key)
    if (!sig) {
      sig = rowSignature(image, y, sampleStep)
      signatureCache.set(key, sig)
    }
    return sig
  }

  /**
   * 评估某个重叠高度。
   *
   * 用「严格匹配行占比」而不是平均差异：
   *  - 真实匹配的行几乎完全相同（差异接近 0），不匹配的行差异远大于容差；
   *  - 而「假匹配」的差异往往恰好堆在容差附近，用占比会把它们算成匹配。
   * 屏幕上一小块变化（弹窗、输入框）只会让少数行不匹配，占比法对此不敏感。
   */
  const evaluate = (overlap: number): { score: number; avg: number; counted: number } => {
    const startY = prev.height - overlap
    /*
     * 采样要足够密：透明像素（滚动时出现的浮层）会被跳过，
     * 采样点太少会导致有效行不足而被误判为「样本不可信」。
     * 有行签名缓存，密度高一些的代价可以忽略。
     */
    const samples = 32
    const step = Math.max(1, Math.floor(overlap / samples))
    const strict = Math.max(1.5, tolerance / 2)
    let matched = 0
    let sum = 0
    let counted = 0
    for (let k = 0; k < overlap; k += step) {
      const diff = signatureDiff(sigOf(prev, startY + k), sigOf(next, k))
      if (!Number.isFinite(diff)) continue
      counted++
      sum += diff
      if (diff <= strict) matched++
    }
    if (!counted) return { score: 0, avg: Number.POSITIVE_INFINITY, counted: 0 }
    return { score: matched / counted, avg: sum / counted, counted }
  }

  /** 至少要有这么多行参与比较，结果才可信 */
  const minChecks = 4
  /** 严格匹配占比达到该阈值才认为找到了重叠 */
  const acceptScore = 0.5

  let best = { overlap: 0, score: 0, avg: Number.POSITIVE_INFINITY }

  // 从最大的重叠往下扫：优先选更大的重叠，避免把偶然相似的短片段当成重叠
  for (let overlap = upper; overlap >= lower; overlap--) {
    const { score, avg, counted } = evaluate(overlap)
    if (counted < minChecks) continue
    if (score > best.score || (score === best.score && avg < best.avg)) {
      best = { overlap, score, avg }
    }
    if (best.score >= 0.98) break
  }

  if (best.score >= acceptScore) return { overlap: best.overlap, diff: best.avg }
  return { overlap: 0, diff: best.avg }
}

/** 纵向拼接多张图 */
export function stitchImages(images: RasterImage[], opts: StitchOptions = {}): StitchResult {
  if (!images.length) {
    return { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, contributed: [], overlaps: [], allMatched: true, notes: ['没有输入图像'] }
  }
  if (images.length === 1) {
    return {
      image: images[0],
      contributed: [images[0].height],
      overlaps: [],
      allMatched: true,
      notes: ['只有一屏，无需拼接']
    }
  }

  const width = images[0].width
  const overlaps: number[] = []
  const contributed: number[] = []
  const notes: string[] = []
  let allMatched = true

  // 宽度不一致时按第一张的宽度裁剪（避免越界）
  const normalized = images.map((img) => {
    if (img.width === width) return img
    const data = new Uint8ClampedArray(width * img.height * 4)
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < width; x++) {
        const from = (y * img.width + x) * 4
        const to = (y * width + x) * 4
        if (from + 3 < img.data.length) {
          data[to] = img.data[from]
          data[to + 1] = img.data[from + 1]
          data[to + 2] = img.data[from + 2]
          data[to + 3] = img.data[from + 3]
        }
      }
    }
    return { width, height: img.height, data }
  })

  let totalHeight = normalized[0].height
  contributed.push(normalized[0].height)

  for (let i = 1; i < normalized.length; i++) {
    const { overlap, diff } = findOverlap(normalized[i - 1], normalized[i], opts)
    overlaps.push(overlap)
    if (overlap >= normalized[i].height) {
      // 整帧重叠：用户没有滚动，或只改动了屏幕上的很小一块
      contributed.push(0)
      allMatched = false
      notes.push(`第 ${i + 1} 屏与上一屏内容基本相同（未检测到滚动），已跳过`)
      continue
    }
    if (overlap > 0) {
      contributed.push(normalized[i].height - overlap)
      totalHeight += normalized[i].height - overlap
    } else {
      allMatched = false
      contributed.push(normalized[i].height)
      totalHeight += normalized[i].height
      notes.push(`第 ${i + 1} 屏未找到重叠（差异 ${diff.toFixed(1)}），已直接堆叠；可能是滚动过快或页面留白过多`)
    }
  }

  const data = new Uint8ClampedArray(width * totalHeight * 4)
  let cursor = 0
  data.set(normalized[0].data.subarray(0, width * normalized[0].height * 4), 0)
  cursor += normalized[0].height

  for (let i = 1; i < normalized.length; i++) {
    const source = normalized[i]
    const skip = overlaps[i - 1]
    const rows = source.height - skip
    // 从第 skip 行开始拷贝
    data.set(source.data.subarray(skip * width * 4, source.height * width * 4), cursor * width * 4)
    cursor += rows
  }

  return { image: { width, height: totalHeight, data }, contributed, overlaps, allMatched, notes }
}
