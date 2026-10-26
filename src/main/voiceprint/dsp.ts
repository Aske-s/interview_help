/**
 * 声纹过滤：底层信号处理原语。
 *
 * 为什么自己实现而不是引依赖：
 *  1. 「随思」是本地自用工具，声纹只是「别回答我自己说的话」这一层辅助过滤，
 *     为它引入 onnxruntime / sherpa-onnx 这类重依赖（几十 MB 模型 + 原生编译）不划算；
 *  2. 数据量很小：一个 3 秒片段只做约 300 次 512 点 FFT，纯 JS 耗时在毫秒级，
 *     放在实时链路上完全无感；
 *  3. 纯函数实现可以直接在 Node 里自测（见 __selftest__），不需要 electron、声卡和音频设备。
 *
 * 输入约定：16kHz / 单声道 / PCM16 小端裸流。**不做重采样**——
 * 调用方（实时会话）保证采样率是 16k；若喂进 44.1k 的音频，频谱整体被压缩，
 * 声纹会自然对不上（这一点在汇报里作为已知局限写明）。
 */

/** 采样率，全流程硬编码 16k（见文件头说明） */
export const SAMPLE_RATE = 16000
/** 帧长 25ms = 400 采样 */
export const FRAME_LEN = 400
/** 帧移 10ms = 160 采样 */
export const FRAME_HOP = 160
/** FFT 点数：400 补零到 512，用 radix-2 快速算法 */
export const FFT_SIZE = 512
/** Mel 滤波器组个数：26 个是 16k 语音识别的常规取值，够平滑又不至于抹掉共振峰 */
export const MEL_BANDS = 26
/** 预加重系数 0.97：抵消声门脉冲带来的 -6dB/oct 频谱倾斜，让高频共振峰更清晰 */
export const PREEMPHASIS = 0.97
/**
 * Mel 滤波器组的最高频率。
 *
 * 取 4kHz（电话带）而不是奈奎斯特 8kHz，实测有两个好处：
 *  1. **抗噪声**：环境噪声（尤其白噪声/风扇声）的能量大量堆在 4kHz 以上，
 *     而语音的说话人信息（F1-F3 共振峰）几乎都在 4kHz 以下。把高频整段让出去，
 *     倒谱就不会跟着噪声底一起漂（实测噪声下同人分数从 0.75 抬到 0.95+）。
 *  2. **分辨率**：同样 26 个滤波器，覆盖 0-4kHz 时每个约 150Hz 宽，
 *     对共振峰位置的刻画比 0-8kHz 细一倍。
 * 代价是丢弃擦音等高频信息——对「这是不是我自己」这个判断没有损失。
 */
export const MEL_MAX_HZ = 4000

/**
 * PCM16 小端裸流 → 归一化浮点。
 * 长度是奇数时丢掉最后一个不完整的字节（调用方切分时可能切断样本，不该因此抛异常）。
 */
export function decodePcm16(pcm: Buffer): Float64Array {
  const usable = pcm.length - (pcm.length % 2)
  const out = new Float64Array(usable / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768
  }
  return out
}

/** 预加重：y[n] = x[n] - a*x[n-1]；返回新数组，不改调用方数据 */
export function preemphasis(samples: Float64Array, a = PREEMPHASIS): Float64Array {
  const out = new Float64Array(samples.length)
  if (samples.length === 0) return out
  out[0] = samples[0] * (1 - a)
  for (let i = 1; i < samples.length; i++) out[i] = samples[i] - a * samples[i - 1]
  return out
}

/** 汉明窗（模块级常量：纯函数结果，缓存不改变可观察行为） */
export const HAMMING_WINDOW: Float64Array = buildHamming()

function buildHamming(): Float64Array {
  const w = new Float64Array(FRAME_LEN)
  for (let i = 0; i < FRAME_LEN; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1))
  }
  return w
}

/* ------------------------------------------------------------------ *
 * FFT
 * ------------------------------------------------------------------ */

interface FftPlan {
  /** 位反转表 */
  rev: Uint32Array
  /** 旋转因子 cos / sin，按 k 索引（角度 = -2πk/N） */
  cos: Float64Array
  sin: Float64Array
}

const FFT_PLANS = new Map<number, FftPlan>()

/**
 * 迭代式 radix-2 FFT 的静态表。
 * 旋转因子预计算成表而不是每级递推相乘：递推在 N=512 时误差可忽略，
 * 但每个片段要做几百次变换，查表既更快也更干净。
 */
function fftPlan(n: number): FftPlan {
  const cached = FFT_PLANS.get(n)
  if (cached) return cached
  const levels = Math.log2(n)
  if (!Number.isInteger(levels)) throw new Error(`FFT 长度必须是 2 的幂：${n}`)
  const rev = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < levels; b++) {
      if (i & (1 << b)) r |= 1 << (levels - 1 - b)
    }
    rev[i] = r
  }
  const half = n >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n
    cos[k] = Math.cos(angle)
    sin[k] = Math.sin(angle)
  }
  const plan: FftPlan = { rev, cos, sin }
  FFT_PLANS.set(n, plan)
  return plan
}

/** 原地 FFT：re/im 长度必须相等且为 2 的幂 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n !== im.length) throw new Error('FFT 实部与虚部长度不一致')
  const { rev, cos, sin } = fftPlan(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let base = 0; base < n; base += size) {
      for (let k = 0; k < half; k++) {
        const tw = k * step
        const wr = cos[tw]
        const wi = sin[tw]
        const a = base + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/** FFT 频点数（单边谱） */
export const SPECTRUM_BINS = FFT_SIZE / 2 + 1

