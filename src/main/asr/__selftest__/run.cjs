/**
 * whisper-server 通道自测（对齐实时助答的真实用法）。
 *
 * 运行：node src/main/asr/__selftest__/run.cjs
 *
 * 需要 whisper-server 在跑：
 *   whisper-server -m <ggml-small.bin> --port 8178 --host 127.0.0.1
 * 未启动时优雅跳过（exit 0），不拖累整体流水线。
 *
 * 这里的核心事实：同一段 6.2 秒音频，
 *   每次调 whisper-cli（重载模型）约 14.9 秒
 *   常驻 whisper-server 约 1.0 秒
 * 所以实时助答必须走常驻服务。
 */
const fs = require('node:fs')
const os = require('node:os')
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
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@shared/')) request = path.join(ROOT, 'src', request.slice('@'.length))
  return origResolve.call(this, request, ...rest)
}

const SERVER = process.env.SUISI_WHISPER_SERVER ?? 'http://127.0.0.1:8178'
const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/** 生成一段测试语音（用 macOS say；不可用时跳过） */
function makeTestWav() {
  const { execFileSync } = require('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suisi-asr-test-'))
  const aiff = path.join(dir, 't.aiff')
  const wav = path.join(dir, 't.wav')
  try {
    execFileSync('/usr/bin/say', ['-o', aiff, '请听题，给定一个整数数组，找出其中两个数之和等于目标值的那两个下标。'])
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
    return { wav, dir }
  } catch {
    return { wav: null, dir }
  }
}

async function serverUp() {
  try {
    const res = await fetch(`${SERVER}/`, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  const up = await serverUp()
  if (!up) {
    console.log(`whisper-server 未在 ${SERVER} 运行 —— 跳过本组测试（不影响流水线）`)
    console.log('启动方式：whisper-server -m <ggml-small.bin> --port 8178 --host 127.0.0.1')
    process.exit(0)
  }

  const { createAsrProvider } = require(path.join(ROOT, 'src/main/asr/index.ts'))
  const cfg = {
    kind: 'whisper-server',
    baseUrl: '',
    apiKey: '',
    model: 'small',
    language: 'zh',
    binaryPath: '',
    modelPath: '',
    extraArgs: '',
    serverUrl: SERVER,
    autoStartServer: false,
    serverBinaryPath: ''
  }
  const provider = createAsrProvider(cfg)
  check('通道类型正确', provider.kind === 'whisper-server', provider.kind)

  const health = await provider.test()
  check('连通性检测通过', health.ok, health.message)

  const { wav, dir } = makeTestWav()
  try {
    if (!wav) {
      console.log('无法生成测试语音（say/afconvert 不可用）—— 跳过内容断言')
    } else {
      const pcm = fs.readFileSync(wav).subarray(44) // 去掉 WAV 头，模拟实时流的裸 PCM
      const started = Date.now()
      const text = await provider.transcribe(pcm, { language: 'zh' })
      const ms = Date.now() - started
      console.log(`   [证据] 转写结果："${text}"`)
      check('转写内容正确（含关键词）', text.includes('数组') && text.includes('目标值'), text.slice(0, 40))
      check('延迟可用（快于实时）', ms < 6200, `${ms}ms / 音频 6200ms`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 过短音频要短路，避免每句话都发一次无意义的请求
  const t0 = Date.now()
  const empty = await provider.transcribe(Buffer.alloc(100))
  check('过短音频直接返回空', empty === '' && Date.now() - t0 < 200, `${Date.now() - t0}ms`)

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
