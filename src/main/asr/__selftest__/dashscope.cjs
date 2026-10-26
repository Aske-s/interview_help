/**
 * 阿里云百炼 Paraformer 实时识别通道自测。
 * 运行：node src/main/asr/__selftest__/dashscope.cjs
 *
 * 起一个按官方文档应答的 mock WebSocket 服务，逐条校验我们发出去的协议：
 *   · run-task 的字段与参数（含 max_sentence_silence 只在 VAD 断开模式下出现）
 *   · 必须等 task-started 之后才发音频
 *   · 音频按 100ms 分帧
 *   · result-generated 的增量/定稿/心跳处理
 *   · finish-task → task-finished，以及 task-failed 的错误透出
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
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getName: () => 'x' } }
  return origLoad.apply(this, [request, ...rest])
}

const { DashScopeRealtimeSession, DASHSCOPE_DEFAULTS } = require(path.join(ROOT, 'src/main/asr/dashscope.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * mock 服务端：按文档应答。
 * behavior 可控制：是否报错、是否插心跳、是否发中间结果。
 */
function startMock(behavior = {}) {
  const state = {
    runTask: null,
    auth: null,
    audioFrames: 0,
    audioBytes: 0,
    bytesBeforeStarted: 0,
    gotFinish: false,
    started: false
  }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  return new Promise((resolve) => {
    wss.on('listening', () => {
      state.port = wss.address().port
      // wss.close() 会等所有客户端断开；先主动 terminate，否则测试会挂住
      state.close = () =>
        new Promise((r) => {
          for (const client of wss.clients) {
            try {
              client.terminate()
            } catch {
              /* 忽略 */
            }
          }
          wss.close(() => r())
        })
      resolve(state)
    })
    wss.on('connection', (ws, req) => {
      state.auth = req.headers.authorization
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          if (!state.started) state.bytesBeforeStarted += data.length
          state.audioFrames++
          state.audioBytes += data.length
          return
        }
        const msg = JSON.parse(data.toString())
        const action = msg?.header?.action
        if (action === 'run-task') {
          state.runTask = msg
          if (behavior.failWith) {
            ws.send(
              JSON.stringify({
                header: {
                  task_id: msg.header.task_id,
                  event: 'task-failed',
                  error_code: behavior.failWith.code,
                  error_message: behavior.failWith.message,
                  attributes: {}
                },
                payload: {}
              })
            )
            return
          }
          // 收到足够音频后再回结果，模拟真实服务端
          state.started = true
          ws.send(
            JSON.stringify({
              header: { task_id: msg.header.task_id, event: 'task-started', attributes: {} },
              payload: {}
            })
          )
        } else if (action === 'finish-task') {
          state.gotFinish = true
          const taskId = msg.header.task_id
          // 中间结果（sentence_end=false）
          ws.send(
            JSON.stringify({
              header: { task_id: taskId, event: 'result-generated', attributes: {} },
              payload: {
                output: { sentence: { begin_time: 0, end_time: null, text: '请听题', sentence_end: false } },
                usage: null
              }
            })
          )
          // 心跳包：应被跳过
          ws.send(
            JSON.stringify({
              header: { task_id: taskId, event: 'result-generated', attributes: {} },
              payload: {
                output: {
                  sentence: { begin_time: 0, end_time: 0, text: '', sentence_end: false, heartbeat: true }
                },
                usage: null
              }
            })
          )
          // 最终结果（sentence_end=true）
          ws.send(
            JSON.stringify({
              header: { task_id: taskId, event: 'result-generated', attributes: {} },
              payload: {
                output: {
                  sentence: {
                    sentence_id: 0,
                    begin_time: 0,
                    end_time: 1200,
                    text: '请听题，给定一个整数数组',
                    sentence_end: true
                  }
                },
                usage: { duration: 2 }
              }
            })
          )
          ws.send(
            JSON.stringify({
              header: { task_id: taskId, event: 'task-finished', attributes: {} },
              payload: { output: {}, usage: null }
            })
          )
        }
      })
    })
  })
}

const baseCfg = {
  kind: 'dashscope-realtime',
  baseUrl: '',
  apiKey: 'sk-dashscope-test',
  model: '',
  language: 'zh',
  binaryPath: '',
  modelPath: '',
  extraArgs: '',
  serverUrl: '',
  autoStartServer: false,
  serverBinaryPath: '',
  vadModelPath: '',
  vadSilenceMs: 800,
  vadThreshold: 0.5,
  realtimeUrl: '',
  realtimeModel: 'paraformer-realtime-v2',
  semanticPunctuation: false,
  punctuationPrediction: true,
  inverseTextNormalization: true
}

