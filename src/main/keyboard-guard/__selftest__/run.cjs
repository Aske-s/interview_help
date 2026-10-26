/**
 * 键盘防护 / 安全输入（主进程侧）自测。
 *
 * 运行：
 *   node src/main/keyboard-guard/__selftest__/run.cjs
 *
 * 覆盖：
 *   1) helper 不存在 → 优雅降级，有可读中文原因，不抛异常
 *   2) helper 存在但 probe 失败 → 同样优雅降级
 *   2b) probe 卡住（sleep 30）→ 超时保护，上层不会被拖住
 *   2c) 无辅助功能权限 → 文案与原版一致
 *   3) 非 darwin 平台 → 「当前系统暂不支持键盘防护」
 *   4) enable() 在无 helper 时返回 ok:false 且状态仍未启用
 *   5) 可用 helper（stub 脚本）→ getSupport ok:true；enable/换侧/disable 全链路
 *   6) disable() 幂等
 *   7) 安全输入开关与状态
 *   8) 权限查询抛异常时不崩
 *   9) 真实构建产物（若已 build）probe 实测
 *  10) 无残留 helper 进程（SIGTERM 清理）
 *
 * 安全边界：本自测只验证「开关/状态/清理」，stub helper 不涉及任何按键内容。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suisi-kg-selftest-'))

/* ---------- 加载器：TS 转译 + electron stub ---------- */
const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}

/** 可控 stub：辅助功能权限状态由用例注入 */
const stub = { accessibility: false, accessibilityThrows: false }
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      systemPreferences: {
        isTrustedAccessibilityClient: () => {
          if (stub.accessibilityThrows) throw new Error('stub: 权限查询抛异常')
          return stub.accessibility
        }
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
function skip(name, detail) {
  console.log(`SKIP  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/* ---------- 造 stub helper 脚本 ---------- */
function writeScript(name, body) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, body, 'utf8')
  fs.chmodSync(p, 0o755)
  return p
}

const GOOD_STUB = `#!/bin/sh
# 模拟「可用的」keyboard-guard：probe 报告能力；常驻模式打印就绪后等待 SIGTERM
if [ "$1" = "--probe" ]; then
  echo "GUARD_PROBE=1"
  echo "TAP_CREATABLE=1"
  echo "AX_TRUSTED=1"
  echo "SECURE_INPUT=0"
  exit 0
fi
case "$1" in
  --side)
    echo "GUARD_READY=1"; echo "MODE=guard"; echo "SIDE=$2" ;;
  --secure-input)
    echo "GUARD_READY=1"; echo "MODE=secure-input"; echo "SECURE_INPUT=1" ;;
  *)
    echo "GUARD_ERROR=未知参数"; exit 2 ;;
esac
trap 'echo stopped > "$KG_STOP_MARK"; echo "GUARD_STOPPED=1"; exit 0' TERM
while true; do sleep 0.1; done
`

const FAIL_STUB = `#!/bin/sh
echo "PROBE_REASON=模拟探测失败"
exit 3
`

const HANG_STUB = `#!/bin/sh
exec sleep 30
`

const NO_AX_STUB = `#!/bin/sh
if [ "$1" = "--probe" ]; then
  echo "GUARD_PROBE=1"
  echo "TAP_CREATABLE=0"
  echo "AX_TRUSTED=0"
  echo "SECURE_INPUT=0"
  exit 0
