/**
 * 悬浮窗退出流程自测。
 *
 * 运行：
 *   node src/main/quizbar/__selftest__/run.cjs
 *
 * 对齐原版的退出语义：退出前问「保存本次记录？」，
 * 「保存并关闭」要落库、「不保存，直接关闭」要丢弃，两者都必须关掉窗口。
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
const DATA_DIR = path.join(os.tmpdir(), `suisi-quizbar-selftest-${process.pid}`)
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

/** 被 IPC 处理器记录的调用 */
const handlers = new Map()
let closed = false
const fakeWin = {
  close() {
    closed = true
  },
  getSize: () => [460, 320],
  setSize: () => {},
  setOpacity: () => {},
  setIgnoreMouseEvents: () => {},
  setFocusable: () => {}
}

const originalLoad = Module._load
/*
 * electron 桩必须是**单例**：
 * Module._load 每次都会新建对象的话，「写入的剪贴板」和「读取的剪贴板」就不是同一个，
 * 断言会永远拿到空字符串（这个坑真踩过一次）。
 */
const electronStub = {
  app: { getPath: () => DATA_DIR, getName: () => 'x', isPackaged: false },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
  BrowserWindow: { fromWebContents: () => fakeWin },
  // 内存剪贴板：让「复制是否真的写进去了」可被断言
  clipboard: {
    _text: '',
    writeText(t) {
      this._text = t
    },
    readText() {
      return this._text
    }
  }
}
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub
  return originalLoad.apply(this, [request, ...rest])
}

const { IPC } = require(path.join(ROOT, 'src/shared/ipc.ts'))
const data = require(path.join(ROOT, 'src/main/ipc/data.ts'))
require(path.join(ROOT, 'src/main/ipc/quizbar.ts')).registerQuizbarIpc()
require(path.join(ROOT, 'src/main/ipc/clipboard.ts')).registerClipboardIpc()

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const items = [
  { id: 'q1', question: '两数之和怎么做？', answer: '用哈希表', trigger: 'manual', createdAt: Date.now() },
  { id: 'q2', question: '第二题', answer: '答案二', trigger: 'manual', createdAt: Date.now() }
]

