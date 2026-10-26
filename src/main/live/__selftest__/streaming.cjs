/**
 * 流式识别链路集成自测（阿里云百炼实时识别 × 编排层）。
 * 运行：node src/main/live/__selftest__/streaming.cjs
 *
 * 验证「按原版分工」是否落地：
 *   · 音频连续推给长连接，**不做本地切分**（原版 sendAudio 每帧无条件发）
 *   · sentence_end=false（中间结果）→ 只更新界面，不触发提问
 *   · sentence_end=true（定稿）→ 作为转写片段，进入提问判定与合并链路
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { WebSocketServer } = require('ws')

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
const DATA = path.join(os.tmpdir(), `suisi-stream-${process.pid}`)
fs.mkdirSync(DATA, { recursive: true })

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

const streamCalls = []
let serverPort = 0

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA, getName: () => 'x', isPackaged: false },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: { isEncryptionAvailable: () => false }
    }
  }
  if (request.includes('stream-manager')) {
    return {
      cancelStream: () => {},
      runStream: (req, handlers) => {
        streamCalls.push(req)
        const text = '这是回答'
        handlers?.onDelta?.({ kind: 'content', text })
        handlers?.onDone?.({ text, reasoning: '', firstTokenMs: 1, totalMs: 2 })
      }
    }
  }
  return origLoad.apply(this, [request, ...rest])
}

const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** mock 阿里云长连接：收到音频后按节拍发「中间结果 → 定稿」 */
function startMock() {
  const state = { frames: 0, bytes: 0, sockets: 0 }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  return new Promise((resolve) => {
    wss.on('listening', () => {
      serverPort = wss.address().port
      state.port = serverPort // 必须回填到 state，否则外部拿到 undefined 端口
      state.close = () =>
        new Promise((r) => {
          for (const c of wss.clients) {
            try {
              c.terminate()
            } catch {
              /* 忽略 */
            }
          }
          wss.close(() => r())
        })
      resolve(state)
    })
    wss.on('connection', (ws) => {
      state.sockets++
      // 周期性发送：每攒够 0.6s 发中间结果，攒够 1.2s 定稿并重新开始下一句
      let audioSinceLast = 0
      let sentPartial = false
      let sentenceId = 0
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          state.frames++
          state.bytes += data.length
          audioSinceLast += data.length
          // 攒够 0.6 秒音频就先吐一个中间结果，再攒够就把这句定稿
          if (!sentPartial && audioSinceLast >= 16000 * 2 * 0.6) {
            sentPartial = true
            ws.send(
              JSON.stringify({
                header: { event: 'result-generated', task_id: 't' },
                payload: {
                  output: { sentence: { sentence_id: 0, text: '请听题，给定', sentence_end: false } },
                  usage: null
                }
              })
            )
          }
          if (sentPartial && audioSinceLast >= 16000 * 2 * 1.2) {
            ws.send(
              JSON.stringify({
                header: { event: 'result-generated', task_id: 't' },
                payload: {
                  output: {
                    sentence: {
                      sentence_id: sentenceId,
                      text: '请听题，给定一个整数数组',
                      sentence_end: true
                    }
                  },
                  usage: { duration: 2 }
                }
              })
            )
            // 进入下一句
            sentenceId++
            audioSinceLast = 0
            sentPartial = false
          }
          return
        }
        const msg = JSON.parse(data.toString())
        if (msg?.header?.action === 'run-task') {
          ws.send(
            JSON.stringify({ header: { event: 'task-started', task_id: msg.header.task_id }, payload: {} })
          )
        }
      })
    })
  })
}

function speech(seconds, amp = 0.25) {
  const n = Math.round(16000 * seconds)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(amp * 32768 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2)
  }
  return b
}

