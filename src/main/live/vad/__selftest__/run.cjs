/**
 * 语音活动判定（VAD）纯逻辑自测。
 * 运行：node src/main/live/vad/__selftest__/run.cjs
 *
 * 这些断言直接对应「放视频验证识别不准」的真实原因：
 *  · 音频一开始就是人声时，不能判不出「有语音」（否则只能硬切、句子被切断）
 *  · 背景音乐/底噪不能把基底抬高到人声也被判成静音
 *  · 真正安静时要能降下来，否则永远触发静音切分
 */
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到项目根目录')
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

const { nextNoiseFloor, isVoiceFrame } = require(path.join(ROOT, 'src/main/live/vad.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const speech = 0.177 // 幅度 0.25 的正弦 ≈ 0.177

/* 1. 关键回归：音频一开始就是人声，必须能判出「有语音」 */
let floor = 0
for (let i = 0; i < 10; i++) floor = nextNoiseFloor(floor, speech)
check('音频一开始就是人声：仍能判出有语音', isVoiceFrame(speech, floor) === true, `floor=${floor.toFixed(4)}`)
check('基底不会被人声带偏（保持很小）', floor < 0.03, `floor=${floor.toFixed(4)}`)

/* 2. 真正的静音要能降下来并判为静音 */
floor = 0.02
for (let i = 0; i < 5; i++) floor = nextNoiseFloor(floor, 0)
check('静音：基底快速降到 0', floor === 0, `floor=${floor}`)
check('静音：判为无语音', isVoiceFrame(0, floor) === false)

/* 3. 背景音乐（稳定底噪）不应把基底抬到人声都算静音 */
let f2 = nextNoiseFloor(nextNoiseFloor(0, 0.05), 0.05)
for (let i = 0; i < 100; i++) f2 = nextNoiseFloor(f2, 0.05)
check('持续底噪：基底不会无限抬升', f2 <= 0.05, `floor=${f2.toFixed(4)}`)
check('底噪之上的人声仍判为有语音', isVoiceFrame(speech, f2) === true, `floor=${f2.toFixed(4)}`)

/* 4. 极安静环境的下限保护 */
check('基底为 0 时，极微弱声（0.002）不误判为语音', isVoiceFrame(0.002, 0) === false)
check('基底为 0 时，正常说话（0.05）判为语音', isVoiceFrame(0.05, 0) === true)

/* 5. 更安静时基底立即跟随 */
check('更安静时基底立即下降', nextNoiseFloor(0.03, 0.005) === 0.005, String(nextNoiseFloor(0.03, 0.005)))

/* 6. 连续人声不会让基底越过封顶 */
let f3 = 0.02
for (let i = 0; i < 5000; i++) f3 = nextNoiseFloor(f3, speech)
check('连续人声 5000 帧：基底仍封顶在 0.05 以内', f3 <= 0.05, `floor=${f3.toFixed(4)}`)
check('连续人声 5000 帧后仍判定为有语音', isVoiceFrame(speech, f3) === true, `floor=${f3.toFixed(4)}`)

const failed = RESULTS.filter((r) => !r.ok)
console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
process.exit(failed.length ? 1 : 0)
