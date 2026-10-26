/**
 * 隐藏鼠标（安全模式，主进程侧）自测。
 *
 * 运行：
 *   node src/main/cursor/__selftest__/run.cjs
 *
 * 覆盖：
 *   1) helper 不存在 → getSupport() ok:false 且有可读中文原因（不抛异常）
 *   2) hide() 在无 helper 时 ok:false，且 isHidden() 仍为 false
 *   3) stub 可用的 helper → getSupport/hide/show 全链路成功（并验证真的调了恢复）
 *   3b) probe 失败（HIDE_OK=0）→ 优雅降级
 *   3c) 台账有残留（STALE=1）→ hide() 会先兜底恢复再隐藏
 *   4) 非 darwin 平台优雅降级
 *   5) shutdown() 幂等，多次调用不抛异常
 *   6) shutdown() 在「已隐藏」状态下确实调用了恢复（SIGTERM + --force-show）
 *   7) --status 卡住时 isHidden() 带超时返回，不卡死
 *   8) 真实构建产物（若已 build）的探测证据
 *
 * ⚠️ 本自测只操作 stub 脚本，**不会真的隐藏你的鼠标**。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suisi-cursor-selftest-'))

/* ---------- 加载器：TS 转译（本模块不依赖 electron，无需 stub electron） ---------- */
const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}

/* ---------- 断言 ---------- */
const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}
function skip(name, detail) {
  console.log(`SKIP  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/* ---------- stub helper ---------- */
const GOOD_STUB = `#!/bin/sh
# 模拟可用的 cursor-hide：probe 报能力、hold 常驻、收到 TERM 先恢复再退
LOG="\${KG_CALL_LOG:-/dev/null}"
echo "$1" >> "$LOG"
case "$1" in
  --probe)
    echo "CURSOR_PROBE=1"
    echo "DISPLAY_COUNT=2"
    echo "HIDE_OK=\${STUB_HIDE_OK:-1}"
    echo "VISIBLE_QUERY=1"
    echo "CURSOR_VISIBLE=1"
    echo "LEDGER_COUNT=0"
    echo "STALE=0"
    if [ "\${STUB_HIDE_OK:-1}" = "0" ]; then echo "PROBE_REASON=模拟：系统不允许隐藏鼠标"; fi
    exit 0 ;;
  --status)
    echo "CURSOR_STATUS=1"
    echo "LEDGER_COUNT=\${STUB_LEDGER_COUNT:-0}"
    echo "HIDDEN=\${STUB_HIDDEN:-0}"
    echo "STALE=\${STUB_STALE:-0}"
    echo "CURSOR_VISIBLE=\${STUB_VISIBLE:-1}"
    exit 0 ;;
  --hold)
    echo "CURSOR_READY=1"; echo "MODE=hold"; echo "CURSOR_HIDDEN=1"
    trap 'echo TERM >> "$LOG"; echo "CURSOR_RESTORED=1"; echo "CURSOR_STOPPED=1"; exit 0' TERM
    while true; do sleep 0.05; done ;;
  --show)
    echo "CURSOR_SHOWN=1"; echo "CURSOR_READY=1"; exit 0 ;;
  --force-show)
    echo "CURSOR_SHOWN=1"; echo "CURSOR_RESTORED=1"; echo "CURSOR_READY=1"; exit 0 ;;
