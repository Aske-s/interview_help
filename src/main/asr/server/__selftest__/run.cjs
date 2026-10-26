/**
 * whisper-server 生命周期自测。
 *
 * 运行：node src/main/asr/server/__selftest__/run.cjs
 *
 * 重点契约：
 *  · 服务已在跑 → 不再拉起（避免端口冲突 / 抢用户手动启动的实例）
 *  · 未开自动启动 → 明确报错，不偷偷启动
 *  · 没配模型路径 → 明确报错
 *  · 退出时只关「自己拉起的」进程，不误杀用户手动开的
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
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getName: () => 'x' } }
  return origLoad.apply(this, [request, ...rest])
}

const server = require(path.join(ROOT, 'src/main/asr/server.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const baseCfg = {
  kind: 'whisper-server',
  baseUrl: '',
  apiKey: '',
  model: 'small',
  language: 'zh',
  binaryPath: '',
  modelPath: '',
  extraArgs: '',
  serverUrl: 'http://127.0.0.1:8199', // 用一个没人占的端口，避免影响真实服务
  autoStartServer: false,
  serverBinaryPath: ''
}

async function main() {
  /* 1. 服务没跑 + 未开自动启动 → 明确失败，不偷偷启动 */
  server.__resetForTest()
  let r = await server.ensureServer({ ...baseCfg, autoStartServer: false }, 3000)
  check('未运行且未开自动启动：返回失败', r.ok === false && r.started === false, r.message)
  check('未运行且未开自动启动：提示可读中文', /未运行|未开启自动启动/.test(r.message), r.message)
  check('未运行且未开自动启动：没有拉起进程', server.isOwned() === false)

  /* 2. 开了自动启动但没配模型路径 → 明确报错 */
  r = await server.ensureServer({ ...baseCfg, autoStartServer: true, modelPath: '' }, 3000)
  check('未配模型路径：返回失败', r.ok === false, r.message)
  check('未配模型路径：提示提到模型', /模型文件路径/.test(r.message), r.message)

  /* 3. 服务已在跑 → 不再拉起 */
  // 临时起一个最小 HTTP 服务模拟 whisper-server
  const http = require('node:http')
  const mock = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html>whisper.cpp server</html>')
  })
  await new Promise((resolve) => mock.listen(8199, '127.0.0.1', resolve))
  try {
    server.__resetForTest()
    r = await server.ensureServer({ ...baseCfg, autoStartServer: true, modelPath: '/tmp/x.bin' }, 5000)
    check('服务已在运行：直接复用', r.ok === true && r.started === false, r.message)
    check('服务已在运行：不认为进程是自己拉起的', server.isOwned() === false)
    check('isServerUp 能探到服务', (await server.isServerUp('http://127.0.0.1:8199')) === true)
  } finally {
    await new Promise((resolve) => mock.close(resolve))
  }

  /* 4. 端口关掉后探测为 false */
  check('服务关闭后探测为 false', (await server.isServerUp('http://127.0.0.1:8199', 800)) === false)

  /* 5. 没拉起任何进程时 stopServer 不报错（幂等） */
  let threw = false
  try {
    server.stopServer()
    server.stopServer()
  } catch {
    threw = true
  }
  check('未持有进程时 stopServer 幂等且不抛异常', threw === false)

  /* 6. 非法 URL 不应崩 */
  r = await server.ensureServer({ ...baseCfg, serverUrl: 'not-a-url', autoStartServer: false }, 2000)
  check('非法服务地址：不崩且返回失败', r.ok === false, r.message)

  const failed = RESULTS.filter((x) => !x.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
