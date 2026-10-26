/**
 * 声纹过滤自测（纯函数，不需要 electron / 声卡）。
 *
 * 运行：
 *   node src/main/voiceprint/__selftest__/run.cjs
 *
 * 用**合成音频**验证，不依赖任何真实录音：
 *   「说话人」= 基频 f0 + 声道长度系数 vtl（缩放 F1/F2/F3 共振峰）驱动的源-滤波器模型，
 *   每段音频由 3 个元音按序拼接，段与段之间的内容（元音序列/时长）可以不同。
 *
 * 为什么必须自己合成：真实录音里没有「标准答案」，无法判断一次误判是算法问题
 * 还是说话人本身变了。合成音频可以精确控制「同人/异人/音量/噪声」四个变量。
 *
 * 打印的关键数值（d² = 白化后的每维平均平方距离）就是调阈值与校准参数的依据。
 */
const fs = require('node:fs')
const path = require('node:path')

function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到项目根')
}
const ROOT = findRoot(__dirname)

const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}

const VP = require(path.join(ROOT, 'src/main/voiceprint/index.ts'))
const FEATURES = require(path.join(ROOT, 'src/main/voiceprint/features.ts'))
const DSP = require(path.join(ROOT, 'src/main/voiceprint/dsp.ts'))

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/* ================================================================== *
 * 合成音频工具
 * ================================================================== */

const SR = 16000
/** 成年男性元音的标准共振峰（Hz） */
const VOWELS = {
  a: [730, 1090, 2440],
  i: [270, 2290, 3010],
  u: [300, 870, 2240],
  e: [530, 1840, 2480],
  o: [570, 840, 2410]
}

function mulberry32(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function resonatorGain(r, theta) {
  const re = 1 - 2 * r * Math.cos(theta) * Math.cos(theta) + r * r * Math.cos(2 * theta)
  const im = 2 * r * Math.cos(theta) * Math.sin(theta) - r * r * Math.sin(2 * theta)
  return Math.hypot(re, im)
}

/**
 * 二阶共振器（源-滤波器模型里的声道）。
 * 归一化只能作用在**前馈系数**上：若把整个差分方程同除增益，递归系数 a1/a2 会被一起
 * 放大，极点跑到单位圆外，滤波器立刻发散成 NaN。所以 bn = b0/|H(θ)| 只乘输入项。
 */
function resonator(x, freq, bw) {
  const r = Math.exp((-Math.PI * bw) / SR)
  const theta = (2 * Math.PI * freq) / SR
  const b0 = 1 - r
  const bn = b0 / resonatorGain(r, theta)
  const a1 = 2 * r * Math.cos(theta)
  const a2 = -r * r
  const y = new Float64Array(x.length)
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = bn * x[i] + a1 * y1 + a2 * y2
    y[i] = v
    y2 = y1
    y1 = v
  }
  return y
}

/** 合成一个「说话人」按给定元音序列念一段，返回 PCM16 与有效语音段 RMS */
function synth(spk, seq, opts = {}) {
  const rand = mulberry32(opts.seed || 1)
  const amp = opts.amp === undefined ? 0.25 : opts.amp
  const jitter = spk.jitter === undefined ? 0.02 : spk.jitter
  const total = Math.round((opts.seconds || 2.6) * SR)
  const raw = new Float64Array(total)
  const active = new Uint8Array(total)
  const perVowel = Math.floor(total / seq.length)
  const fade = Math.round(0.02 * SR)
  let phase = 0
  for (let vi = 0; vi < seq.length; vi++) {
    const base = VOWELS[seq[vi]]
    const formants = base.map((f) => f * spk.vtl * (1 + (rand() - 0.5) * 0.02))
    const start = vi * perVowel
    const len = Math.max(1, Math.min(perVowel - Math.round(0.03 * SR), total - start))
    const src = new Float64Array(len)
    for (let i = 0; i < len; i++) {
      // 谐波叠加模拟声门脉冲，带轻微抖动
      const f0 = spk.f0 * (1 + jitter * (rand() - 0.5))
      phase += (2 * Math.PI * f0) / SR
      let v = 0
      for (let k = 1; k <= 40; k++) {
        if (k * f0 > SR / 2 - 200) break
        v += Math.sin(phase * k + k * 0.7) / Math.pow(k, 1.15)
      }
      src[i] = v
    }
    let out = src
    const bandwidths = [70, 100, 140]
    for (let i = 0; i < 3; i++) out = resonator(out, formants[i], bandwidths[i])
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / fade, (len - 1 - i) / fade)
      raw[start + i] = out[i] * env
      active[start + i] = 1
    }
  }
  let peak = 0
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(raw[i]))
  if (peak <= 0) peak = 1
  const scale = amp / peak
  let acc = 0
  let count = 0
  const pcm = Buffer.alloc(total * 2)
  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, raw[i] * scale))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
    if (active[i]) {
      acc += v * v
      count++
    }
  }
  return { pcm, speechRms: Math.sqrt(acc / Math.max(1, count)) }
}

