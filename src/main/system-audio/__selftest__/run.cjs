/**
 * 系统音频采集自测（对齐原版 MacSystemAudioService）。
 *
 * 运行：node src/main/system-audio/__selftest__/run.cjs
 *
 * 分两段：
 *  A. 离线断言 —— 错误归一化、helper 定位、分帧、Buffer 别名、重复 start 的旧进程回收。
 *     这些不依赖权限，永远跑。
 *  B. 实测断言 —— 真的拉起 capture-sck，等 ready，播一段语音，确认收到非零 PCM。
 *     需要 macOS + 屏幕录制权限，缺一个就跳过（不判失败）。
 *
 * 为什么要 B：这条链路此前长期「有帧、音量恒为 0」，只看代码是看不出来的。
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

/* ---- 可控的 electron 桩（必须是单例：每次 require 返回同一个对象） ---- */
let screenStatus = 'granted'
const ElectronFake = {
  app: {
    getAppPath: () => ROOT,
    isPackaged: false
  },
  systemPreferences: {
    getMediaAccessStatus: () => screenStatus,
    askForMediaAccess: async () => true
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  shell: { openExternal: async () => undefined },
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => []
  }
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return ElectronFake
  return origLoad.apply(this, [request, ...rest])
}

const sa = require(path.join(ROOT, 'src/main/system-audio.ts'))
const {
  MacSystemAudioService,
  normalizeCaptureError,
  supportsSystemAudioLoopback,
  SCREEN_PERMISSION_DENIED,
  SCREEN_CAPTURE_UNAVAILABLE,
  SCREEN_CAPTURE_TIMEOUT
} = sa

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/** 记录被 kill 的假子进程 */
function fakeWindow(label) {
  const events = []
  return {
    label,
    events,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: {
      send: (channel, payload) => events.push({ channel, payload })
    }
  }
}

/* ============================ A. 离线断言 ============================ */

// A1 未授权 → SCREEN_PERMISSION_DENIED
screenStatus = 'denied'
check('未授权时归一化为 SCREEN_PERMISSION_DENIED', normalizeCaptureError(new Error('failed: x')).message === SCREEN_PERMISSION_DENIED)

screenStatus = 'restricted'
check('受限时同样是 SCREEN_PERMISSION_DENIED', normalizeCaptureError(new Error('failed: x')).message === SCREEN_PERMISSION_DENIED)

// A2 已授权但有别的故障 → SCREEN_CAPTURE_UNAVAILABLE（不能误报成权限问题）
screenStatus = 'granted'
check('已授权时归一化为 SCREEN_CAPTURE_UNAVAILABLE', normalizeCaptureError(new Error('failed: boom')).message === SCREEN_CAPTURE_UNAVAILABLE)

// A3 超时是独立错误码
check('超时归一化为 SCREEN_CAPTURE_TIMEOUT', normalizeCaptureError(Object.assign(new Error('t'), { name: 'TimeoutError' })).message === SCREEN_CAPTURE_TIMEOUT)

// A4 平台能力：macOS 13+ / Windows
const loopback = supportsSystemAudioLoopback()
check(
  'supportsSystemAudioLoopback 与本平台一致',
  process.platform === 'darwin' ? loopback === true : process.platform === 'win32' ? loopback === true : loopback === false,
  `platform=${process.platform} → ${loopback}`
)

// A5 helper 定位
const svc = new MacSystemAudioService()
const helperPath = svc.getHelperPath()
check('能定位到 capture-sck', Boolean(helperPath) && fs.existsSync(helperPath), helperPath || '(未找到)')

// A6 分帧：一帧拆成两段（跨事件边界）也要拼回来
{
  const win = fakeWindow('fragmented')
  const svc2 = new MacSystemAudioService()
  svc2.target = win
  svc2.child = {}
  const payload = Buffer.alloc(1280)
  for (let i = 0; i < 640; i++) payload.writeInt16LE(i % 1000, i * 2)
  const framed = Buffer.concat([Buffer.from(Uint32Array.of(payload.length).buffer).subarray(0, 4), payload])
  svc2.handleStdout(framed.subarray(0, 300))
  check('拆到一半不发帧', win.events.filter((e) => e.channel === 'mac-system-audio:data').length === 0)
  svc2.handleStdout(framed.subarray(300))
  const frames = win.events.filter((e) => e.channel === 'mac-system-audio:data')
  check('补齐后正好发一帧', frames.length === 1)
  const got = Buffer.from(frames[0].payload)
  check('帧内容与原始 PCM 一致', got.equals(payload), `len=${got.length}`)
}

