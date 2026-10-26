/**
 * 鼠标穿透「逃逸通道」自测。
 *
 * 运行：node src/main/clickthrough/__selftest__/run.cjs
 *
 * 这是安全关键路径：穿透开启后窗口完全不响应鼠标，
 * 如果没有生效的快捷键，用户就被永久困住（原版为此专门做了兜底键）。
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
const DATA = path.join(os.tmpdir(), `suisi-ct-${process.pid}`)
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

/* ---- 桩：记录快捷键注册与窗口穿透状态 ---- */
const registered = new Map()
const ignoreMouseCalls = []
const broadcasts = []
const windows = new Map()

function fakeWindow(kind) {
  return {
    kind,
    isDestroyed: () => false,
    setIgnoreMouseEvents: (v) => ignoreMouseCalls.push([kind, v]),
    hide: () => {},
    showInactive: () => {},
    isVisible: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    webContents: { send: () => {} },
    once: () => {},
    on: () => {}
  }
}
windows.set('floating', fakeWindow('floating'))
windows.set('quizbar', fakeWindow('quizbar'))

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA, getName: () => 'x', isPackaged: false },
      ipcMain: { handle: () => {}, on: () => {} },
      globalShortcut: {
        register: (acc, fn) => {
          if (registered.has(acc)) return false
          registered.set(acc, fn)
          return true
        },
        unregister: (acc) => {
          registered.delete(acc)
        },
        unregisterAll: () => registered.clear(),
        isRegistered: (acc) => registered.has(acc)
      },
      screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 }, bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 1 }) },
      BrowserWindow: { getAllWindows: () => [...windows.values()] }
    }
  }
  if (request === '../windows' || request.endsWith('/windows')) {
    return {
      getWindow: (kind) => windows.get(kind) ?? null,
      broadcast: (...args) => broadcasts.push(args),
      allWindows: () => [...windows.values()],
      openQuizbarWindow: () => windows.get('quizbar'),
      startHoverTracking: () => {},
      stopHoverTracking: () => {}
    }
  }
  return origLoad.apply(this, [request, ...rest])
}

const ct = require(path.join(ROOT, 'src/main/clickthrough.ts'))
const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

function main() {
  /* 1. 用户没配 → 注册内置兜底键 */
  settingsStore.patch({ hotkeys: { toggleClickThrough: '' } })
  let r = ct.registerClickThroughHotkey()
  check('未配置时：使用内置兜底键', r.isFallback === true, r.accelerator)
  check('兜底键与原版一致（⌘⇧9）', r.accelerator === 'CommandOrControl+Shift+9', r.accelerator)
  check('兜底键已成功注册', r.ok === true && registered.has(r.accelerator), [...registered.keys()].join(','))
  check('界面能拿到当前生效的快捷键', ct.activeClickThroughHotkey() === 'CommandOrControl+Shift+9', ct.activeClickThroughHotkey())

  /* 2. 按兜底键 → 解除所有窗口的穿透 */
  settingsStore.patch({ stealth: { clickThrough: true } })
  ignoreMouseCalls.length = 0
  registered.get(r.accelerator)() // 模拟按键
  check('按兜底键：清除设置里的穿透', settingsStore.get().stealth.clickThrough === false)
  check('按兜底键：窗口实际恢复响应鼠标', ignoreMouseCalls.some(([, v]) => v === false), JSON.stringify(ignoreMouseCalls))
  check('按兜底键：通知界面刷新', broadcasts.length > 0, `${broadcasts.length} 次`)

  /* 3. 用户配了自己的键 → 不再用兜底 */
  settingsStore.patch({ hotkeys: { toggleClickThrough: 'CommandOrControl+Shift+7' } })
  r = ct.registerClickThroughHotkey()
  check('用户配置后：使用用户的键', r.accelerator === 'CommandOrControl+Shift+7' && r.isFallback === false, r.accelerator)
  check('用户配置后：兜底键被注销', !registered.has('CommandOrControl+Shift+9'), [...registered.keys()].join(','))
  check('界面提示跟随用户配置', ct.activeClickThroughHotkey() === 'CommandOrControl+Shift+7', ct.activeClickThroughHotkey())

  /* 4. 用户键切换穿透（开→关） */
  settingsStore.patch({ stealth: { clickThrough: false } })
  registered.get(r.accelerator)()
  check('用户键：能开启穿透', settingsStore.get().stealth.clickThrough === true)
  ignoreMouseCalls.length = 0
  registered.get(r.accelerator)()
  check('用户键：再按一次关闭穿透', settingsStore.get().stealth.clickThrough === false && ignoreMouseCalls.some(([, v]) => v === false))

  /* 5. 切换穿透时窗口同步生效 */
  ignoreMouseCalls.length = 0
  ct.toggleClickThrough()
  check('切换穿透：两个悬浮窗都更新', ignoreMouseCalls.length === 2 && ignoreMouseCalls.every(([, v]) => v === true), JSON.stringify(ignoreMouseCalls))
  ignoreMouseCalls.length = 0
  ct.releaseClickThrough()
  check('解除穿透：两个悬浮窗都恢复', ignoreMouseCalls.length === 2 && ignoreMouseCalls.every(([, v]) => v === false), JSON.stringify(ignoreMouseCalls))

  /* 6. 悬停显隐切换 */
  const before = settingsStore.get().stealth.hoverReveal
  ct.toggleHoverReveal()
  check('切换悬停显隐：状态翻转', settingsStore.get().stealth.hoverReveal === !before)

  /* 7. 穿透状态会被持久化（重启后不会「以为自己没穿透」） */
  ct.toggleClickThrough()
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'settings.json'), 'utf8'))
  check('穿透状态已落盘', saved.stealth.clickThrough === true, String(saved.stealth.clickThrough))

  fs.rmSync(DATA, { recursive: true, force: true })
  const failed = RESULTS.filter((x) => !x.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