async function main() {
  // 兜底：任何原因卡住都不要挂死（曾经因为 mock 服务未关闭而挂住过）
  const guard = setTimeout(() => {
    console.log('\n自测超时（30s），强制结束')
    process.exit(3)
  }, 30000)
  guard.unref?.()

  check('默认端点为官方地址', DASHSCOPE_DEFAULTS.endpoint === 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', DASHSCOPE_DEFAULTS.endpoint)
  check('分帧为 100ms', DASHSCOPE_DEFAULTS.frameBytes === 16000 * 2 * 0.1, String(DASHSCOPE_DEFAULTS.frameBytes))

  /* ---------- 正常流程 ---------- */
  const mock = await startMock()
  const partials = []
  const finals = []
  let started = false
  let finished = false

  const session = new DashScopeRealtimeSession(
    { ...baseCfg, realtimeUrl: `ws://127.0.0.1:${mock.port}` },
    {
      onStarted: () => (started = true),
      onPartial: (t) => partials.push(t),
      onFinal: (t) => finals.push(t),
      onFinished: () => (finished = true)
    }
  )

  await session.start()
  check('收到 task-started 后进入就绪态', started === true)

  // 开始就推音频：验证「未就绪先缓存、就绪后补发」
  const pcm = Buffer.alloc(16000 * 2 * 0.5) // 0.5 秒 → 期望 5 帧
  session.push(pcm)
  await sleep(300)

  const rt = mock.runTask
  check('发送 run-task', Boolean(rt), JSON.stringify(rt?.header))
  check('header.action=run-task', rt.header.action === 'run-task')
  check('header.streaming=duplex', rt.header.streaming === 'duplex')
  check('task_id 为 UUID', /^[0-9a-f-]{36}$/.test(rt.header.task_id), rt.header.task_id)
  check('payload.task_group=audio', rt.payload.task_group === 'audio')
  check('payload.task=asr', rt.payload.task === 'asr')
  check('payload.function=recognition', rt.payload.function === 'recognition')
  check('model 默认 paraformer-realtime-v2', rt.payload.model === 'paraformer-realtime-v2', rt.payload.model)
  check('input 为空对象', JSON.stringify(rt.payload.input) === '{}')
  const p = rt.payload.parameters
  check('format=pcm', p.format === 'pcm', p.format)
  check('sample_rate=16000', p.sample_rate === 16000, String(p.sample_rate))
  check('language_hints=[zh]', JSON.stringify(p.language_hints) === '["zh"]', JSON.stringify(p.language_hints))
  check('VAD 模式：semantic_punctuation_enabled=false', p.semantic_punctuation_enabled === false)
  check('VAD 模式：max_sentence_silence=800（对齐原版）', p.max_sentence_silence === 800, String(p.max_sentence_silence))
  check('标点恢复开启', p.punctuation_prediction_enabled === true)
  check('逆文本正则化开启', p.inverse_text_normalization_enabled === true)
  check('心跳保活开启', p.heartbeat === true)
  check('带 Bearer 鉴权', /^bearer sk-dashscope-test$/.test(String(mock.auth)), String(mock.auth))

  check('音频已按帧发送', mock.audioFrames === 5, `${mock.audioFrames} 帧`)
  check('就绪前未抢发音频（等 task-started）', mock.bytesBeforeStarted === 0, `${mock.bytesBeforeStarted} 字节`)

  await session.finish(3000)
  check('发送了 finish-task', mock.gotFinish === true)
  check('收到 task-finished', finished === true)
  check('中间结果已透出（sentence_end=false）', partials.includes('请听题'), JSON.stringify(partials))
  check('最终结果已透出（sentence_end=true）', finals.includes('请听题，给定一个整数数组'), JSON.stringify(finals))
  check('心跳包被跳过（未产生空结果）', !partials.includes('') && !finals.includes(''))
  check('定稿文本可读取', session.text === '请听题，给定一个整数数组', session.text)
  session.close()
  await mock.close()

  /* ---------- 语义断句模式下不应出现 max_sentence_silence ---------- */
  const mock2 = await startMock()
  const s2 = new DashScopeRealtimeSession(
    { ...baseCfg, realtimeUrl: `ws://127.0.0.1:${mock2.port}`, semanticPunctuation: true },
    {}
  )
  await s2.start()
  await sleep(120)
  const p2 = mock2.runTask.payload.parameters
  check('语义断句：semantic_punctuation_enabled=true', p2.semantic_punctuation_enabled === true)
  check(
    '语义断句：不发送 max_sentence_silence（文档：仅 VAD 模式生效）',
    p2.max_sentence_silence === undefined,
    String(p2.max_sentence_silence)
  )
  s2.close()
  await mock2.close()

  /* ---------- 语言为自动时不发 language_hints ---------- */
  const mock3 = await startMock()
  const s3 = new DashScopeRealtimeSession(
    { ...baseCfg, realtimeUrl: `ws://127.0.0.1:${mock3.port}`, language: 'auto' },
    {}
  )
  await s3.start()
  await sleep(120)
  check('语言自动：不发送 language_hints', mock3.runTask.payload.parameters.language_hints === undefined)
  s3.close()
  await mock3.close()

  /* ---------- max_sentence_silence 超范围要夹紧 ---------- */
  const mock4 = await startMock()
  const s4 = new DashScopeRealtimeSession(
    { ...baseCfg, realtimeUrl: `ws://127.0.0.1:${mock4.port}`, vadSilenceMs: 99999 },
    {}
  )
  await s4.start()
  await sleep(120)
  check('静音阈值超上限：夹到 6000', mock4.runTask.payload.parameters.max_sentence_silence === 6000, String(mock4.runTask.payload.parameters.max_sentence_silence))
  s4.close()
  await mock4.close()

  /* ---------- task-failed 要透出错误 ---------- */
  const mock5 = await startMock({ failWith: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' } })
  let errMsg = ''
  try {
    const s5 = new DashScopeRealtimeSession({ ...baseCfg, realtimeUrl: `ws://127.0.0.1:${mock5.port}` }, {})
    await s5.start()
    s5.close()
  } catch (e) {
    errMsg = e.message
  }
  check('task-failed：抛出可读错误', /InvalidApiKey/.test(errMsg) && /Invalid API-key/.test(errMsg), errMsg)
  await mock5.close()

  /* ---------- 未配置 Key 要明确报错 ---------- */
  let e2 = ''
  try {
    await new DashScopeRealtimeSession({ ...baseCfg, apiKey: '' }, {}).start()
  } catch (e) {
    e2 = e.message
  }
  check('未配置 Key：明确报错', /API Key/.test(e2), e2)

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e)
  process.exit(1)
})