function main() {
  const exit = handlers.get(IPC.QuizbarExit)
  check('退出通道已注册', typeof exit === 'function')
  check('尺寸通道已注册', typeof handlers.get(IPC.QuizbarSetSize) === 'function')

  /* 1. 不保存 */
  closed = false
  const r1 = exit({}, { kind: 'quiz', title: '', items, save: false })
  check('不保存：不产生会话 id', r1.savedId === null, JSON.stringify(r1))
  check('不保存：窗口已关闭', closed === true)

  /* 2. 保存 */
  closed = false
  const r2 = exit({}, { kind: 'quiz', title: '', items, save: true })
  check('保存：返回会话 id', typeof r2.savedId === 'string' && r2.savedId.length > 0, String(r2.savedId))
  const saved = data.sessions.get(r2.savedId)
  check('保存：会话已落库', Boolean(saved))
  check('保存：两条问答都在', saved && saved.qa.length === 2, String(saved?.qa?.length))
  check('保存：类型为 quiz', saved?.kind === 'quiz', saved?.kind)
  check('保存：标题取自首个问题', Boolean(saved?.title?.includes('两数之和')), saved?.title)
  check('保存：窗口已关闭', closed === true)

  /* 3. 显式标题优先 */
  closed = false
  const r3 = exit({}, { kind: 'quiz', title: '我的笔试一', items, save: true })
  check('保存：显式标题优先', data.sessions.get(r3.savedId)?.title === '我的笔试一', data.sessions.get(r3.savedId)?.title)

  /* 4. 没有问答时不创建空会话 */
  closed = false
  const r4 = exit({}, { kind: 'quiz', title: '', items: [], save: true })
  check('空会话：不创建记录', r4.savedId === null)
  check('空会话：窗口仍然关闭', closed === true)

  /* 5. 落盘检查（跨进程可见，用户重启后还在） */
  const file = path.join(DATA_DIR, 'data', 'sessions.json')
  check('落盘：sessions.json 已写入', fs.existsSync(file))
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('落盘：磁盘上有 2 条会话（不保存的没写）', disk.length === 2, `实际 ${disk.length} 条`)

  /* 6. 会话种类跟随模式 */
  closed = false
  const r6 = exit({}, { kind: 'interview_assist', title: '面试一', items, save: true })
  check('种类：面试模式存为 interview_assist', data.sessions.get(r6.savedId)?.kind === 'interview_assist', data.sessions.get(r6.savedId)?.kind)

  /*
   * 8. 窗口参数一致性（这条是一个真实事故的回归）：
   * quizbar 曾经把 sandbox 写成 !process.env['SUISI_NO_SANDBOX']，
   * 用户没设环境变量时等于 true，preload 加载不了相对 chunk，
   * window.api 未暴露 → 界面报「Cannot read properties of undefined (reading 'settings')」。
   */
  const windowsSrc = fs.readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8')
  const sandboxLines = windowsSrc.split('\n').filter((l) => l.includes('sandbox:'))
  check(
    '窗口参数：所有窗口的 sandbox 设置一致',
    sandboxLines.length >= 6 && sandboxLines.every((l) => l.includes('sandbox: false')),
    sandboxLines.map((l) => l.trim()).join(' | ')
  )
  check(
    '窗口参数：不存在依赖环境变量的 sandbox 写法',
    !windowsSrc.includes("sandbox: !process.env"),
    windowsSrc.includes('sandbox: !process.env') ? '仍有 !process.env 写法' : '无'
  )

  /* 9. 渲染层对桥接缺失要有兜底（不能再抛出看不懂的英文异常） */
  const quizbarApp = fs.readFileSync(path.join(ROOT, 'src/renderer/src/windows/quizbar/App.tsx'), 'utf8')
  check('渲染层：window.api 有 ?? {} 兜底', quizbarApp.includes('window.api ?? {}'))
  check('渲染层：有桥接缺失的可读提示', quizbarApp.includes('未加载到桥接接口'))

  /*
   * 10. 截图链路回归（两起真实事故的经验）。
   *
   * 事故一：热键直接 openCaptureWindow() 而没抓屏 → 遮罩拿到空底图，
   *         用户看到全屏置顶、点不动的窗口，感受为「卡死」。
   * 事故二：普通截图开了选区遮罩。对齐全屏直出——在线笔试平台可能检测到全屏遮罩。
   */
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
  check('截图热键：走 captureAndAnswer（先抓屏再识别）', indexSrc.includes('captureAndAnswer()'))
  check(
    '截图热键：不再直接 openCaptureWindow()',
    !/bind\(hk\.screenshot[\s\S]{0,120}openCaptureWindow\(\)/.test(indexSrc)
  )
  const captureSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc/capture.ts'), 'utf8')
  const captureFn = captureSrc.slice(
    captureSrc.indexOf('export async function captureAndAnswer'),
    captureSrc.indexOf('export function registerCaptureIpc')
  )
  check('截图入口：先抓屏再送入模型', captureFn.indexOf('captureScreenDataUrl') < captureFn.indexOf('answerImage'))
  check('截图入口：抓屏前隐藏自己应用的窗口', captureFn.includes('hideWindows: allWindows()'))
  check('截图入口：整屏直出，不开选区遮罩', !captureFn.includes('openCaptureWindow'))

  /*
   * 11. 截图必须能显示在悬浮窗卡片上。
   * 原版是「截图直接进框」：卡片上有 共N张/上一张/下一张/长截图/来源 标记。
   * captureAndAnswer 漏了广播，卡片截图区就永远是空的。
   */
  check('截图入口：把截图广播给悬浮窗（否则卡片永远空）', captureFn.includes('IPC.CaptureDone'))
  const quizbarAppSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/windows/quizbar/App.tsx'), 'utf8')
  check('卡片：订阅截图事件', quizbarAppSrc.includes('capture?.onDone'))
  check('卡片：显示「等待生成...」', quizbarAppSrc.includes('等待生成...'))
  check('卡片：有重试', quizbarAppSrc.includes('重试'))
  check(
    '卡片：有 上一张/下一张/共N张（原版 quizCard.imageCount）',
    quizbarAppSrc.includes('上一张') && quizbarAppSrc.includes('下一张') && /共 \{shots\.length\} 张/.test(quizbarAppSrc)
  )
  check('卡片：有 放大/缩小', quizbarAppSrc.includes('放大') && quizbarAppSrc.includes('缩小'))
  check('底部栏：题型（常规/Coding）', quizbarAppSrc.includes('题型') && quizbarAppSrc.includes('Coding'))
  check('底部栏：代码格式（核心/ACM）', quizbarAppSrc.includes('代码格式') && quizbarAppSrc.includes('ACM'))
  check('底部栏：判题语言', quizbarAppSrc.includes('判题语言'))
  check('底部栏：常规/Agent 模式切换', quizbarAppSrc.includes('Agent') && quizbarAppSrc.includes('solveMode'))

  const capSrc = fs.readFileSync(path.join(ROOT, 'src/main/capture/index.ts'), 'utf8')
  check('抓屏：默认宽度上限 1920（对齐原版）', capSrc.includes('maxWidth ?? 1920'))
  check('抓屏：默认 JPEG 质量 80（对齐原版）', capSrc.includes('jpegQuality ?? 80'))
  check('抓屏：输出 JPEG 而非 PNG', capSrc.includes('toJPEG('))
  check('抓屏：隐藏窗口后等待 90ms 再采集', /setTimeout\([\s\S]{0,40}90\)/.test(capSrc))
  check('抓屏：权限缺失有可读中文引导', capSrc.includes('屏幕录制权限'))

  /*
   * 12. 复制代码必须真的进剪贴板。
   *
   * 真实事故：悬浮窗是 focusable:false，navigator.clipboard.writeText() 会因
   * 「文档未聚焦」失败 → 点了复制但剪贴板里没有。必须走主进程。
   */
  const clipHandler = handlers.get(IPC.ClipboardWriteText)
  check('剪贴板通道已注册（走主进程）', typeof clipHandler === 'function')
  if (typeof clipHandler === 'function') {
    const ok = clipHandler({}, '测试代码\nint main() {}')
    check('写文本返回成功', ok === true)
    const clip = require('electron').clipboard
    check('内容确实写进了系统剪贴板', clip.readText() === '测试代码\nint main() {}', JSON.stringify(clip.readText()))
    check('空内容不抛异常', clipHandler({}, '') === true)
  }
  const uiSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/ui/index.tsx'), 'utf8')
  // 注意：注释里也会出现 navigator.clipboard 字样，所以比的是**真正的调用**
  check(
    '代码框优先走主进程剪贴板',
    uiSrc.indexOf('api?.clipboard?.writeText') < uiSrc.indexOf('await navigator.clipboard.writeText')
  )
  check('复制失败有可见反馈（不再静默）', uiSrc.includes('复制失败'))

  /*
   * 13. 穿透必须应用到「所有悬浮类窗口」。
   *
   * 真实回归：设置变更处理里只对 floating 调了 setIgnoreMouseEvents，
   * 而工具条的穿透按钮是改设置（不是直接调窗口），
   * 于是工具条窗口从没进入穿透 —— 用户点了「穿透」毫无反应。
   */
  const indexSrc2 = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
  const changedHandler = indexSrc2.slice(
    indexSrc2.indexOf("settingsStore.on('changed'"),
    indexSrc2.indexOf("app.on('activate'")
  )
  check(
    '设置变更：穿透应用到所有悬浮类窗口（floating + quizbar）',
    changedHandler.includes("['floating', 'quizbar']") && changedHandler.includes('setIgnoreMouseEvents')
  )
  check(
    '设置变更：不再只处理 floating',
    !/const floating = getWindow\('floating'\)[\s\S]{0,300}setIgnoreMouseEvents/.test(changedHandler)
  )
  check('穿透必须带 forward:true（否则悬停收不到移动）', changedHandler.includes('{ forward: true }'))

  /* 7. 异常入参不崩 */
  closed = false
  const r7 = exit({}, { kind: 'quiz', title: '', items: undefined, save: true })
  check('异常入参：不抛异常且不建记录', r7.savedId === null && closed === true)

  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
