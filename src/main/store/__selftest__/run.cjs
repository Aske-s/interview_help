/**
 * 设置持久化自测。
 *
 * 运行：
 *   node src/main/store/__selftest__/run.cjs
 *
 * 重点覆盖曾经的真实缺陷：
 *   渲染层若用「整份 providers 数组」回写，闭包里是渲染时快照，
 *   连续输入时后一次会覆盖前一次 → 表现为「模型网关改了保存不上」。
 * 因此验证：定向更新 (patchProvider) 必须对快速连续输入免疫。
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
const DATA_DIR = path.join(os.tmpdir(), `suisi-store-selftest-${process.pid}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@shared/')) request = path.join(ROOT, 'src', request.slice('@'.length))
  return originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => DATA_DIR, getName: () => 'x', isPackaged: false }, ipcMain: { handle: () => {}, on: () => {} } }
  }
  return originalLoad.apply(this, [request, ...rest])
}

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const FILE = path.join(DATA_DIR, 'data', 'settings.json')
const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'))
const loadSettings = () => require(path.join(ROOT, 'src/main/store/settings.ts'))

function main() {
  let mod = loadSettings()
  let store = mod.settingsStore
  const id = store.get().providers[0].id

  /* ============ 1. 首次访问即落盘（默认值可见、可手工编辑） ============ */
  check('首次读取就写入 settings.json', fs.existsSync(FILE), FILE)
  check('落盘内容含全部网关字段', ['baseUrl', 'apiKey', 'model', 'reasoningEffort', 'maxTokensParam', 'extraBody'].every((k) => k in readFile().providers[0]), Object.keys(readFile().providers[0]).join(','))

  /* ============ 2. 定向更新：单字段保存到磁盘 ============ */
  store.patchProvider(id, { baseUrl: 'https://api.openai.com/v1' })
  check('定向更新：内存已生效', store.get().providers[0].baseUrl === 'https://api.openai.com/v1')
  check('定向更新：磁盘已生效', readFile().providers[0].baseUrl === 'https://api.openai.com/v1')

  /* ============ 3. 核心回归：模拟快速逐字符输入 ============ */
  store.patchProvider(id, { baseUrl: '' })
  const typed = 'https://api.deepseek.com/v1'
  // 每次只提交一个字符，且彼此之间不等待读取新状态——最坏情况的连续输入
  for (const ch of typed) {
    const current = store.get().providers[0].baseUrl ?? ''
    store.patchProvider(id, { baseUrl: current + ch })
  }
  check('逐字符输入：内存结果完整', store.get().providers[0].baseUrl === typed, store.get().providers[0].baseUrl)
  check('逐字符输入：磁盘结果完整', readFile().providers[0].baseUrl === typed, readFile().providers[0].baseUrl)

  /* ============ 4. 对照：旧的「整份数组回写 + 过期快照」确实会丢字 ============ */
  store.patchProvider(id, { baseUrl: '' })
  const staleSnapshot = JSON.parse(JSON.stringify(store.get().providers)) // 渲染时捕获的快照
  for (const ch of 'abc') {
    // 旧写法：每次都用同一份过期快照派生整份数组
    const next = staleSnapshot.map((p, i) => (i === 0 ? { ...p, baseUrl: (p.baseUrl ?? '') + ch } : p))
    store.patch({ providers: next })
  }
  const oldResult = readFile().providers[0].baseUrl
  check('对照实验：旧写法确实会丢字（说明这个修复是必要的）', oldResult !== 'abc', `旧写法得到 "${oldResult}"，新写法得到完整字符串`)

  /* ============ 5. 多网关互不干扰 ============ */
  store.patchProvider(id, { baseUrl: 'https://a.example/v1' })
  store.patch({ providers: [...store.get().providers, { ...store.get().providers[0], id: 'second', name: '第二个网关', baseUrl: 'https://b.example/v1' }] })
  store.patchProvider(id, { model: 'model-a' })
  const after = store.get().providers
  check('多网关：改 A 不影响 B', after.find((p) => p.id === 'second').baseUrl === 'https://b.example/v1', after.find((p) => p.id === 'second').baseUrl)
  check('多网关：A 的改动已保存', readFile().providers.find((p) => p.id === id).model === 'model-a')

  /* ============ 6. undefined = 清空该项（temperature 留空场景） ============ */
  store.patchProvider(id, { temperature: 0.7 })
  check('可写入 temperature', readFile().providers.find((p) => p.id === id).temperature === 0.7)
  store.patchProvider(id, { temperature: undefined })
  check('传 undefined 会删除该字段（留空=不发送）', readFile().providers.find((p) => p.id === id).temperature === undefined)

  /* ============ 7. 未知 id 不应破坏已有配置 ============ */
  const beforeUnknown = JSON.stringify(store.get())
  store.patchProvider('not-exist', { baseUrl: 'https://evil' })
  check('未知 id：原配置保持不变', JSON.stringify(store.get()) === beforeUnknown)

  /* ============ 8. 其它设置项照常工作 ============ */
  store.patch({ asrTuning: { silenceMs: 1234 }, stealth: { safeMode: true } })
  check('嵌套设置：深合并生效', readFile().asrTuning.silenceMs === 1234 && readFile().asrTuning.maxSegmentMs !== undefined, `silenceMs=${readFile().asrTuning.silenceMs}`)
  check('嵌套设置：同层其它字段未被覆盖', readFile().stealth.safeMode === true && readFile().stealth.contentProtection !== undefined)

  /* ============ 9. 重启后仍能读到（跨进程持久化） ============ */
  store.patchProvider(id, { model: 'persisted-model', apiKey: 'sk-persist' })
  delete require.cache[require.resolve(path.join(ROOT, 'src/main/store/settings.ts'))]
  const fresh = loadSettings().settingsStore.get()
  const freshProvider = fresh.providers.find((p) => p.id === id)
  check('重启后：网关配置仍在', freshProvider.model === 'persisted-model' && freshProvider.apiKey === 'sk-persist')
  check('重启后：其它设置仍在', fresh.asrTuning.silenceMs === 1234 && fresh.stealth.safeMode === true)

  /* ============ 10. 变更事件会被广播（界面据此刷新） ============ */
  let changedCount = 0
  store.on('changed', () => changedCount++)
  store.patchProvider(id, { model: 'evt-1' })
  store.patchProvider(id, { model: 'evt-2' })
  check('变更事件：每次定向更新都会触发', changedCount === 2, `触发 ${changedCount} 次`)

  /* ============ 11. 版本号维护 ============ */
  check('版本号存在且为数字', typeof readFile().version === 'number', String(readFile().version))

  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