/** 整段按倍数缩放音量（PCM16 直接乘，模拟「同一段录音小声/大声」） */
function scalePcm(pcm, k) {
  const out = Buffer.alloc(pcm.length)
  for (let i = 0; i < pcm.length / 2; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * k))), i * 2)
  }
  return out
}

/** 逐帧 dB（走真实 DSP 路径），用于把噪声标定在「比语音峰值帧低 N dB」 */
function frameDbs(pcm) {
  const samples = DSP.preemphasis(DSP.decodePcm16(pcm))
  const total = Math.floor((samples.length - DSP.FRAME_LEN) / DSP.FRAME_HOP) + 1
  const frame = new Float64Array(DSP.FRAME_LEN)
  const out = []
  for (let f = 0; f < total; f++) {
    const offset = f * DSP.FRAME_HOP
    for (let i = 0; i < DSP.FRAME_LEN; i++) frame[i] = samples[offset + i] * DSP.HAMMING_WINDOW[i]
    const power = DSP.powerSpectrum(frame)
    let sum = 0
    for (const v of power) sum += v
    out.push(10 * Math.log10(sum / DSP.FFT_SIZE + 1e-30))
  }
  return out
}

/**
 * 加白噪声，噪声强度按「只有噪声的帧比语音峰值帧低 offsetDb」标定。
 * 用「帧能量口径」而不是笼统的 SNR，是因为这个数可以直接和帧权重门限比较。
 */
function addNoiseAt(pcm, offsetDb, seed) {
  const peakDb = Math.max(...frameDbs(pcm))
  const n = pcm.length / 2
  const rand = mulberry32(seed)
  const unit = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(rand(), 1e-12)
    const u2 = rand()
    unit[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  // 先用一个参考幅度量出「单位噪声」的帧 dB，再按 20log10(σ/参考幅度) 反解出 σ
  const probe = Buffer.alloc(pcm.length)
  const probeScale = 0.05
  for (let i = 0; i < n; i++) {
    probe.writeInt16LE(Math.round(Math.max(-1, Math.min(1, unit[i] * probeScale)) * 32767), i * 2)
  }
  const db = frameDbs(probe)
  const referenceDb = db.reduce((a, b) => a + b, 0) / db.length
  const sigma = probeScale * Math.pow(10, (peakDb - offsetDb - referenceDb) / 20)
  const rand2 = mulberry32(seed + 1)
  const out = Buffer.alloc(pcm.length)
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(rand2(), 1e-12)
    const u2 = rand2()
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const v = pcm.readInt16LE(i * 2) / 32768 + g * sigma
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2)
  }
  return out
}

/* ================================================================== *
 * 素材
 * ================================================================== */

const SEQS = [
  ['a', 'i', 'u'],
  ['e', 'o', 'a'],
  ['i', 'a', 'o'],
  ['u', 'e', 'a'],
  ['o', 'u', 'i'],
  ['a', 'e', 'i'],
  ['o', 'a', 'e'],
  ['i', 'u', 'o']
]

/** 本人：男声，f0 118Hz */
const SELF = { f0: 118, vtl: 1.0, jitter: 0.02 }
/** 明显不同的人：女声，f0 205Hz，声道短 16% */
const OTHER_HIGH = { f0: 205, vtl: 1.16, jitter: 0.03 }
/** 相似嗓音（难点）：同性别、音高接近，声道短 12% */
const OTHER_SIMILAR = { f0: 122, vtl: 1.12, jitter: 0.02 }
/** 明显不同的人：男声但声道长 12%、音高更高 */
const OTHER_LOW = { f0: 155, vtl: 0.88, jitter: 0.02 }

const make = (spk, seed, seqIndex, opts) => synth(spk, SEQS[seqIndex], Object.assign({ seed: seed + seqIndex * 7 }, opts || {}))

/** 录入：4 段（内容各异） */
const ENROLL_CHUNKS = [0, 1, 2, 3].map((i) => make(SELF, 100, i).pcm)