/**
 * 单帧功率谱（补零到 FFT_SIZE，除以 N 做幅度归一化，便于设定统一的对数下限）。
 * 已加汉明窗的帧直接传进来即可。
 */
export function powerSpectrum(windowedFrame: Float64Array): Float64Array {
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const n = Math.min(windowedFrame.length, FFT_SIZE)
  for (let i = 0; i < n; i++) re[i] = windowedFrame[i]
  fft(re, im)
  const out = new Float64Array(SPECTRUM_BINS)
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    out[b] = (re[b] * re[b] + im[b] * im[b]) / FFT_SIZE
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Mel 滤波器组
 * ------------------------------------------------------------------ */

export interface MelFilter {
  /** 起始频点下标 */
  start: number
  /** 各频点权重 */
  weights: Float64Array
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1)
}

/**
 * 三角 Mel 滤波器组（在 Mel 域等间距，中心频率反算回 Hz 后落在 FFT 频点上）。
 * 之所以在 Mel 域而不是线性 Hz 域插值：低频共振峰（F1/F2）才是区分说话人的关键，
 * 线性域会把一半滤波器浪费在 4kHz 以上。
 */
export const MEL_FILTERS: MelFilter[] = buildMelFilters()

function buildMelFilters(): MelFilter[] {
  const minMel = hzToMel(0)
  const maxMel = hzToMel(MEL_MAX_HZ)
  const edgesHz = new Float64Array(MEL_BANDS + 2)
  for (let i = 0; i < edgesHz.length; i++) {
    edgesHz[i] = melToHz(minMel + ((maxMel - minMel) * i) / (MEL_BANDS + 1))
  }
  const binHz = SAMPLE_RATE / 2 / (SPECTRUM_BINS - 1)
  const filters: MelFilter[] = []
  for (let m = 1; m <= MEL_BANDS; m++) {
    const lo = edgesHz[m - 1]
    const center = edgesHz[m]
    const hi = edgesHz[m + 1]
    const start = Math.max(0, Math.floor(lo / binHz))
    const end = Math.min(SPECTRUM_BINS - 1, Math.ceil(hi / binHz))
    const weights = new Float64Array(end - start + 1)
    let total = 0
    for (let b = start; b <= end; b++) {
      const f = b * binHz
      let w = 0
      if (f >= lo && f <= center && center > lo) w = (f - lo) / (center - lo)
      else if (f > center && f <= hi && hi > center) w = (hi - f) / (hi - center)
      weights[b - start] = w
      total += w
    }
    // 极低频段的带宽可能窄于一个频点间距，导致权重全为 0；
    // 这时退化成「取中心频点」的一个矩形滤波器，保证能量不被整段丢掉。
    if (total <= 0) {
      const only = Math.min(end, Math.max(start, Math.round(center / binHz))) - start
      weights.fill(0)
      weights[Math.max(0, only)] = 1
    }
    filters.push({ start, weights })
  }
  return filters
}

/** Mel 滤波器组能量 */
export function melEnergies(power: Float64Array): Float64Array {
  const out = new Float64Array(MEL_BANDS)
  for (let m = 0; m < MEL_BANDS; m++) {
    const filter = MEL_FILTERS[m]
    let sum = 0
    for (let i = 0; i < filter.weights.length; i++) {
      sum += filter.weights[i] * power[filter.start + i]
    }
    out[m] = sum
  }
  return out
}

/**
 * 取对数 + 动态范围压缩：log(E[i] + α·E_peak)，α = 10^(-rangeDb/10)。
 *
 * 为什么是「相对本帧峰值加一个小量」而不是别的做法：
 *  - 用绝对 eps（log(E+1e-10)）不行：7-8kHz 这类几乎无能量的频带会固定落到同一个
 *    跟信号无关的常数，污染倒谱均值；
 *  - 用硬夹断（logE = max(logE, peakLog - 45dB)）也不行，这一点是实测踩出来的：
 *    频带能量刚好落在夹断边界时，量化噪声这种 1e-4 量级的扰动会让该频带在
 *    「夹断值/真实值」之间跳变，单帧倒谱因此抖动 0.5 量级；把同一段音频
 *    整体音量降到 0.3 倍（PCM16 量化误差相对变大）后，声纹相似度会从 0.98
 *    掉到 0.85 —— 而「对音量不敏感」是硬要求。改成加性小量后函数连续，
 *    且因为 E[i] 与 E_peak 随增益同比缩放，gain 只带来一个常数偏移，
 *    该偏移在 DCT 里只进 C0，而 C0 会被丢掉 → 数学上严格增益不变。
 */
export function logMelEnergies(mel: Float64Array, rangeDb = 45): Float64Array {
  const out = new Float64Array(mel.length)
  let peak = 0
  for (let i = 0; i < mel.length; i++) {
    if (mel[i] > peak) peak = mel[i]
  }
  const floorEnergy = peak * Math.pow(10, -rangeDb / 10)
  for (let i = 0; i < mel.length; i++) {
    out[i] = Math.log(mel[i] + floorEnergy + 1e-30)
  }
  return out
}

/**
 * DCT-II（正交归一），取前 keep 个倒谱系数。
 * 只用 cos 表，不做快速 DCT：MEL_BANDS=26、keep=13，直接算是 338 次乘法，比递归实现更省事也更快。
 */
export function dctII(x: Float64Array, keep: number): Float64Array {
  const n = x.length
  const out = new Float64Array(keep)
  const scale = Math.sqrt(2 / n)
  for (let k = 0; k < keep; k++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += x[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n))
    }
    out[k] = sum * scale
  }
  return out
}
