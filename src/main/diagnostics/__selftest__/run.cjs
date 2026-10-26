/**
 * 环境检查 + 设备检查（主进程侧）自测。
 *
 * 运行：
 *   node src/main/diagnostics/__selftest__/run.cjs
 *
 * 覆盖：进程扫描与软件识别、风险等级判定、防录屏开关联动、
 * 辅助功能权限、检查结果持久化与广播、以及「检查绝不阻断功能」这一契约。
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
const DATA_DIR = path.join(os.tmpdir(), `suisi-diag-selftest-${process.pid}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

/* ---------- 加载器：TS 转译 + 别名 + electron stub ---------- */
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

/* 可控 stub：进程列表与权限状态由测试注入 */
const stub = {
  processes: '',
  accessibility: false,
  screenPermission: 'granted',
  captured: []
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA_DIR, getName: () => 'AI 面试助手', isPackaged: false },
      ipcMain: { handle: (ch, fn) => stub.captured.push(ch), on: () => {} },
      systemPreferences: {
        getMediaAccessStatus: (kind) => (kind === 'screen' ? stub.screenPermission : 'granted'),
        isTrustedAccessibilityClient: () => stub.accessibility,
        askForMediaAccess: async () => true
      },
      desktopCapturer: { getSources: async () => [{ thumbnail: { isEmpty: () => false } }] },
      BrowserWindow: class {},
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
      shell: {},
      globalShortcut: { register: () => true, unregisterAll: () => {} }
    }
  }
  if (request === 'node:child_process') {
    // 只替换 exec，保留其它导出
    const real = originalLoad.apply(this, [request, ...rest])
    return {
      ...real,
      exec: (_cmd, _opts, cb) => {
        const done = typeof _opts === 'function' ? _opts : cb
        if (typeof done === 'function') done(null, stub.processes, '')
        return { on: () => {} }
      }
    }
  }
  return originalLoad.apply(this, [request, ...rest])
}

/* ---------- 断言 ---------- */
const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