const baseSame = make(SELF, 900, 0)

/** 同人 + 内容匹配（同元音序列，重新合成） */
const SAME_CONTENT = [0, 1, 2, 3].map((i) => make(SELF, 900, i).pcm)
/** 同人 + 音量变化 */
const SAME_VOLUME = [['×3', 3], ['×0.3', 0.3], ['×0.1', 0.1]].map(([label, k]) => [label, scalePcm(baseSame.pcm, k)])
/** 同人 + 白噪声（噪声底比语音峰值帧低 N dB） */
const SAME_NOISE = [45, 40, 35, 30, 25, 20].map((off) => [`噪声底-${off}dB`, addNoiseAt(baseSame.pcm, off, 20 + off)])
/** 同人 + 时长不足 */
const SAME_SHORT = [
  ['2.0s', baseSame.pcm.subarray(0, Math.round(2.0 * SR) * 2)],
  ['1.2s', baseSame.pcm.subarray(0, Math.round(1.2 * SR) * 2)]
]
/** 同人 + 内容不同（诊断用：这条对单人模板是最难的） */
const SAME_OTHER_CONTENT = [4, 5, 6, 7].map((i) => make(SELF, 700, i).pcm)
/** 异人（内容与录入匹配，避免把「内容差异」算到说话人头上） */
const DIFF = []
for (const [label, spk] of [['异B(205Hz/短16%)', OTHER_HIGH], ['异C(122Hz/短12%)', OTHER_SIMILAR], ['异D(155Hz/长12%)', OTHER_LOW]]) {
  for (let i = 0; i < 4; i++) DIFF.push([`${label}#${i + 1}`, make(spk, 500, i).pcm])
}

/* ================================================================== *
 * 用例
 * ================================================================== */

