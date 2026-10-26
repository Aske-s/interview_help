/**
 * 内容保护与标题伪装自测（对齐原版 CaptureProtectionRegistry）。
 *
 * 运行：node src/main/security/__selftest__/run.cjs
 *
 * 为什么重要：原版防识别靠的是 setContentProtection 持续有效。
 * macOS 会在窗口重新显示 / 缩放 / 进出全屏后把保护重置，
 * 「开一次就不管」会导致屏幕共享时偶发看到随思——这正是原版要包装 show 的原因。
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
const DATA = path.join(os.tmpdir(), `suisi-sec-${process.pid}`)
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

/* ---- 可控的窗口桩：记录 setContentProtection 调用，支持触发事件 ---- */
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => DATA, getName: () => 'x', isPackaged: false }, ipcMain: { handle: () => {} } }
  }
  return originalLoad.apply(this, [request, ...rest])
}

const protection = require(path.join(ROOT, 'src/main/security/protection.ts'))
const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

function fakeWindow(id) {
  const listeners = new Map()
  const calls = []
  const win = {
    id,
    calls,
    _protection: false,
    isDestroyed: () => false,
    setContentProtection(v) {
      win._protection = v
      calls.push(v)
    },
    setTitle(t) {
      win._title = t
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return win
    },
    once(event, fn) {
      return win.on(event, fn)
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
      return win
    },
    emit(event) {
      for (const fn of listeners.get(event) ?? []) fn()
    },
    // show/showInactive/restore 会被 track 包装
    show() {
      win.showCalled = (win.showCalled ?? 0) + 1
    },
    showInactive() {
      win.showInactiveCalled = (win.showInactiveCalled ?? 0) + 1
    },
    restore() {
      win.restoreCalled = (win.restoreCalled ?? 0) + 1
    },
    setTitle_calls: []
  }
  return win
}

function main() {
  protection.__resetForTest()
  settingsStore.patch({ stealth: { contentProtection: true, safeMode: false } })

  /* 1. 登记后立即保护 */
  const w1 = fakeWindow(1)
  protection.trackProtectedWindow(w1)
  check('登记窗口后立即开启内容保护', w1._protection === true, JSON.stringify(w1.calls))

  /* 2. 重新显示时保护仍在（原版包装 show 的核心价值） */
  w1.calls.length = 0
  w1.show()
  check('调用 show() 前会重新应用保护', w1.calls.includes(true), JSON.stringify(w1.calls))
  check('show() 仍然被真正执行', w1.showCalled === 1, String(w1.showCalled))

  w1.calls.length = 0
  w1.showInactive()
  check('showInactive() 前重新应用保护', w1.calls.includes(true))

  w1.calls.length = 0
  w1.restore()
  check('restore() 前重新应用保护', w1.calls.includes(true))

  /* 3. 系统在这些时机丢掉保护后要自动补回 */
  for (const ev of ['resize', 'move', 'enter-full-screen', 'leave-full-screen', 'restore', 'show']) {
    w1.calls.length = 0
    w1.emit(ev)
    check(`事件 ${ev} 后重新应用保护`, w1.calls.includes(true), JSON.stringify(w1.calls))
  }

  /* 4. 安全模式开启时，即使窗口没被标记也必须保护 */
  protection.__resetForTest()
  settingsStore.patch({ stealth: { contentProtection: false, safeMode: true } })
  const w2 = fakeWindow(2)
  protection.trackProtectedWindow(w2)
  check('安全模式开启：未标记的窗口也受保护', w2._protection === true)

  /* 5. 关掉安全模式要能恢复显示（否则用户以为软件坏了） */
  protection.__resetForTest()
  settingsStore.patch({ stealth: { contentProtection: false, safeMode: false } })
  const w3 = fakeWindow(3)
  let provided = [w3]
  protection.setWindowsProvider(() => provided)
  protection.trackProtectedWindow(w3)
  protection.releaseAll()
  check('关闭保护：窗口恢复可被录制', w3._protection === false, JSON.stringify(w3.calls))

  /* 6. 标题伪装（原版：安全模式 → 笔记） */
  check('伪装名与原文案一致', protection.TITLE_DISGUISED === '笔记', protection.TITLE_DISGUISED)
  protection.applyDisguise(w3, true)
  check('开启伪装：标题变为「笔记」', w3._title === '笔记', w3._title)
  protection.applyDisguiseAll(true)
  check('批量伪装：所有窗口生效', w3._title === '笔记', w3._title)
  protection.applyDisguise(w3, false)
  check('取消伪装：标题恢复应用名', w3._title === 'AI 面试助手', w3._title)

  /* 7. 幂等：重复登记不会重复包装 */
  protection.__resetForTest()
  const w4 = fakeWindow(4)
  protection.trackProtectedWindow(w4)
  const wrappedOnce = w4.show
  protection.trackProtectedWindow(w4)
  check('重复登记不重复包装 show', w4.show === wrappedOnce)

  fs.rmSync(DATA, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