// A7 多帧粘连 + Buffer 池别名（同一 chunk 里两帧内容不能互相覆盖）
{
  const win = fakeWindow('pool')
  const svc3 = new MacSystemAudioService()
  svc3.target = win
  svc3.child = {}
  const mk = (fill) => {
    const payload = Buffer.alloc(1280, fill)
    return Buffer.concat([Buffer.from(Uint32Array.of(payload.length).buffer).subarray(0, 4), payload])
  }
  // 显式走同一块内存池：小 Buffer 在 Node 里会共用 8KB pool
  svc3.handleStdout(Buffer.concat([mk(0x11), mk(0x22)]))
  const frames = win.events.filter((e) => e.channel === 'mac-system-audio:data')
  const first = Buffer.from(frames[0]?.payload ?? [])
  const second = Buffer.from(frames[1]?.payload ?? [])
  check('粘连的两帧都发出来', frames.length === 2)
  check('两帧内容各自独立（没有 Buffer 池串数据）', first[0] === 0x11 && second[0] === 0x22, `${first[0]}/${second[0]}`)
}

// A8 畸形长度要丢弃而不是把内存吃干
{
  const win = fakeWindow('badlen')
  const svc4 = new MacSystemAudioService()
  svc4.target = win
  svc4.child = {}
  const header = Buffer.alloc(4)
  header.writeUInt32LE(0x7fffffff, 0)
  svc4.handleStdout(Buffer.concat([header, Buffer.alloc(64)]))
  check('畸形帧长度直接丢弃', win.events.length === 0 && svc4.pending.length === 0)
}

// A9 换窗口 start 时必须先收掉旧进程（残留会占住 ScreenCaptureKit 会话）
{
  const svc5 = new MacSystemAudioService()
  const oldWin = fakeWindow('old')
  const newWin = fakeWindow('new')
  let killed = 0
  svc5.child = { killed: false, kill: () => { killed++; svc5.child.killed = true } }
  svc5.target = oldWin
  // 直接验 stop 是回归点：真实 start 需要 spawn，这里只验回收行为
  svc5.stop(false)
  check('stop 会真的 kill 子进程', killed === 1 && svc5.child === null, `killed=${killed}`)
  svc5.child = { killed: false, kill: () => { killed++ } }
  svc5.target = oldWin
  const res = svc5.start(newWin)
  check('换窗口时旧进程被回收', killed === 2, `killed=${killed}`)
  svc5.stop(false)
}

// A10 主动 stop 不报错给渲染层；被动 stop 要报
{
  const win = fakeWindow('errsem')
  const svc6 = new MacSystemAudioService()
  svc6.target = win
  svc6.child = { killed: false, kill: () => { svc6.child.killed = true } }
  svc6.stop(false)
  check('主动停止不发 error 事件', win.events.filter((e) => e.channel === 'mac-system-audio:error').length === 0)

  const win2 = fakeWindow('errsem2')
  const svc7 = new MacSystemAudioService()
  svc7.target = win2
  svc7.child = { killed: false, kill: () => { svc7.child.killed = true } }
  svc7.stop(true)
  const errors = win2.events.filter((e) => e.channel === 'mac-system-audio:error')
  check('stop 通知渲染层已停止', errors.length === 1 && errors[0].payload === 'SYSTEM_AUDIO_STOPPED', JSON.stringify(errors[0]?.payload))
}

/* ============================ B. 实测断言 ============================ */