esac
exit 0
`

const HANG_STUB = `#!/bin/sh
exec sleep 30
`

const FAIL_STUB = `#!/bin/sh
echo "CURSOR_ERROR=模拟探测失败"
exit 3
`

function writeScript(name, body) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, body, 'utf8')
  fs.chmodSync(p, 0o755)
  return p
}

/* ---------- 环境 ---------- */
// 功能用例给足预算（机器可能同时在跑构建）；只有「超时保护」用例才临时收紧到 600ms
const GENEROUS_PROBE_MS = '4000'
const GENEROUS_STATUS_MS = '4000'
const GENEROUS_READY_MS = '4000'
const TIGHT_MS = '600'
process.env.SUISI_CURSOR_PROBE_TIMEOUT_MS = GENEROUS_PROBE_MS
process.env.SUISI_CURSOR_STATUS_TIMEOUT_MS = GENEROUS_STATUS_MS
process.env.SUISI_CURSOR_READY_TIMEOUT_MS = GENEROUS_READY_MS
process.env.SUISI_CURSOR_LEDGER = path.join(TMP, 'ledger.json')

const CURSOR_CALL_LOG = path.join(TMP, 'calls.log')
process.env.KG_CALL_LOG = CURSOR_CALL_LOG

const cursor = require(path.join(ROOT, 'src/main/cursor/index.ts'))

const hasChinese = (s) => typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s)

function useHelper(p) {
  if (p) process.env.SUISI_CURSOR_HELPER = p
  else delete process.env.SUISI_CURSOR_HELPER
  cursor.__resetForTest()
}

function readCalls() {
  try {
    return fs.readFileSync(CURSOR_CALL_LOG, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
function clearCalls() {
  fs.rmSync(CURSOR_CALL_LOG, { force: true })
}
function setStubEnv(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
}

async function main() {
  const missingHelper = path.join(TMP, 'not-built', 'cursor-hide')
  const goodPath = writeScript('cursor-hide-ok.sh', GOOD_STUB)
  const hangPath = writeScript('cursor-hide-hang.sh', HANG_STUB)
  const failPath = writeScript('cursor-hide-fail.sh', FAIL_STUB)

  /* ============ 1. helper 不存在 ============ */
  useHelper(missingHelper)
  let support = null
  let threw = false
  try {
    support = cursor.getSupport()
  } catch (e) {
    threw = true
  }
  check('1. helper 不存在：不抛异常', !threw)
  check('1. helper 不存在：ok=false', support.ok === false)
  check('1. helper 不存在：有可读中文原因', hasChinese(support.reason), support.reason)
  check('1. helper 不存在：helperPath=null', support.helperPath === null)

  /* ============ 2. hide() 无 helper ============ */
  const hidden2 = await cursor.hide()
  check('2. hide 无 helper：ok=false', hidden2.ok === false)
  check('2. hide 无 helper：message 可读', hasChinese(hidden2.message), hidden2.message)
  check('2. hide 无 helper：isHidden 仍为 false', (await cursor.isHidden()) === false)

  /* ============ 3. 可用 stub：getSupport / hide / show ============ */
  setStubEnv({ STUB_HIDE_OK: '1', STUB_HIDDEN: '0', STUB_LEDGER_COUNT: '0', STUB_STALE: '0', STUB_VISIBLE: '1' })
  useHelper(goodPath)
  clearCalls()
  const support3 = cursor.getSupport()
  check('3. 可用 helper：getSupport ok=true', support3.ok === true, JSON.stringify(support3))

  const hide3 = await cursor.hide()
  check('3. hide：ok=true 且文案可读', hide3.ok === true && hasChinese(hide3.message), hide3.message)
  check('3. hide：确实用 --hold 常驻（而非一次性 --hide）', readCalls().includes('--hold'), readCalls().join(','))

  setStubEnv({ STUB_HIDDEN: '1' })
  check('3. isHidden：台账显示隐藏时为 true', (await cursor.isHidden()) === true)

  clearCalls()
  const show3 = await cursor.show()
  check('3. show：ok=true 且文案可读', show3.ok === true && hasChinese(show3.message), show3.message)
  check('3. show：发出了 --force-show 兜底恢复', readCalls().includes('--force-show'), readCalls().join(','))
  check('3. show：holder 收到了 SIGTERM（helper 自行先恢复）', readCalls().includes('TERM'), readCalls().join(','))

  setStubEnv({ STUB_HIDDEN: '0' })
  check('3. show 之后 isHidden=false', (await cursor.isHidden()) === false)

  /* ============ 3b. probe 失败 ============ */
  setStubEnv({ STUB_HIDE_OK: '0' })
  useHelper(goodPath)
  const support3b = cursor.getSupport()
  check('3b. probe 失败：ok=false', support3b.ok === false)
  check('3b. probe 失败：原因来自 helper 且可读', /系统不允许隐藏鼠标/.test(support3b.reason ?? ''), support3b.reason)
  const hide3b = await cursor.hide()
  check('3b. probe 失败：hide 也返回 ok=false', hide3b.ok === false)
  setStubEnv({ STUB_HIDE_OK: '1' })

  /* ============ 3c. 台账残留（STALE）时 hide 先兜底恢复 ============ */
  setStubEnv({ STUB_STALE: '1', STUB_LEDGER_COUNT: '1', STUB_HIDDEN: '1' })
  useHelper(goodPath)
  clearCalls()
  const hide3c = await cursor.hide()
  check('3c. 残留态下 hide：成功重新隐藏', hide3c.ok === true)
  check('3c. 残留态下 hide：先执行了 --force-show 把欠的隐藏还清', readCalls().includes('--force-show'), readCalls().join(','))
  await cursor.show()
  setStubEnv({ STUB_STALE: '0', STUB_LEDGER_COUNT: '0', STUB_HIDDEN: '0' })

  /* ============ 3e. 查询瞬时变 0 时不得误报为「隐藏中」 ============ */
  // 实测 macOS 26 上 CGCursorIsVisible 会瞬时变 0（系统「打字时自动隐藏光标」等），
  // 若把 CURSOR_VISIBLE=0 当作权威就会误报，进而让调用方多发一次不必要的 Show。
  setStubEnv({ STUB_HIDDEN: '0', STUB_LEDGER_COUNT: '0', STUB_STALE: '0', STUB_VISIBLE: '0' })
  useHelper(goodPath)
  check('3e. 台账干净 + 查询说不可见 → isHidden 仍为 false（防瞬时误报）', (await cursor.isHidden()) === false)
  setStubEnv({ STUB_VISIBLE: '1' })

  /* ============ 3d. probe 卡住 → 超时保护 ============ */
  process.env.SUISI_CURSOR_PROBE_TIMEOUT_MS = TIGHT_MS
  useHelper(hangPath)
  const t0 = Date.now()
  const support3d = cursor.getSupport()
  const elapsed = Date.now() - t0
  process.env.SUISI_CURSOR_PROBE_TIMEOUT_MS = GENEROUS_PROBE_MS
  check('3d. probe 卡住：带超时返回（不卡死）', elapsed < 3000, `实测 ${elapsed}ms（预算 600ms）`)
  check('3d. probe 卡住：ok=false 且原因为超时', support3d.ok === false && /超时/.test(support3d.reason ?? ''), support3d.reason)

  /* ============ 4. 非 darwin ============ */
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    useHelper(goodPath)
    const support4 = cursor.getSupport()
    check('4. 非 darwin：ok=false', support4.ok === false)
    check('4. 非 darwin：文案为「当前系统暂不支持隐藏鼠标」', support4.reason === '当前系统暂不支持隐藏鼠标', support4.reason)
    check('4. 非 darwin：helperPath=null', support4.helperPath === null)
    const hide4 = await cursor.hide()
    check('4. 非 darwin：hide 返回可读原因', hide4.ok === false && /暂不支持/.test(hide4.message), hide4.message)
    check('4. 非 darwin：isHidden=false', (await cursor.isHidden()) === false)
  } finally {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  }

  /* ============ 5. shutdown 幂等 ============ */
  useHelper(goodPath)
  setStubEnv({ STUB_HIDDEN: '1', STUB_LEDGER_COUNT: '1', STUB_STALE: '0' })
  await cursor.hide()
  await cursor.shutdown()
  let threw5 = false
  try {
    await cursor.shutdown()
    await cursor.shutdown()
  } catch {
    threw5 = true
  }
  check('5. shutdown 连续三次：不抛异常', !threw5)

  /* ============ 6. shutdown 在「已隐藏」状态下确实调用了恢复 ============ */
  cursor.__resetForTest()
  useHelper(goodPath)
  setStubEnv({ STUB_HIDDEN: '1', STUB_LEDGER_COUNT: '1', STUB_STALE: '0' })
  const hide6 = await cursor.hide()
  check('6. 先进入已隐藏状态', hide6.ok === true, hide6.message)
  clearCalls()
  await cursor.shutdown()
  const calls6 = readCalls()
  check('6. shutdown：holder 收到 SIGTERM（helper 会先恢复再退）', calls6.includes('TERM'), calls6.join(','))
  check('6. shutdown：并额外调用 --force-show 兜底恢复', calls6.includes('--force-show'), calls6.join(','))

  /* ============ 7. --status 卡住时 isHidden 超时返回 ============ */
  cursor.__resetForTest()
  process.env.SUISI_CURSOR_STATUS_TIMEOUT_MS = TIGHT_MS
  useHelper(hangPath)
  const t7 = Date.now()
  const hidden7 = await cursor.isHidden()
  const elapsed7 = Date.now() - t7
  process.env.SUISI_CURSOR_STATUS_TIMEOUT_MS = GENEROUS_STATUS_MS
  check('7. status 卡住：isHidden 带超时返回 false（不卡死）', hidden7 === false && elapsed7 < 3000, `${elapsed7}ms`)

  /* ============ 8. 真实 helper 证据 ============ */
  const realHelper = path.join(ROOT, 'native', 'cursor-hide', 'cursor-hide')
  if (fs.existsSync(realHelper)) {
    process.env.SUISI_CURSOR_PROBE_TIMEOUT_MS = '3000'
    useHelper(realHelper)
    const support8 = cursor.getSupport()
    console.log(`   [证据] 真实 helper：${realHelper}`)
    console.log(`   [证据] getSupport() => ${JSON.stringify(support8)}`)
    if (support8.ok) {
      // 注意：这里不调用 hide()，避免真的把使用者的鼠标藏起来
      console.log('   [证据] 本机支持隐藏鼠标（未执行真实 hide，避免影响使用者）')
    }
    check('8. 真实 helper：可用或给出可读原因（绝不抛异常）', support8.ok === true || hasChinese(support8.reason), support8.reason ?? '(ok)')
    // 真实 helper 的原始 --status 输出作为证据；注意 CURSOR_VISIBLE 只作诊断，
    // 实测它会瞬时变 0（系统「打字时隐藏光标」），所以 isHidden() 以台账为准。
    const { execFileSync: runReal } = require('node:child_process')
    const rawStatus = runReal(realHelper, ['--status', '--ledger', path.join(TMP, 'real-ledger.json')], { encoding: 'utf8' })
    console.log('   [证据] 真实 --status 原始输出:')
    for (const line of rawStatus.trim().split('\n')) console.log(`          ${line}`)
    const hidden8 = await cursor.isHidden()
    console.log(`   [证据] isHidden() => ${hidden8}`)
    /*
     * 这条断言读的是**真实全局光标状态**，因此如果此刻应用正在运行并且真的隐藏了光标，
     * 它就会失败——那不是实现缺陷，而是「有别的实例在占用光标」。
     * 先探测是否有 hold 进程在跑；有就降级为提示，避免误报（这个假失败真实发生过一次）。
     */
    const { execSync: pgrepSync } = require('node:child_process')
    let holderRunning = false
    try {
      holderRunning = pgrepSync('pgrep -f "cursor-hide" || true', { encoding: 'utf8' }).trim().length > 0
    } catch {
      holderRunning = false
    }
    if (holderRunning) {
      console.log('   [跳过] 检测到 cursor-hide 常驻进程（可能有实例正在使用），本条改为提示')
      check('8. 真实 helper：可用且状态可读', typeof hidden8 === 'boolean', `isHidden=${hidden8}`)
    } else {
      check('8. 真实 helper：台账干净时 isHidden=false', hidden8 === false, String(hidden8))
    }
  } else {
    skip('8. 真实 helper 实测', '未构建，请先运行 bash native/cursor-hide/build.sh')
  }

  /* ============ 9. 无残留子进程 ============ */
  const { execFileSync } = require('node:child_process')
  let leftover = ''
  try {
    leftover = execFileSync('/usr/bin/pgrep', ['-fl', path.basename(TMP)], { encoding: 'utf8' }).trim()
  } catch {
    leftover = ''
  }
  check('9. 无残留 stub 进程（holder 都已回收）', leftover === '', leftover || '干净')

  fs.rmSync(TMP, { recursive: true, force: true })

    /*
   * 系统查询不可信时的判定（真实事故）：
   * 实测在没有任何 hold 进程时 CURSOR_VISIBLE 会瞬时返回 0，helper 的 HIDDEN 随之变 1。
   * 判定必须以台账为准，否则会误报「光标被藏了」并多发一次无谓的 Show。
   */
  const statusSrc = fs.readFileSync(path.join(ROOT, 'src/main/cursor/index.ts'), 'utf8')
  check(
    '判定依据：hidden 由台账（LEDGER_COUNT/STALE）决定，而不是 helper 的 HIDDEN 字段',
    statusSrc.includes('ledgerCount > 0 || stale') && !/hidden:\s*field\(run\.output, 'HIDDEN'\)/.test(statusSrc),
    '已改为台账判定'
  )

const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error('自测异常：', error)
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  process.exit(1)
})
