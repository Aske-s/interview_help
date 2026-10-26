/**
 * 远端（OpenAI 兼容）语音识别通道自测。
 * 运行：node src/main/asr/__selftest__/openai-compat.cjs
 *
 * 起一个按 OpenAI /v1/audio/transcriptions 规范校验请求的本地服务，
 * 断言我们发出去的请求格式是对的（路径、鉴权、multipart 字段），
 * 并覆盖错误路径。这是「远端接口写对了吗」唯一靠谱的验证方式。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
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
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getName: () => 'x' } }
  return origLoad.apply(this, [request, ...rest])
}

const { createAsrProvider } = require(path.join(ROOT, 'src/main/asr/index.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/** 从 multipart 里解析字段名与值 */
function parseMultipart(buf, boundary) {
  // Buffer 没有 split：用 latin1 把字节一一映射成字符再切，最后按需还原
  const raw = buf.toString('latin1')
  const parts = raw.split(`--${boundary}`)
  const fields = {}
  for (const part of parts) {
    const idx = part.indexOf('\r\n\r\n')
    if (idx < 0) continue
    const head = part.slice(0, idx)
    const body = part.slice(idx + 4)
    const nameMatch = /name="([^"]+)"/.exec(head)
    if (!nameMatch) continue
    const filenameMatch = /filename="([^"]+)"/.exec(head)
    const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(head)
    fields[nameMatch[1]] = {
      value: Buffer.from(body, 'latin1').toString('utf8').replace(/\r?\n$/, ''),
      bytes: body.length,
      filename: filenameMatch?.[1],
      contentType: contentTypeMatch?.[1]
    }
  }
  return fields
}

/** 严格校验 OpenAI 规范的 mock 服务 */
function startMock() {
  const state = { requests: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const ct = req.headers['content-type'] ?? ''
      const boundary = /boundary=(.+)$/.exec(ct)?.[1]
      const fields = boundary ? parseMultipart(body, boundary) : {}
      const record = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        contentType: ct,
        fields
      }
      state.requests.push(record)

      // 让 mock 能被指定返回错误
      if (state.failWith) {
        res.writeHead(state.failWith, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock failure' } }))
        return
      }
      // 规范要求返回 JSON（因为客户端 request_format=json）
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '这是远端识别的结果' }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port
      state.close = () => new Promise((r) => server.close(r))
      resolve(state)
    })
  })
}

async function main() {
  const mock = await startMock()
  const base = `http://127.0.0.1:${mock.port}`

  const cfg = {
    kind: 'openai-compat',
    baseUrl: `${base}/v1`,
    apiKey: 'sk-test-key',
    model: 'whisper-1',
    language: 'zh',
    binaryPath: '',
    modelPath: '',
    extraArgs: '',
    serverUrl: '',
    autoStartServer: false,
    serverBinaryPath: '',
    vadModelPath: '',
    vadSilenceMs: 800,
    vadThreshold: 0.5
  }

  /* ---------- 正常路径 ---------- */
  const p = createAsrProvider(cfg)
  check('通道类型正确', p.kind === 'openai-compat', p.kind)

  const pcm = Buffer.alloc(16000 * 1 * 2) // 1 秒
  const text = await p.transcribe(pcm, { language: 'zh', hotwords: ['多模态', 'Transformer'] })
  check('返回文本正确解析', text === '这是远端识别的结果', JSON.stringify(text))

  const req0 = mock.requests.at(-1)
  check('请求方法为 POST', req0.method === 'POST', req0.method)
  check('路径为 /v1/audio/transcriptions', req0.url === '/v1/audio/transcriptions', req0.url)
  check('带上 Bearer 鉴权', req0.auth === 'Bearer sk-test-key', String(req0.auth))
  check('Content-Type 为 multipart/form-data', /multipart\/form-data/.test(req0.contentType), req0.contentType)
  check('包含 file 字段', Boolean(req0.fields.file), Object.keys(req0.fields).join(','))
  check('file 有文件名', req0.fields.file?.filename === 'audio.wav', String(req0.fields.file?.filename))
  check('file 的 Content-Type 为 audio/wav', req0.fields.file?.contentType === 'audio/wav', String(req0.fields.file?.contentType))
  check('file 是 WAV 容器（含 RIFF 头）', req0.fields.file?.value?.startsWith('RIFF'), req0.fields.file?.value?.slice(0, 4))
  check('包含 model 字段', req0.fields.model?.value === 'whisper-1', String(req0.fields.model?.value))
  check('包含 language 字段', req0.fields.language?.value === 'zh', String(req0.fields.language?.value))
  check('包含 response_format=json', req0.fields.response_format?.value === 'json', String(req0.fields.response_format?.value))
  check('热词传入 prompt', (req0.fields.prompt?.value ?? '').includes('多模态'), String(req0.fields.prompt?.value))

  /* ---------- 完整端点直接填写 ---------- */
  const p2 = createAsrProvider({ ...cfg, baseUrl: `${base}/v1/audio/transcriptions` })
  await p2.transcribe(pcm)
  check('baseUrl 已是完整端点时不重复拼接', mock.requests.at(-1).url === '/v1/audio/transcriptions', mock.requests.at(-1).url)

  /* ---------- 尾部斜杠 ---------- */
  const p3 = createAsrProvider({ ...cfg, baseUrl: `${base}/v1/` })
  await p3.transcribe(pcm)
  check('baseUrl 带尾斜杠时路径正确', mock.requests.at(-1).url === '/v1/audio/transcriptions', mock.requests.at(-1).url)

  /* ---------- language=auto 不应发送 language ---------- */
  const p4 = createAsrProvider({ ...cfg, language: 'auto' })
  await p4.transcribe(pcm)
  check('语言为自动时不发送 language 字段', mock.requests.at(-1).fields.language === undefined, JSON.stringify(Object.keys(mock.requests.at(-1).fields)))

  /* ---------- 无 apiKey 时不带鉴权头 ---------- */
  const p5 = createAsrProvider({ ...cfg, apiKey: '' })
  await p5.transcribe(pcm)
  check('未配置密钥时不带 Authorization', mock.requests.at(-1).auth === undefined, String(mock.requests.at(-1).auth))

  /* ---------- 错误路径 ---------- */
  mock.failWith = 401
  let err = ''
  try {
    await p5.transcribe(pcm)
  } catch (e) {
    err = e.message
  }
  check('服务端报错时抛出可读错误', /401/.test(err), err.slice(0, 60))
  mock.failWith = null

  /* ---------- 探针 ---------- */
  const health = await p.test()
  check('测试连接：可达时返回 ok', health.ok === true, health.message)

  /* ---------- 未配置地址/模型要明确报错 ---------- */
  let e1 = ''
  try {
    await createAsrProvider({ ...cfg, baseUrl: '' }).transcribe(pcm)
  } catch (e) {
    e1 = e.message
  }
  check('未配置地址：明确报错', /网关地址/.test(e1), e1)
  let e2 = ''
  try {
    await createAsrProvider({ ...cfg, model: '' }).transcribe(pcm)
  } catch (e) {
    e2 = e.message
  }
  check('未配置模型：明确报错', /模型名/.test(e2), e2)

  /* ---------- 过短音频不应发起请求 ---------- */
  const before = mock.requests.length
  await createAsrProvider(cfg).transcribe(Buffer.alloc(100))
  check('过短音频短路（不发请求）', mock.requests.length === before)

  await mock.close()
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e)
  process.exit(1)
})