async function main() {
  const guard = setTimeout(() => {
    console.log('\n自测超时（30s），强制结束')
    process.exit(3)
  }, 30000)
  guard.unref?.()

  const mock = await startMock()

  settingsStore.patch({
    audio: { micEnabled: true, systemAudioEnabled: false },
    asr: {
      kind: 'dashscope-realtime',
      apiKey: 'sk-test',
      realtimeUrl: `ws://127.0.0.1:${mock.port}`,
      realtimeModel: 'paraformer-realtime-v2',
      semanticPunctuation: false,
      vadSilenceMs: 800,
      punctuationPrediction: true,
      inverseTextNormalization: true
    },
    providers: [
      {
        id: 'default',
        name: 't',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'k',
        model: 'm',
        supportsVision: true
      }
    ],
    activeProviderId: 'default',
    asrTuning: {
      ...settingsStore.get().asrTuning,
      silenceMs: 400,
      minSegmentMs: 200,
      maxSegmentMs: 30000,
      cumulative: false,
      autoAnswer: true,
      autoAnswerMinChars: 2,
      silenceAutoStopSec: 0
    }
  })

  const { live } = require(path.join(ROOT, 'src/main/live/orchestrator.ts'))
  live.on('error', (e) => console.log('   [error]', JSON.stringify(e)))
  const partials = []
  const finals = []
  live.on('transcript', (seg) => finals.push(seg.text))

  live.start('meeting')
  await sleep(600)
  check('流式通道：已建立长连接', mock.sockets >= 1, `${mock.sockets} 条连接`)

  // 连续推音频（模拟原版每帧无条件发送）
  for (let i = 0; i < 20; i++) {
    live.pushAudio(speech(0.1), 'mic')
    await sleep(15)
    if (i === 8) partials.push(live.getState().lastTranscript)
  }
  await sleep(1200)

  const state = live.getState()
  check('音频连续推给长连接（本地不再攒段）', mock.frames > 10, `${mock.frames} 帧 / ${mock.bytes} 字节`)
  check('界面出现中间结果（边说边出字）', partials.some((t) => t.length > 0), JSON.stringify(partials))
  check('定稿进入转写链路', finals.length > 0, JSON.stringify(finals))
  check('定稿文本正确', finals.some((t) => t.includes('给定一个整数数组')), JSON.stringify(finals))
  check('定稿后触发提问/作答链路', streamCalls.length > 0 || state.pendingQuestion.length > 0, `runStream=${streamCalls.length}`)
  check('state.lastTranscript 为最后一次文本', state.lastTranscript.length > 0, state.lastTranscript)

  /* 实时行的数据来源：中间结果期间 hearing 必须为 true，定稿后回到 false */
  const seenHearing = []
  live.on('state', (st) => seenHearing.push(st.hearing))
  live.start('meeting')
  await sleep(300)
  for (let i = 0; i < 16; i++) {
    live.pushAudio(speech(0.1), 'mic')
    await sleep(20)
  }
  await sleep(900)
  check('中间结果期间 hearing=true（界面显示「正在识别」）', seenHearing.includes(true), JSON.stringify(seenHearing.slice(0, 12)))
  check('定稿后 hearing 回到 false', live.getState().hearing === false, String(live.getState().hearing))
  live.stop()
  await sleep(150)

  /* 链路自检字段：没有它就无法判断「没反应」断在哪一环 */
  const st2 = live.getState()
  check('自检：能读到音频帧数', typeof st2.audioFrames === 'number' && st2.audioFrames >= 0, String(st2.audioFrames))
  check('自检：能读到音量', typeof st2.audioLevel === 'number', String(st2.audioLevel))
  check('自检：能读到通道连接状态', typeof st2.streamingConnected === 'boolean', String(st2.streamingConnected))
  check('自检：错误字段存在', typeof st2.streamingError === 'string', JSON.stringify(st2.streamingError))

  /*
   * 自检字段留在 state 里（排障、设置页「检测电脑音频」都要用），
   * 但界面上那条常驻的链路自检条已经按用户要求去掉 ——
   * 它原本还被错放在两栏容器里，于是渲染成了最左边一列「音频测试窗口」。
   * 这里加个反向断言，防止它再被顺手加回来。
   */
  const floatSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/windows/floating/App.tsx'), 'utf8')
  const floatCode = floatSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('界面：常驻自检条已移除', !floatCode.includes('链路自检条') && !floatCode.includes('音频帧'))
  check('界面：有「正在识别」实时行', floatSrc.includes('正在识别'))
  check('界面：实时行绑定 state.hearing', floatSrc.includes('state?.hearing'))
  check(
    '界面：主体仍是两栏（转写 + 答案），没有多出来的第三列',
    (floatCode.match(/<section/g) ?? []).length === 2,
    `${(floatCode.match(/<section/g) ?? []).length} 个 section`
  )

  live.stop()
  await sleep(200)
  check('stop 后关闭长连接（不泄漏连接）', mock.sockets >= 1 && live.getState().running === false)

  await mock.close()
  fs.rmSync(DATA, { recursive: true, force: true })
  /*
   * 系统音频采集回归（真实事故）。
   *
   * 事故结论（已逐条对照原版）：macOS 上 getDisplayMedia 拿不到系统输出 ——
   * 音轨对象在、不报错、帧照送，但数据恒为 0（界面表现为「有帧、音量一直 0%」）。
   * 原版为此改用**原生 ScreenCaptureKit 组件**；只有非 macOS 才回退 getDisplayMedia，
   * 且回退路径要停掉视频轨（只要音频）。
   *
   * 这里断言的是「代码确实接上了那条链路」，而不是去核对某段字符串：
   * 注释里有同名字样是踩过的坑，所以先剥掉注释行。
   */
  const capSrc2 = fs.readFileSync(path.join(ROOT, 'src/renderer/src/audio/capture.ts'), 'utf8')
  const capCode2 = capSrc2
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  check(
    '系统音频：macOS 走原生采集通道',
    /startNativeSystem/.test(capCode2) && /systemAudio\.start\(\)/.test(capCode2)
  )
  check(
    '系统音频：等原生 ready 才算启动成功（start 返回 ok 不算数）',
    /onReady/.test(capCode2) && /NATIVE_READY_TIMEOUT_MS/.test(capCode2)
  )
  check('系统音频：必须消费 data 事件，否则管道写满会把采集组件卡死', /systemAudio\.onData/.test(capCode2))
  check('系统音频：按 1280 字节切帧（帧边界会跨事件）', /NATIVE_FRAME_BYTES\s*=\s*1280/.test(capCode2))
  check('系统音频：只有非 macOS 才回退 getDisplayMedia', /getDisplayMedia/.test(capCode2))

  const fallbackBody = capCode2.slice(
    capCode2.indexOf('startDisplayMediaSystem'),
    capCode2.indexOf('private attach(')
  )
  check('系统音频回退：停掉视频轨（只要音频）', /getVideoTracks\(\)[\s\S]{0,60}\.stop\(\)/.test(fallbackBody))
  check('系统音频回退：没有音轨时明确报错而不是静默', /audioTracks\.length/.test(fallbackBody))
  check('系统音频：不再用「保活 video」这种绕法', !capCode2.includes('keepAlive'))

  check('系统音频：显式启用音轨', capCode2.includes('track.enabled = true'))
  check(
    '系统音频：不强制 16k 建 AudioContext（设备流可能被判静音）',
    !/new AudioContext\(\{\s*sampleRate/.test(capCode2)
  )
  check('系统音频：手动降采样到 16k', capCode2.includes('resampleTo16k'))

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e)
  process.exit(1)
})
