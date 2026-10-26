/**
 * 自测加载器：让 Node 直接跑主进程 TS 源码，不需要新增任何依赖。
 *
 * 做三件事：
 *  1. 用项目自带的 typescript 现场转译 .ts（注册 require.extensions['.ts']）
 *  2. 把 @shared/* 别名映射到 src/shared/*
 *  3. 用最小 stub 顶替 electron（app.getPath / ipcMain.handle）
 *
 * 这样就能在真实 Electron 之外验证知识库逻辑；真正的 Electron 运行时另有一份探针
 * （electron-pdf.cjs）验证 pdfjs 在 Electron 主进程里确实可用。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** 向上找 package.json 定位项目根，避免硬编码相对层级 */
function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`找不到项目根目录（从 ${start} 向上查找 package.json 失败）`)
}

const PROJECT_ROOT = findRoot(__dirname)
/** 用 IF 里的 userData 目录；每次自测前由 run.cjs 清空 */
const DATA_DIR = process.env.KB_SELFTEST_DATA || path.join(os.tmpdir(), 'suisi-kb-selftest')

const handlers = new Map()
let loaded = null

function load() {
  if (loaded) return loaded

  const ts = require(path.join(PROJECT_ROOT, 'node_modules', 'typescript'))

  require.extensions['.ts'] = (mod, filename) => {
    const source = fs.readFileSync(filename, 'utf8')
    const out = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    })
    mod._compile(out.outputText, filename)
  }

  const originalResolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request.startsWith('@shared/')) {
      // '@shared/types' -> '<root>/src/shared/types'
      request = path.join(PROJECT_ROOT, 'src', request.slice('@'.length))
    }
    return originalResolve.call(this, request, ...rest)
  }

  const originalLoad = Module._load
  // KB_REAL_ELECTRON=1：在真实 Electron 里跑（不替换 electron，用于验证 pdfjs 等真实运行时行为）
  const useRealElectron = process.env.KB_REAL_ELECTRON === '1'
  Module._load = function (request, ...rest) {
    if (request === 'electron' && !useRealElectron) {
      return {
        app: { getPath: () => DATA_DIR, isPackaged: false },
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
      }
    }
    return originalLoad.apply(this, [request, ...rest])
  }

  const knowledge = require(path.join(PROJECT_ROOT, 'src/main/knowledge/index.ts'))
  const ipc = require(path.join(PROJECT_ROOT, 'src/main/ipc/knowledge.ts'))
  const { IPC } = require(path.join(PROJECT_ROOT, 'src/shared/ipc.ts'))
  const settings = require(path.join(PROJECT_ROOT, 'src/main/store/settings.ts'))
  const store = require(path.join(PROJECT_ROOT, 'src/main/store/store.ts'))

  ipc.registerKnowledgeIpc()
  loaded = { knowledge, IPC, handlers, settings, store, PROJECT_ROOT, DATA_DIR }
  return loaded
}

/** 模拟渲染进程通过 IPC 调用：第一个参数是 event，这里给个空对象 */
async function invoke(channel, ...args) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`未注册的 IPC 通道：${channel}`)
  return handler({}, ...args)
}

/** 数据目录（与 store.dataDir 一致：userData/data） */
function dataDir() {
  return path.join(DATA_DIR, 'data')
}

module.exports = { load, invoke, handlers, dataDir, PROJECT_ROOT, DATA_DIR }