fi
echo "GUARD_ERROR=尚未获得辅助功能权限，键盘防护未生效。请在系统设置的辅助功能中允许本应用"
exit 5
`

/* ---------- 环境变量小工具 ---------- */
/*
 * 快速路径用宽裕超时（3000ms）。
 * 原先统一设 600ms，在整套测试并发跑、系统负载高时，连「立即退出的桩」都会被判成
 * 探测超时，于是「原因来自 helper」这条断言偶发失败——这是测试自身的不稳定，不是实现问题。
 * 真正要验证超时保护的用例（2b）会自己把超时调回 600ms。
 */
process.env.SUISI_KEYBOARD_GUARD_PROBE_TIMEOUT_MS = '3000'
process.env.SUISI_KEYBOARD_GUARD_READY_TIMEOUT_MS = '2000'

const kg = require(path.join(ROOT, 'src/main/keyboard-guard/index.ts'))

function useHelper(p) {
  if (p) process.env.SUISI_KEYBOARD_GUARD_HELPER = p
  else delete process.env.SUISI_KEYBOARD_GUARD_HELPER
  kg.__resetProbeCacheForTest()
}

const hasChinese = (s) => typeof s === 'string' && /[\u4e00-\u9fa5]/.test(s)

async function main() {
  const missingHelper = path.join(TMP, 'not-built', 'keyboard-guard')
  const failPath = writeScript('guard-fail.sh', FAIL_STUB)
  const hangPath = writeScript('guard-hang.sh', HANG_STUB)
  const noAxPath = writeScript('guard-no-ax.sh', NO_AX_STUB)
  const goodPath = writeScript('guard-ok.sh', GOOD_STUB)
  const stopMark = path.join(TMP, 'stop-mark.txt')
  process.env.KG_STOP_MARK = stopMark

  /* ============ 1. helper 不存在 ============ */
  useHelper(missingHelper)
  let s1 = null
  let threw = false
  try {
    s1 = kg.getSupport()
  } catch (e) {
    threw = true
    s1 = { reason: `抛异常：${e.message}` }
  }
  check('1. helper 不存在：不抛异常', !threw)
  check('1. helper 不存在：ok=false', s1.ok === false)
  check('1. helper 不存在：有可读中文原因', hasChinese(s1.reason), s1.reason)
  check('1. helper 不存在：helperPath=null', s1.helperPath === null)

  /* ============ 2. helper 存在但 probe 失败 ============ */
  useHelper(failPath)
  const s2 = kg.getSupport()
  check('2. probe 失败：ok=false（优雅降级）', s2.ok === false)
  check('2. probe 失败：原因来自 helper', /模拟探测失败/.test(s2.reason ?? ''), s2.reason)
  check('2. probe 失败：helperPath 已定位到该组件', s2.helperPath === failPath)

  /* ============ 2b. probe 卡住 → 超时保护 ============ */
  useHelper(hangPath)
  // 只有这一条需要「短超时」来验证超时保护，单独设置并在验证后恢复
  process.env.SUISI_KEYBOARD_GUARD_PROBE_TIMEOUT_MS = '600'
  const t0 = Date.now()
  const s2b = kg.getSupport()
  const elapsed = Date.now() - t0
  process.env.SUISI_KEYBOARD_GUARD_PROBE_TIMEOUT_MS = '3000'
  check('2b. probe 卡住：带超时返回（上层不卡死）', elapsed < 2000, `实测 ${elapsed}ms（预算 600ms）`)
  check('2b. probe 卡住：原因为超时', /超时/.test(s2b.reason ?? ''), s2b.reason)
  check('2b. probe 卡住：ok=false', s2b.ok === false)

  /* ============ 2c. 无辅助功能权限 ============ */
  stub.accessibility = false
  useHelper(noAxPath)
  const s2c = kg.getSupport()
  check('2c. 无权限：ok=false', s2c.ok === false)
  check('2c. 无权限：文案与原版一致', s2c.reason === kg.GUARD_TEXT.noPermission, s2c.reason)
  check('2c. 无权限：hasAccessibility=false', s2c.hasAccessibility === false)
  // Electron 说已授权、但系统实际建不了 tap → 换一条可读原因，不误报「没授权」
  stub.accessibility = true
  const s2d = kg.getSupport()
  check('2d. 权限状态冲突：给出「无法创建监听」而非「未授权」', s2d.ok === false && /无法创建键盘事件监听/.test(s2d.reason ?? ''), s2d.reason)
  check('2d. 权限状态冲突：hasAccessibility=true（来自 Electron）', s2d.hasAccessibility === true)
  stub.accessibility = false

  /* ============ 3. 非 darwin 平台 ============ */
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    useHelper(goodPath)
    const s3 = kg.getSupport()
    check('3. 非 darwin：ok=false', s3.ok === false)
    check('3. 非 darwin：文案为「当前系统暂不支持键盘防护」', s3.reason === '当前系统暂不支持键盘防护', s3.reason)
    check('3. 非 darwin：helperPath=null', s3.helperPath === null)
    const sec3 = await kg.setSecureInput(true)
    check('3. 非 darwin：setSecureInput 返回可读原因', sec3.ok === false && /暂不支持/.test(sec3.message), sec3.message)
  } finally {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  }

  /* ============ 4. enable() 无 helper ============ */
  useHelper(missingHelper)
  const r4 = await kg.enable('left')
  check('4. enable 无 helper：ok=false', r4.ok === false)
  check('4. enable 无 helper：message 可读', hasChinese(r4.message), r4.message)
  check('4. enable 无 helper：状态仍未启用', r4.status.enabled === false)
  const st4 = await kg.getStatus()
  check('4. enable 无 helper：getStatus().enabled=false', st4.enabled === false && st4.support.ok === false)
  const bad = await kg.enable('middle')
  check('4b. enable 非法侧参数：拒绝且不抛异常', bad.ok === false && /无效/.test(bad.message), bad.message)

  /* ============ 5. 可用 helper（stub） ============ */
  stub.accessibility = false // 故意不让 Electron 帮忙，验证 probe 结果被采信
  useHelper(goodPath)
  const s5 = kg.getSupport()
  check('5. 可用 helper：ok=true', s5.ok === true, JSON.stringify(s5))
  check('5. 可用 helper：hasAccessibility 取自 probe', s5.hasAccessibility === true)
  check('5. 可用 helper：helperPath 命中 stub', s5.helperPath === goodPath)

  /* ---- 5b. enable → 换侧 → disable 全链路 ---- */
  fs.rmSync(stopMark, { force: true })
  const r5b = await kg.enable('left')
  check('5b. enable(left)：ok=true 且文案「键盘防护已生效」', r5b.ok === true && r5b.message === kg.GUARD_TEXT.enabled, r5b.message)
  check('5b. enable(left)：status.enabled=true / side=left', r5b.status.enabled === true && r5b.status.side === 'left')

  const st5b = await kg.getStatus()
  check('5b. getStatus 反映已启用', st5b.enabled === true && st5b.side === 'left')

  const r5c = await kg.enable('right')
  check('5c. 换侧：side=right 且仍启用', r5c.ok === true && r5c.status.side === 'right' && r5c.status.enabled === true)

  const r5d = await kg.disable()
  check('5d. disable：enabled=false', r5d.enabled === false)
  check('5d. disable：helper 收到 SIGTERM 并自行清理', fs.existsSync(stopMark), `标记文件 ${path.basename(stopMark)} 已生成`)

  /* ============ 6. disable 幂等 ============ */
  const st6a = await kg.disable()
  const st6b = await kg.disable()
  check('6. disable 幂等（连续三次）', st6a.enabled === false && st6b.enabled === false, 'enabled=false')
  check('6. disable 后 getStatus 仍可读 support', st6b.support.ok === true)

  /* ============ 7. 安全输入 ============ */
  const st7 = await kg.getStatus()
  check('7. getStatus：secureInput 是布尔值', typeof st7.secureInput === 'boolean', String(st7.secureInput))
  const sec7 = await kg.setSecureInput(true)
  check('7. 安全输入开启：ok=true 且文案「安全输入中…」', sec7.ok === true && sec7.message === kg.GUARD_TEXT.secureInputOn, sec7.message)
  check('7. 安全输入开启：status.secureInput=true', sec7.status.secureInput === true)
  const sec7b = await kg.setSecureInput(true)
  check('7. 安全输入重复开启：幂等', sec7b.ok === true && sec7b.status.secureInput === true)
  const sec7c = await kg.setSecureInput(false)
  check('7. 安全输入关闭：ok=true 且 status.secureInput=false', sec7c.ok === true && sec7c.status.secureInput === false, sec7c.message)
  const sec7d = await kg.setSecureInput(false)
  check('7. 安全输入重复关闭：幂等', sec7d.ok === true && sec7d.status.secureInput === false)

  /* ============ 8. 权限查询抛异常时不崩 ============ */
  stub.accessibilityThrows = true
  useHelper(goodPath)
  let s8 = null
  let threw8 = false
  try {
    s8 = kg.getSupport()
  } catch (e) {
    threw8 = true
  }
  check('8. isTrustedAccessibilityClient 抛异常：getSupport 不抛', !threw8 && Boolean(s8))
  check('8. 权限查询异常：仍能给出可用结论', s8 && s8.ok === true, JSON.stringify(s8))
  stub.accessibilityThrows = false

  /* ============ 9. shutdown 幂等 ============ */
  await kg.shutdown()
  await kg.shutdown()
  check('9. shutdown 幂等且不抛异常', true)

  /* ============ 10. 真实构建产物 probe 实测 ============ */
  const realHelper = path.join(ROOT, 'native', 'keyboard-guard', 'keyboard-guard')
  if (fs.existsSync(realHelper)) {
    process.env.SUISI_KEYBOARD_GUARD_PROBE_TIMEOUT_MS = '3000'
    useHelper(realHelper)
    const s10 = kg.getSupport()
    console.log(`   [证据] 真实 helper：${realHelper}`)
    console.log(`   [证据] getSupport() => ${JSON.stringify(s10)}`)
    check(
      '10. 真实 helper：可用或给出可读原因（绝不抛异常）',
      s10.ok === true || hasChinese(s10.reason),
      s10.ok ? '本机支持键盘防护' : s10.reason
    )
    const st10 = await kg.getStatus()
    console.log(`   [证据] getStatus() => ${JSON.stringify({ enabled: st10.enabled, side: st10.side, secureInput: st10.secureInput, supportOk: st10.support.ok })}`)
  } else {
    skip('10. 真实 helper 实测', '未构建，请先运行 bash native/keyboard-guard/build.sh')
  }

  /* ============ 11. 无残留 helper 进程 ============ */
  const { execFileSync } = require('node:child_process')
  let leftover = ''
  try {
    leftover = execFileSync('/usr/bin/pgrep', ['-fl', path.basename(TMP)], { encoding: 'utf8' }).trim()
  } catch {
    leftover = '' // pgrep 无匹配时退出码 1
  }
  check('11. 无残留 helper 进程（全部已清理）', leftover === '', leftover || '干净')

  fs.rmSync(TMP, { recursive: true, force: true })

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