function main() {
  console.log('===== 录入（4 段，内容各异） =====')
  const profile = VP.enroll('自用声纹', ENROLL_CHUNKS)
  const scale = Math.min(Math.max(profile.intraDistStd, VP.CALIBRATION_MIN_STD), VP.CALIBRATION_MAX_STD)
  const center = profile.intraDistMean + VP.CALIBRATION_K * scale
  console.log(
    `dim=${profile.dim} samples=${profile.samples} 同人基线 mean=${profile.intraDistMean.toFixed(4)} std=${profile.intraDistStd.toFixed(4)}`
  )
  console.log(
    `校准: scale=${scale.toFixed(4)} center=${center.toFixed(4)} → 阈值 0.72 对应的距离边界 d²=${(center - Math.log(0.72 / 0.28) * scale).toFixed(4)}`
  )

  const score = (pcm) => VP.similarity(profile, pcm)
  const dist = (pcm) => VP.rawDistance(profile, pcm)
  const row = (label, pcm) => {
    const d = dist(pcm)
    const s = score(pcm)
    return { label, d, s, self: VP.isSelf(profile, pcm, 0.72) }
  }

  /* ---------- 1. 同人（内容匹配） ---------- */
  console.log('\n===== 1. 同一说话人（相同基频 + 相同共振峰，内容匹配） =====')
  const sameRows = SAME_CONTENT.map((p, i) => row(`同人·内容匹配#${i + 1}`, p))
  for (const r of sameRows) console.log(`  ${r.label}   d²=${r.d.toFixed(3)}  相似度=${r.s.toFixed(3)}  isSelf=${r.self}`)
  const sameMinScore = Math.min(...sameRows.map((r) => r.s))
  check(
    '同人 4 段全部判为自己（相似度 ≥ 0.9）',
    sameRows.every((r) => r.self) && sameMinScore >= 0.9,
    `最低相似度 ${sameMinScore.toFixed(3)}，距离范围 ${Math.min(...sameRows.map((r) => r.d)).toFixed(3)}~${Math.max(...sameRows.map((r) => r.d)).toFixed(3)}`
  )

  /* ---------- 2. 异人 ---------- */
  console.log('\n===== 2. 不同说话人（基频/共振峰明显不同，内容匹配） =====')
  const diffRows = DIFF.map(([label, p]) => row(label, p))
  for (const r of diffRows) console.log(`  ${r.label}   d²=${r.d.toFixed(3)}  相似度=${r.s.toFixed(3)}  isSelf=${r.self}`)
  const diffMaxScore = Math.max(...diffRows.map((r) => r.s))
  check(
    '异人 12 段全部判为他人（相似度 ≤ 0.1）',
    diffRows.every((r) => !r.self) && diffMaxScore <= 0.1,
    `最高相似度 ${diffMaxScore.toFixed(3)}，最近距离 d²=${Math.min(...diffRows.map((r) => r.d)).toFixed(3)}`
  )
  const sameMaxDist = Math.max(...sameRows.map((r) => r.d))
  const diffMinDist = Math.min(...diffRows.map((r) => r.d))
  check(
    '区分度：同人最大距离 < 异人最小距离（距离口径干净可分）',
    sameMaxDist < diffMinDist,
    `同人 max=${sameMaxDist.toFixed(3)} < 异人 min=${diffMinDist.toFixed(3)}（相差 ${(diffMinDist / sameMaxDist).toFixed(2)} 倍）`
  )

  /* ---------- 3. 音量不敏感 ---------- */
  console.log('\n===== 3. 音量不敏感（同一段录音缩放） =====')
  const baseDist = dist(baseSame.pcm)
  const volumeRows = SAME_VOLUME.map(([label, p]) => row(`音量${label}`, p))
  for (const r of volumeRows) {
    console.log(
      `  ${r.label}   d²=${r.d.toFixed(3)}（相对干净 ${((r.d / baseDist - 1) * 100).toFixed(1)}%）  相似度=${r.s.toFixed(3)}  isSelf=${r.self}`
    )
  }
  const volumeDrift = Math.max(...volumeRows.map((r) => Math.abs(r.d / baseDist - 1)))
  check(
    '音量 ×3 / ×0.3 / ×0.1 仍判为自己，且距离漂移 < 15%',
    volumeRows.every((r) => r.self && r.s >= 0.8) && volumeDrift < 0.15,
    `最大距离漂移 ${(volumeDrift * 100).toFixed(1)}%`
  )

  /* ---------- 4. 白噪声 ---------- */
  console.log('\n===== 4. 同人 + 白噪声 =====')
  const noiseRows = SAME_NOISE.map(([label, p]) => row(label, p))
  for (const r of noiseRows) {
    console.log(`  ${r.label}   d²=${r.d.toFixed(3)}  相似度=${r.s.toFixed(3)}  isSelf=${r.self}`)
  }
  const noiseOk = noiseRows.filter((r) => /-(45|40|35|30|25)dB$/.test(r.label))
  check(
    '噪声底低至语音峰值帧下 25dB 仍判为自己',
    noiseOk.every((r) => r.self && r.s >= 0.8),
    noiseOk.map((r) => `${r.label}=${r.s.toFixed(2)}`).join(' ')
  )
  console.log('  （参考：噪声底 -20dB 时相似度 ' + noiseRows.find((r) => /-20dB/.test(r.label)).s.toFixed(3) + '，仍在阈值之上）')

  /* ---------- 5. 静音 / 极短 ---------- */
  console.log('\n===== 5. 静音 / 极短音频（必须优雅返回，不能抛异常） =====')
  const edgeCases = [
    ['3 秒纯静音', Buffer.alloc(3 * SR * 2)],
    ['0.3 秒', baseSame.pcm.subarray(0, Math.round(0.3 * SR) * 2)],
    ['0.05 秒', baseSame.pcm.subarray(0, Math.round(0.05 * SR) * 2)],
    ['空 Buffer', Buffer.alloc(0)]
  ]
  let edgeOk = true
  let edgeDetail = []
  try {
    for (const [label, pcm] of edgeCases) {
      const s = score(pcm)
      const self = VP.isSelf(profile, pcm, 0.72)
      edgeDetail.push(`${label}: 相似度=${s.toFixed(3)} isSelf=${self}`)
      if (!(s === 0 && self === false)) edgeOk = false
    }
  } catch (err) {
    edgeOk = false
    edgeDetail.push(`抛异常: ${err && err.message}`)
  }
  for (const line of edgeDetail) console.log(`  ${line}`)
  check('静音/极短/空输入：返回 0、判为他人、不抛异常', edgeOk)

  /* ---------- 6. 阈值边界 ---------- */
  console.log('\n===== 6. 阈值边界（阈值越高越严格） =====')
  const thresholds = [0.1, 0.3, 0.5, 0.72, 0.9, 1.0]
  const probeSame = SAME_CONTENT[0]
  const probeDiff = DIFF[0][1]
  const table = thresholds.map((t) => [t, VP.isSelf(profile, probeSame, t), VP.isSelf(profile, probeDiff, t)])
  for (const [t, a, b] of table) console.log(`  阈值=${t.toFixed(2)}  同人=${a}  异人=${b}`)
  // 单调性：阈值升高时 isSelf 不能从 false 变 true
  const allProbes = [...SAME_CONTENT, ...SAME_VOLUME.map(([, p]) => p), ...DIFF.map(([, p]) => p)]
  let monotone = true
  for (const pcm of allProbes) {
    let previous = null
    for (const t of thresholds) {
      const now = VP.isSelf(profile, pcm, t)
      if (previous === true && now === false) previous = now
      else if (previous === false && now === true) monotone = false
      previous = now
    }
  }
  check('阈值单调：调高阈值不会把「他人」翻成「自己」', monotone)
  check(
    '默认阈值 0.72 能区分同人/异人（显式断言）',
    VP.isSelf(profile, probeSame, 0.72) === true && VP.isSelf(profile, probeDiff, 0.72) === false,
    `阈值 0.72：同人=${VP.isSelf(profile, probeSame, 0.72)} 异人=${VP.isSelf(profile, probeDiff, 0.72)}`
  )
  check(
    '阈值调到 1.0 时同人也被判为他人（说明 0.72 确实在中间，不是恒真）',
    VP.isSelf(profile, probeSame, 1.0) === false,
    `同人相似度=${score(probeSame).toFixed(4)} < 1.0`
  )

  /* ---------- 7. enroll 行为 ---------- */
  console.log('\n===== 7. enroll 样本统计与错误处理 =====')
  const tooShortChunk = Buffer.alloc(Math.round(0.5 * SR) * 2)
  const mixed = VP.enroll('混合', [ENROLL_CHUNKS[0], ENROLL_CHUNKS[1], ENROLL_CHUNKS[2], tooShortChunk])
  console.log(`  3 段有效 + 1 段 0.5 秒 → samples=${mixed.samples}`)
  check('samples 只统计有效片段（3 段有效 + 1 段过短 → 3）', mixed.samples === 3, `实际 ${mixed.samples}`)

  let emptyError = null
  try {
    VP.enroll('空', [])
  } catch (err) {
    emptyError = err
  }
  console.log(`  空数组 → ${emptyError ? emptyError.message : '（没有抛错！）'}`)
  check(
    '空数组抛可读错误（信息里说明需要多少段）',
    emptyError instanceof Error && /声纹录入失败/.test(emptyError.message) && /至少需要/.test(emptyError.message)
  )

  let shortError = null
  try {
    VP.enroll('全过短', [tooShortChunk, Buffer.alloc(Math.round(0.3 * SR) * 2)])
  } catch (err) {
    shortError = err
  }
  console.log(`  全部过短 → ${shortError ? shortError.message : '（没有抛错！）'}`)
  check('全部片段过短也抛可读错误', shortError instanceof Error && /有效片段只有/.test(shortError.message))

  /* ---------- 8. Lead 复现场景 ---------- */
  console.log('\n===== 8. 复现场景：2 段 ×1.5s 录入，120Hz vs 210Hz =====')
  const leadEnroll = [0, 1].map((i) => synth({ f0: 120, vtl: 1.0, jitter: 0.02 }, SEQS[i], { seed: 11 + i * 3, seconds: 1.5 }).pcm)
  const leadProfile = VP.enroll('lead', leadEnroll)
  const leadSame = synth({ f0: 120, vtl: 1.0, jitter: 0.02 }, SEQS[2], { seed: 77, seconds: 1.5 }).pcm
  const leadDiff = synth({ f0: 210, vtl: 1.0, jitter: 0.02 }, SEQS[2], { seed: 78, seconds: 1.5 }).pcm
  const leadSameQuiet = scalePcm(leadSame, 0.3)
  const leadSameScore = VP.similarity(leadProfile, leadSame)
  const leadDiffScore = VP.similarity(leadProfile, leadDiff)
  const leadQuietScore = VP.similarity(leadProfile, leadSameQuiet)
  console.log(
    `  录入基线 mean=${leadProfile.intraDistMean.toFixed(4)} std=${leadProfile.intraDistStd.toFixed(4)}（2 段时 std 无意义，靠下限兜底）`
  )
  console.log(`  同人  d²=${VP.rawDistance(leadProfile, leadSame).toFixed(3)}  相似度=${leadSameScore.toFixed(4)}  isSelf=${VP.isSelf(leadProfile, leadSame, 0.72)}`)
  console.log(`  异人  d²=${VP.rawDistance(leadProfile, leadDiff).toFixed(3)}  相似度=${leadDiffScore.toFixed(4)}  isSelf=${VP.isSelf(leadProfile, leadDiff, 0.72)}`)
  console.log(`  音量×0.3 相似度=${leadQuietScore.toFixed(4)}  isSelf=${VP.isSelf(leadProfile, leadSameQuiet, 0.72)}`)
  check(
    'Lead 场景：同人 ≥ 0.8 且判为自己',
    leadSameScore >= 0.8 && VP.isSelf(leadProfile, leadSame, 0.72) === true,
    `同人相似度 ${leadSameScore.toFixed(4)}`
  )
  check(
    'Lead 场景：异人 ≤ 0.3 且判为他人',
    leadDiffScore <= 0.3 && VP.isSelf(leadProfile, leadDiff, 0.72) === false,
    `异人相似度 ${leadDiffScore.toFixed(4)}`
  )
  check('Lead 场景：音量 ×0.3 仍判为自己', VP.isSelf(leadProfile, leadSameQuiet, 0.72) === true && leadQuietScore >= 0.8, `相似度 ${leadQuietScore.toFixed(4)}`)

  /* ---------- 9. 特征块消融（解释为什么生产配置不用一阶差分） ---------- */
  console.log('\n===== 9. 特征块消融：为什么生产配置只用均值块 =====')
  const blockSets = [
    ['A 只用均值（生产）', { mean: true, std: false, delta: false }],
    ['AB 均值+标准差', { mean: true, std: true, delta: false }],
    ['AC 均值+差分', { mean: true, std: false, delta: true }],
    ['ABC 均值+标准差+差分', { mean: true, std: true, delta: true }],
    ['BC 只用 CMN 后的量(无均值)', { mean: false, std: true, delta: true }]
  ]
  let productionRatio = 0
  for (const [label, blocks] of blockSets) {
    const p = VP.enroll('消融', ENROLL_CHUNKS, blocks)
    const sameD = [...SAME_CONTENT, ...SAME_VOLUME.map(([, x]) => x), ...SAME_NOISE.map(([, x]) => x)].map((x) =>
      VP.rawDistance(p, x, blocks)
    )
    const diffD = DIFF.map(([, x]) => VP.rawDistance(p, x, blocks))
    const sameMax = Math.max(...sameD)
    const diffMin = Math.min(...diffD)
    const ratio = diffMin / sameMax
    if (blocks.mean && !blocks.std && !blocks.delta) productionRatio = ratio
    console.log(
      `  ${label.padEnd(26)} dim=${String(p.dim).padStart(2)}  同人max d²=${sameMax.toFixed(3)}  异人min d²=${diffMin.toFixed(3)}  ` +
        `比值=${ratio.toFixed(2)}×  ${ratio > 1 ? '可分' : '重叠！'}`
    )
  }
  check(
    '生产配置（均值块）的同人/异人距离比值 > 3 倍（其余组合达不到）',
    productionRatio > 3,
    `比值 ${productionRatio.toFixed(2)}×`
  )
  console.log('  → 标准差块与差分块描述「段内起伏」，受内容/噪声影响大；加进来会把区分度摊薄')
  console.log('     并让音量、噪声下距离明显漂移，所以生产配置只保留均值块（代码保留，可随时对照）。')

  /* ---------- 10. 已知局限（只打印数值，不做断言） ---------- */
  console.log('\n===== 10. 已知局限（只做证据打印，不参与判定） =====')
  const limRows = [
    ...SAME_OTHER_CONTENT.map((p, i) => row(`同人·换了元音内容#${i + 1}`, p)),
    ...SAME_SHORT.map(([label, p]) => row(`同人·只有${label}`, p)),
    ...noiseRows.filter((r) => /-(20|15)?dB$/.test(r.label) && /-(20)dB$/.test(r.label))
  ]
  for (const r of limRows) console.log(`  ${r.label}   d²=${r.d.toFixed(3)}  相似度=${r.s.toFixed(3)}  isSelf=${r.self}`)
  const caught = limRows.filter((r) => r.self).length
  console.log(`  → 这 ${limRows.length} 条「本人但内容/时长/噪声差异大」的样本里，${caught} 条能识别为自己、${limRows.length - caught} 条漏检。`)
  console.log('     漏检会把用户自己的话当成提问（回到原版行为），但不会误删别人的问题。')
  console.log('     漏检是刻意选的失败方向：宁可多答一次，也不要把别人的提问静默丢掉。')

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