async function main() {
  const security = require(path.join(ROOT, 'src/main/diagnostics/security.ts'))
  const devices = require(path.join(ROOT, 'src/main/diagnostics/devices.ts'))
  const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))

  /* ================= 1. 干净环境 ================= */
  stub.processes = '/usr/sbin/cupsd\n/usr/libexec/foo\n/Applications/Safari.app/Contents/MacOS/Safari\n'
  stub.accessibility = true
  settingsStore.patch({ stealth: { contentProtection: true, safeMode: false } })

  let result = await security.scanEnvironment()
  check('干净环境：风险等级为 safe', result.risk === 'safe', result.risk)
  check('干净环境：结论为「环境安全」', result.summary === '环境安全', result.summary)
  check('干净环境：未检测到录屏软件', result.detections.recorders.length === 0)
  check('干净环境：未检测到安全软件', result.detections.securitySoftware.length === 0)
  check('检查项齐全（防录屏/录屏/安全软件/辅助功能/安全模式）', result.items.length >= 5, `共 ${result.items.length} 项`)

  /* ================= 2. 检测到录屏软件 ================= */
  stub.processes = '/Applications/zoom.us.app/Contents/MacOS/zoom.us\n/Applications/OBS.app/Contents/MacOS/OBS\n'
  result = await security.scanEnvironment()
  check('录屏检测：识别出 Zoom', result.detections.recorders.includes('Zoom'), result.detections.recorders.join('、'))
  check('录屏检测：识别出 OBS', result.detections.recorders.includes('OBS'))
  check('录屏检测：风险等级升为 warn', result.risk === 'warn', result.risk)
  const recorderItem = result.items.find((i) => i.id === 'screen-recording')
  check('录屏检测：提示文案含软件名', /Zoom|OBS/.test(recorderItem.message), recorderItem.message)
  check('录屏检测：给出建议', Boolean(recorderItem.advice))

  /* ================= 3. 检测到安全软件 ================= */
  stub.processes = '/Applications/Sophos.app/Contents/MacOS/Sophos\n/Library/360/360safe\n'
  result = await security.scanEnvironment()
  check('安全软件：识别出 Sophos', result.detections.securitySoftware.includes('Sophos'))
  check('安全软件：识别出 360', result.detections.securitySoftware.includes('360 安全卫士'))
  const secItem = result.items.find((i) => i.id === 'security-software')
  check('安全软件：提示可能拦截防录屏', /黑框|拦截/.test(secItem.message), secItem.message)
  check('安全软件：建议加入白名单', /白名单/.test(secItem.advice ?? ''), secItem.advice)

  /* ================= 4. 防录屏未开启 ================= */
  settingsStore.patch({ stealth: { contentProtection: false } })
  result = await security.scanEnvironment()
  const cpItem = result.items.find((i) => i.id === 'content-protection')
  check('防录屏：未开启时给出 warn', cpItem.status === 'warn', cpItem.status)
  check('防录屏：建议开启', /开启|打开/.test(cpItem.advice ?? ''), cpItem.advice)
  settingsStore.patch({ stealth: { contentProtection: true } })

  /* ================= 5. 辅助功能未授权 ================= */
  stub.accessibility = false
  result = await security.scanEnvironment()
  const axItem = result.items.find((i) => i.id === 'accessibility')
  check('辅助功能：未授权时给出 warn', axItem.status === 'warn', axItem.status)
  check('辅助功能：指出快捷键受影响', /快捷键/.test(axItem.message), axItem.message)
  check('辅助功能：建议去系统设置授权', /辅助功能/.test(axItem.advice ?? ''), axItem.advice)
  stub.accessibility = true

  /* ================= 6. 安全模式状态 ================= */
  settingsStore.patch({ stealth: { safeMode: true } })
  result = await security.scanEnvironment()
  const smItem = result.items.find((i) => i.id === 'safe-mode')
  check('安全模式：开启时状态为 pass', smItem.status === 'pass', smItem.status)

  /* ================= 7. 契约：检查绝不阻断功能 ================= */
  stub.processes = 'zoom.us\nSophos\n'
  result = await security.scanEnvironment()
  check('契约：即使检测到风险，也不产生 fail 级阻断项', !result.items.some((i) => i.id !== 'content-protection' && i.status === 'fail'), JSON.stringify(result.items.map((i) => `${i.id}:${i.status}`)))
  check('契约：scanEnvironment 不抛异常即可返回结果', Boolean(result.checkedAt))

  /* ================= 8. 结果持久化与广播 ================= */
  const before = security.getCheckState()
  check('状态：扫描后缓存里有 security 结果', Boolean(before.security), Object.keys(before).join(','))
  const saved = security.setDeviceCheck({
    items: [{ id: 'microphone', label: '麦克风', status: 'pass', message: 'ok', optional: true }],
    allPassed: true,
    canProceed: true,
    checkedAt: Date.now()
  })
  check('状态：设备检查结果可写入且不覆盖环境结果', Boolean(saved.device) && Boolean(saved.security))
  check('状态：currentRecorders 反映最近一次扫描', security.currentRecorders().includes('Zoom'), security.currentRecorders().join('、'))

  /* ================= 9. 主进程侧权限读取 ================= */
  const perms = devices.currentPermissions()
  check('权限：包含麦克风/摄像头/屏幕/辅助功能四项', ['microphone', 'camera', 'screen', 'accessibility'].every((k) => k in perms), Object.keys(perms).join(','))
  check('权限：屏幕权限取自系统状态', perms.screen === 'granted', perms.screen)
  stub.screenPermission = 'denied'
  check('权限：状态变化能被反映', devices.currentPermissions().screen === 'denied')
  stub.screenPermission = 'granted'

  const probe = await devices.probeScreenCapture()
  check('屏幕录制实测：能拿到画面即通过', probe.ok === true, probe.message)

  /* ================= 10. IPC 通道已注册 ================= */
  const diagIpc = require(path.join(ROOT, 'src/main/ipc/diagnostics.ts'))
  stub.captured.length = 0
  diagIpc.registerDiagnosticsIpc()
  const required = [
    'permission:get',
    'permission:request',
    'diagnostics:probe-screen-capture',
    'diagnostics:device-check-save',
    'diagnostics:security-scan',
    'diagnostics:check-state-get'
  ]
  const missing = required.filter((ch) => !stub.captured.includes(ch))
  check('IPC：诊断相关通道全部注册', missing.length === 0, missing.length ? `缺少 ${missing.join(', ')}` : `共 ${stub.captured.length} 个`)

  fs.rmSync(DATA_DIR, { recursive: true, force: true })

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error('自测异常：', error)
  process.exit(1)
})
