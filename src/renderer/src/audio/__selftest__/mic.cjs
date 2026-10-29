/**
 * 麦克风打开策略自测（渲染层）。
 *
 * 运行：node src/renderer/src/audio/__selftest__/mic.cjs
 *
 * 关注点：存着的 deviceId 失效时不能让麦克风整个打不开。
 * 真实成因：Chromium 的 deviceId 是按 profile 加盐的哈希，
 * 权限状态变化 / profile 重建 / 设备插拔都会让它变，
 * 而开麦用的是 { exact } 硬约束 —— 一旦失效就抛 OverconstrainedError，
 * 表现是"麦克风根本打不开"，界面上只闪一行错，很难察觉。
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
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@shared/')) request = path.join(ROOT, 'src', request.slice('@'.length))
  return origResolve.call(this, request, ...rest)
}

// 模块顶层不会访问这些全局，只有真正开麦时才会；这里给最小桩
global.navigator = { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) } }
global.window = { api: undefined }

const { openMicStream, pickScriptProcessorBufferSize } = require(path.join(ROOT, 'src/renderer/src/audio/capture.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const fakeStream = { kind: 'stream', getAudioTracks: () => [], getTracks: () => [] }
const err = (name) => Object.assign(new Error(name), { name })

async function main() {
  // 1. 指定设备可用：一次成功，不回退
  {
    const calls = []
    const gum = async (c) => {
      calls.push(c)
      return fakeStream
    }
    const r = await openMicStream('dev-123', gum)
    check('指定设备可用：直接成功', r.usedDefaultDevice === false && calls.length === 1)
    check(
      '指定设备可用：用的是 exact 硬约束',
      calls[0]?.audio?.deviceId?.exact === 'dev-123',
      JSON.stringify(calls[0]?.audio?.deviceId)
    )
    check('指定设备可用：带上了降噪等基础约束', calls[0]?.audio?.echoCancellation === true && calls[0]?.audio?.noiseSuppression === true)
  }

  // 2. deviceId 失效（OverconstrainedError）→ 回退默认设备
  {
    const calls = []
    const gum = async (c) => {
      calls.push(c)
      if (c.audio?.deviceId?.exact) throw err('OverconstrainedError')
      return fakeStream
    }
    const r = await openMicStream('stale-id', gum)
    check('设备失效：仍然拿到了麦克风流（回退成功）', r.stream === fakeStream)
    check('设备失效：标记为已回退', r.usedDefaultDevice === true)
    check('设备失效：共尝试两次（先精确、后默认）', calls.length === 2, `${calls.length} 次`)
    check('设备失效：回退那次不带 deviceId 约束', calls[1]?.audio?.deviceId === undefined, JSON.stringify(calls[1]?.audio?.deviceId))
  }

  // 3. 设备被拔掉（NotFoundError）同样回退
  {
    let n = 0
    const gum = async (c) => {
      n++
      if (c.audio?.deviceId?.exact) throw err('NotFoundError')
      return fakeStream
    }
    const r = await openMicStream('gone', gum)
    check('设备不存在：回退到默认设备', r.usedDefaultDevice === true && n === 2)
  }

  // 4. 权限被拒（NotAllowedError）→ 不回退，直接抛（回退也开不了，不能掩盖真原因）
  {
    let calls = 0
    const gum = async () => {
      calls++
      throw err('NotAllowedError')
    }
    let thrown = null
    try {
      await openMicStream('dev-x', gum)
    } catch (e) {
      thrown = e
    }
    check('权限被拒：原样抛出，不静默回退', thrown?.name === 'NotAllowedError' && calls === 1, `${thrown?.name} / ${calls} 次`)
  }

  // 5. 没配置设备：直接用默认，且不算"回退"
  {
    const calls = []
    const gum = async (c) => {
      calls.push(c)
      return fakeStream
    }
    const r = await openMicStream(undefined, gum)
    check('未配置设备：一次调用默认设备', calls.length === 1 && calls[0]?.audio?.deviceId === undefined)
    check('未配置设备：不算回退（不误报提示）', r.usedDefaultDevice === false)
  }

  // 6. 指定设备被占用（NotReadableError）→ 不回退（同一物理设备，回退也白搭），给可读原因
  {
    let calls = 0
    const gum = async () => {
      calls++
      throw err('NotReadableError')
    }
    let thrown = null
    try {
      await openMicStream('busy-device', gum)
    } catch (e) {
      thrown = e
    }
    check(
      '指定设备被占用：抛出可读错误而不是原始 DOMException',
      /指定设备 NotReadableError/.test(String(thrown?.message ?? '')),
      String(thrown?.message ?? '(没抛)').slice(0, 60)
    )
    check('指定设备被占用：不盲目回退默认设备', calls === 1, `${calls} 次`)
    check('指定设备被占用：保留底层 error.name', thrown?.name === 'NotReadableError', String(thrown?.name))
  }

  // 7. 默认设备瞬时占用 → 等 300ms 重试一次即成功（设备刚被释放的典型情况）
  {
    let calls = 0
    const gum = async () => {
      calls++
      if (calls === 1) throw err('NotReadableError')
      return fakeStream
    }
    const r = await openMicStream(undefined, gum)
    check('默认设备瞬时占用：重试后成功', r.stream === fakeStream && calls === 2, `${calls} 次`)
  }

  // 8. 重试仍失败 → 错误里列出两次尝试，便于定位
  {
    const gum = async () => {
      throw err('NotReadableError')
    }
    let thrown = null
    try {
      await openMicStream(undefined, gum)
    } catch (e) {
      thrown = e
    }
    check(
      '持续占用：错误里含两次尝试',
      /默认设备 NotReadableError/.test(String(thrown?.message ?? '')) &&
        /重试 NotReadableError/.test(String(thrown?.message ?? '')),
      String(thrown?.message ?? '').slice(0, 70)
    )
  }

  // 9. 权限被拒 → 不回退、不重试，且保留 name
  {
    let calls = 0
    const gum = async () => {
      calls++
      throw err('NotAllowedError')
    }
    let thrown = null
    try {
      await openMicStream('dev-x', gum)
    } catch (e) {
      thrown = e
    }
    check('权限被拒：不回退、不重试', calls === 1, `${calls} 次`)
    check('权限被拒：保留 NotAllowedError，上层能识别', thrown?.name === 'NotAllowedError', String(thrown?.name))
  }

  /* ---- 10. ScriptProcessor 缓冲区大小（真实事故：4800 不是 2 的幂 → 麦克风建不起来）---- */
  {
    const cases = [44100, 48000, 96000, 16000, 8000, 22050]
    const sizes = cases.map((r) => ({ rate: r, size: pickScriptProcessorBufferSize(r) }))
    check(
      '缓冲区：所有采样率下都是 2 的幂',
      sizes.every(({ size }) => size > 0 && (size & (size - 1)) === 0),
      JSON.stringify(sizes)
    )
    check(
      '缓冲区：都落在 256~16384 合法区间',
      sizes.every(({ size }) => size >= 256 && size <= 16384),
      JSON.stringify(sizes.map((x) => x.size))
    )
    check(
      '缓冲区：48kHz 得到 4096（不再是会崩的 4800）',
      pickScriptProcessorBufferSize(48000) === 4096,
      String(pickScriptProcessorBufferSize(48000))
    )
    check('缓冲区：16kHz 得到 1024', pickScriptProcessorBufferSize(16000) === 1024, String(pickScriptProcessorBufferSize(16000)))
    check(
      '缓冲区：接近 100ms 的帧长（不偏离太远）',
      sizes.every(({ rate, size }) => Math.abs(size / rate - 0.1) < 0.06),
      JSON.stringify(sizes.map((x) => `${x.rate}→${Math.round((x.size / x.rate) * 1000)}ms`))
    )
  }

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e)
  process.exit(1)
})
