/**
 * 截图链路自测（对齐原版 ScreenshotService.capture）。
 *
 * 运行：node src/main/capture/__selftest__/run.cjs
 *
 * 为什么单独写：本机当前的屏幕录制权限可能缺失（getSources 返回空），
 * 但截图逻辑里最容易错的部分——尺寸缩放、JPEG 编码、隐藏自己窗口的时序——
 * 都可以在没有真实屏幕的情况下验证。
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
const DATA = path.join(os.tmpdir(), `suisi-cap-${process.pid}`)
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

/* ---- 可控的桌面采集桩 ---- */
let capturedWith = null
let sourceResult = null
const hideLog = []
const jpegCalls = []

function makeThumb(w, h) {
  return {
    isEmpty: () => w === 0 || h === 0,
    getSize: () => ({ width: w, height: h }),
    // 用一个小缓冲代替真实图片内容，只验证「走的是 JPEG 且质量被透传」
    toJPEG: (q) => {
      jpegCalls.push(q)
      return Buffer.from(`jpeg:${w}x${h}:q${q}`)
    },
    toDataURL: () => 'data:image/png;base64,PNGNOTUSED'
  }
}

const ElectronFake = {
  screen: {
    getAllDisplays: () => [
      { id: 1, size: { width: 1440, height: 900 }, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1440, height: 900 } }
    ],
    getPrimaryDisplay: () => ({
      id: 1,
      size: { width: 1440, height: 900 },
      scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 1440, height: 900 }
    })
  },
  desktopCapturer: {
    getSources: async (opts) => {
      capturedWith = opts
      return sourceResult ?? []
    }
  },
  app: { getPath: () => DATA, getName: () => 'x', isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} }
}

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') return ElectronFake
  return origLoad.apply(this, [request, ...rest])
}

const cap = require(path.join(ROOT, 'src/main/capture/index.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

function fakeWindow(id, visible = true) {
  return {
    id,
    isDestroyed: () => false,
    isVisible: () => visible,
    hide() {
      hideLog.push(`hide:${id}`)
    },
    showInactive() {
      hideLog.push(`show:${id}`)
    }
  }
}

async function main() {
  /* 1. 默认缩到 1920 */
  sourceResult = [{ display_id: '1', thumbnail: makeThumb(1440, 900) }]
  await cap.captureScreenDataUrl()
  check('默认 maxWidth=1920：原生 2880 宽被缩到 1920', capturedWith.thumbnailSize.width === 1920, JSON.stringify(capturedWith.thumbnailSize))
  check('等比缩放：高度按同比例（1800 → 1200）', capturedWith.thumbnailSize.height === 1200, JSON.stringify(capturedWith.thumbnailSize))

  /* 2. 原生尺寸（maxWidth 足够大时不缩） */
  await cap.captureScreenDataUrl({ maxWidth: 99999 })
  check('maxWidth 足够大：保持原生 2880×1800', capturedWith.thumbnailSize.width === 2880 && capturedWith.thumbnailSize.height === 1800, JSON.stringify(capturedWith.thumbnailSize))

  /* 3. 输出 JPEG 且质量透传 */
  jpegCalls.length = 0
  const dataUrl = await cap.captureScreenDataUrl({ jpegQuality: 65 })
  check('输出 JPEG（不是 PNG）', dataUrl.startsWith('data:image/jpeg;base64,'), dataUrl.slice(0, 30))
  check('JPEG 质量透传', jpegCalls.includes(65), JSON.stringify(jpegCalls))

  /* 4. 质量被夹到合法范围 */
  jpegCalls.length = 0
  await cap.captureScreenDataUrl({ jpegQuality: 999 })
  check('质量上限夹到 100', jpegCalls.includes(100), JSON.stringify(jpegCalls))
  jpegCalls.length = 0
  await cap.captureScreenDataUrl({ jpegQuality: 1 })
  check('质量下限夹到 10', jpegCalls.includes(10), JSON.stringify(jpegCalls))

  /* 5. 截图前隐藏自己的窗口，截完恢复（关键：否则会拍到自己） */
  hideLog.length = 0
  const w1 = fakeWindow(1)
  const w2 = fakeWindow(2)
  await cap.captureScreenDataUrl({ hideWindows: [w1, w2] })
  check('截图前隐藏自己的窗口', hideLog.includes('hide:1') && hideLog.includes('hide:2'), hideLog.join(','))
  check('截图后恢复显示（showInactive）', hideLog.includes('show:1') && hideLog.includes('show:2'), hideLog.join(','))
  check('隐藏发生在采集之前', hideLog.indexOf('hide:1') < hideLog.indexOf('show:1'), hideLog.join(','))

  /* 6. 已隐藏的窗口不重复处理 */
  hideLog.length = 0
  await cap.captureScreenDataUrl({ hideWindows: [fakeWindow(3, false)] })
  check('本就不可见的窗口不去动它', hideLog.length === 0, hideLog.join(',') || '无操作')

  /* 7. 抓屏失败时窗口要恢复 */
  hideLog.length = 0
  sourceResult = []
  try {
    await cap.captureScreenDataUrl({ hideWindows: [fakeWindow(9)] })
    check('抓屏失败：抛错', false, '没有抛错')
  } catch (e) {
    check('抓屏失败：抛错', true, e.name)
    check('抓屏失败：判为权限问题并给出可读中文原因', cap.isScreenPermissionError(e) && /屏幕录制/.test(e.message), e.message.slice(0, 40))
    check('抓屏失败：窗口仍然被恢复（不会留下隐藏的窗口）', hideLog.includes('show:9'), hideLog.join(','))
  }

  /* 8. 空缩略图同样判为权限问题 */
  sourceResult = [{ display_id: '1', thumbnail: makeThumb(0, 0) }]
  try {
    await cap.captureScreenDataUrl()
    check('空缩略图：抛权限错误', false, '没有抛错')
  } catch (e) {
    check('空缩略图：抛权限错误', cap.isScreenPermissionError(e), e.name)
  }

  /* 9. 按显示器匹配 source */
  sourceResult = [
    { display_id: '2', thumbnail: makeThumb(100, 100) },
    { display_id: '1', thumbnail: makeThumb(200, 200) }
  ]
  const picked = await cap.captureScreenDataUrl()
  // dataURL 是 base64，要解码后再断言内容
  const decoded = Buffer.from(picked.split(',')[1], 'base64').toString('utf8')
  check('多显示器：优先匹配目标显示器（display_id=1 → 200x200）', decoded.includes('200x200'), decoded)

  fs.rmSync(DATA, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