/** 渲染层的帧切分（跨事件边界） */
{
  const { drainNativeFrames } = require(path.join(ROOT, 'src/renderer/src/audio/capture.ts'))

  const bytes = (values) => {
    const buf = Buffer.alloc(values.length * 2)
    values.forEach((v, i) => buf.writeInt16LE(v, i * 2))
    return new Uint8Array(buf)
  }

  // 正好三帧，一次给（frameBytes 是字节数：4 = 2 个采样点）
  let out = drainNativeFrames(new Uint8Array(0), bytes([1, 2, 3, 4, 5, 6]), 4)
  check('整流一次切出全部帧', out.frames.length === 3 && out.carry.byteLength === 0)
  check('帧内容按顺序正确', [...out.frames[0], ...out.frames[2]].join(',') === '1,2,5,6')

  // 一帧拆成两段：第一段不能出帧，第二段补齐后出帧
  out = drainNativeFrames(new Uint8Array(0), bytes([7, 8, 9]).subarray(0, 2), 4)
  check('半个帧不发', out.frames.length === 0 && out.carry.byteLength === 2)
  out = drainNativeFrames(out.carry, bytes([7, 8, 9]).subarray(2), 4)
  // 跨事件边界的那一帧必须完整且采样值连续：7,8 成帧，剩下的 9 留作残留
  const rest = new Int16Array(out.carry.buffer, out.carry.byteOffset, out.carry.byteLength / 2)
  check(
    '跨事件边界的帧完整且残留正确',
    out.frames.length === 1 && out.frames[0][0] === 7 && out.frames[0][1] === 8 && rest[0] === 9,
    `frame=[${[...out.frames[0]]}] carry=[${[...rest]}]`
  )

  // 字节数不是偶数倍的残留不能被吞掉
  out = drainNativeFrames(new Uint8Array(0), bytes([1, 2, 3]).subarray(0, 5), 2)
  check('多出的字节留作残留', out.frames.length === 2 && out.carry.byteLength === 1, `carry=${out.carry.byteLength}`)

  // 帧数组之间不能共享底层 buffer
  out = drainNativeFrames(new Uint8Array(0), bytes([11, 22]), 4)
  check('切出的帧是独立副本', out.frames.length === 1 && out.frames[0].buffer.byteLength === 4)
}

async function liveTest() {
  if (process.platform !== 'darwin') {
    console.log('SKIP  实测：非 macOS')
    return
  }
  if (!helperPath) {
    console.log('SKIP  实测：未找到采集组件')
    return
  }
  const win = fakeWindow('live')
  const live = new MacSystemAudioService()
  const started = live.start(win)
  if (!started.ok) {
    console.log(`SKIP  实测：无法启动（${started.error}）`)
    return
  }

  let ready = false
  let frames = 0
  let peak = 0
  let carry = new Uint8Array(0)

  const done = new Promise((resolve) => {
    const deadline = setTimeout(resolve, 25000)
    const timer = setInterval(() => {
      for (const ev of win.events.splice(0)) {
        if (ev.channel === 'mac-system-audio:ready') ready = true
        else if (ev.channel === 'mac-system-audio:error') {
          if (!ready) {
            clearTimeout(deadline)
            clearInterval(timer)
            console.log(`SKIP  实测：组件报错（${ev.payload}）`)
            resolve()
          }
        } else if (ev.channel === 'mac-system-audio:data' && ready) {
          // 按渲染层的方式再切一次：1280 字节一帧
          const chunk = new Uint8Array(ev.payload)
          const merged = new Uint8Array(carry.byteLength + chunk.byteLength)
          merged.set(carry)
          merged.set(chunk, carry.byteLength)
          let off = 0
          while (merged.byteLength - off >= 1280) {
            const slice = merged.slice(off, off + 1280)
            off += 1280
            const pcm = new Int16Array(slice.buffer, 0, slice.byteLength / 2)
            frames++
            for (let i = 0; i < pcm.length; i++) {
              const v = Math.abs(pcm[i]) / 32768
              if (v > peak) peak = v
            }
          }
          carry = merged.slice(off)
        }
      }
      if (ready && frames > 0 && peak > 0.02) {
        clearTimeout(deadline)
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })

  // 等 ready 之后再播音，避免把「启动阶段」误当成没声音
  const waiter = setInterval(() => {
    if (!ready) return
    clearInterval(waiter)
    try {
      require('node:child_process').spawn('say', ['-v', 'Ting-Ting', '-r', '170', '系统音频采集测试'])
    } catch {
      /* 没有 say 也不影响下面的断言结论 */
    }
  }, 100)

  await done
  clearInterval(waiter)
  live.stop(false)

  check('实测：收到 ready 就绪信号', ready === true)
  check('实测：收到 16k 单声道 PCM 帧', frames > 0, `frames=${frames}`)
  check('实测：帧里有真实音频（峰值 > 0.02）', peak > 0.02, `peak=${peak.toFixed(4)}`)
  check('实测：stop 之后子进程被回收', live.child === null)
}

liveTest()
  .catch((error) => {
    check('实测：未抛异常', false, String(error && error.message ? error.message : error))
  })
  .finally(() => {
    const failed = RESULTS.filter((r) => !r.ok)
    console.log(`\n${RESULTS.length - failed.length} PASS / ${failed.length} FAIL`)
    process.exit(failed.length ? 1 : 0)
  })
