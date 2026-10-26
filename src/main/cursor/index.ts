/**
 * 隐藏鼠标（安全模式）— 主进程侧封装
 *
 * 职责：驱动 native/cursor-hide/cursor-hide 这个原生 helper，把**真实系统光标**藏起来，
 * 由 renderer 的替代光标窗口（src/renderer/src/windows/cursor）给用户位置感。
 *
 * ⚠️ 安全契约（改代码前必读）：
 *   `CGDisplayHideCursor` 是按调用次数计数的，**进程退出不会自动恢复光标**。
 *   一旦「隐藏了但没恢复」，用户的鼠标就看不见了 —— 这比键盘防护留残留更严重。
 *   因此本模块遵守三条铁律：
 *     1) 常驻隐藏一律用 `--hold`（而不是 `--hide`）：hide 与 show 在**同一个进程内配对**，
 *        即使计数语义在系统版本间有差异也不会失配；
 *     2) `show()` / `shutdown()` **无条件**尝试恢复：先 SIGTERM 让 helper 自己 Show 再退出，
 *        随后**总是**再补一次 `--force-show` 兜底；
 *     3) 任何导出函数都不抛异常；失败也要把能恢复的动作做完再说失败。
 *   helper 侧另有父进程看门狗（--parent-pid）：Electron 崩溃时孤儿进程会先恢复光标再退出。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * 对外契约（签名不要改）
 * ------------------------------------------------------------------ */

export interface CursorSupport {
  ok: boolean
  reason?: string
  helperPath: string | null
}

export interface CursorActionResult {
  ok: boolean
  message: string
}

/** 原版文案（界面层可直接复用） */
export const CURSOR_TEXT = {
  label: '隐藏鼠标',
  desc: '在共享画面中隐藏真实鼠标。',
  hint: '自己可用替代光标，录屏/共享中不显示真实鼠标',
  hidden: '已隐藏鼠标',
  shown: '已恢复鼠标',
  unsupported: '当前系统暂不支持隐藏鼠标',
  failed: '隐藏鼠标失败，请重试。'
} as const

/* ------------------------------------------------------------------ *
 * 可调参数
 * ------------------------------------------------------------------ */

const ENV_HELPER = 'SUISI_CURSOR_HELPER'
const ENV_PROBE_TIMEOUT = 'SUISI_CURSOR_PROBE_TIMEOUT_MS'
const ENV_STATUS_TIMEOUT = 'SUISI_CURSOR_STATUS_TIMEOUT_MS'
const ENV_READY_TIMEOUT = 'SUISI_CURSOR_READY_TIMEOUT_MS'

const DEFAULT_PROBE_TIMEOUT_MS = 1500
const DEFAULT_STATUS_TIMEOUT_MS = 1500
const DEFAULT_READY_TIMEOUT_MS = 3000
const PROBE_CACHE_TTL_MS = 2000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/* ------------------------------------------------------------------ *
 * helper 定位
 * ------------------------------------------------------------------ */

function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function projectRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** 打包优先 Resources，开发期回退项目内 native/ 产物 */
export function resolveHelperPath(): string | null {
  const override = process.env[ENV_HELPER]
  if (override && override.trim()) {
    const p = override.trim()
    return isExecutableFile(p) ? p : null
  }

  const candidates: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'cursor-hide', 'cursor-hide'))
    candidates.push(path.join(resourcesPath, 'native', 'cursor-hide', 'cursor-hide'))
    candidates.push(path.join(resourcesPath, 'bin', 'cursor-hide'))
  }
  candidates.push(path.join(projectRoot(), 'native', 'cursor-hide', 'cursor-hide'))

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 子进程调用
 * ------------------------------------------------------------------ */

function field(output: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(output)
  return match ? match[1].trim() : null
}

interface OneShotResult {
  ok: boolean
  output: string
  reason?: string
}

/** 跑一次短命令（--probe / --status / --show / --force-show），带超时保护，绝不抛异常 */
function runOneShot(helperPath: string, args: string[], timeoutMs: number): OneShotResult {
  const result = spawnSync(helperPath, [...args, '--ledger', ledgerPath()], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    windowsHide: true
  })

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') return { ok: false, output: '', reason: `隐藏鼠标组件超时（${timeoutMs} 毫秒未返回）` }
    if (code === 'EACCES') return { ok: false, output: '', reason: '隐藏鼠标组件没有执行权限，请重新构建后重试' }
    return { ok: false, output: '', reason: `无法运行隐藏鼠标组件：${result.error.message}` }
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.signal === 'SIGKILL' || result.signal === 'SIGTERM') {
    return { ok: false, output, reason: `隐藏鼠标组件被强制结束（${result.signal}），可能是调用超时` }
  }
  return { ok: true, output, reason: field(output, 'CURSOR_ERROR') ?? undefined }
}

/** helper 的台账文件路径（与 helper 的默认值保持一致；测试可用环境变量覆盖） */
function ledgerPath(): string {
  const override = process.env['SUISI_CURSOR_LEDGER']
  if (override && override.trim()) return override.trim()
  const tmp = process.env['TMPDIR']
  const base = tmp && tmp.trim() ? tmp.trim().replace(/\/+$/, '') : '/tmp'
  return path.join(base, 'suisi-cursor-hide.json')
}

/* ------------------------------------------------------------------ *
 * getSupport
 * ------------------------------------------------------------------ */

interface ProbeResult extends CursorSupport {
  hideOk: boolean
  stale: boolean
}

let probeCache: { helperPath: string; at: number; result: ProbeResult } | null = null

function probeHelper(helperPath: string): ProbeResult {
  const now = Date.now()
  if (probeCache && probeCache.helperPath === helperPath && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }

  const base: ProbeResult = { ok: false, helperPath, hideOk: false, stale: false }
  const run = runOneShot(helperPath, ['--probe'], envInt(ENV_PROBE_TIMEOUT, DEFAULT_PROBE_TIMEOUT_MS))

  let result: ProbeResult
  if (!run.ok) {
    result = { ...base, reason: run.reason ?? '隐藏鼠标探测失败，请重试' }
  } else if (!run.output.includes('CURSOR_PROBE=1')) {
    result = { ...base, reason: '隐藏鼠标组件探测失败（输出异常）' }
  } else {
    const hideOk = field(run.output, 'HIDE_OK') === '1'
    const stale = field(run.output, 'STALE') === '1'
    result = hideOk
      ? { ok: true, helperPath, hideOk, stale }
      : {
          ok: false,
          helperPath,
          hideOk,
          stale,
          reason: field(run.output, 'PROBE_REASON') ?? '系统不允许隐藏鼠标，隐藏鼠标未生效。'
        }
  }
  probeCache = { helperPath, at: now, result }
  return result
}

export function getSupport(): CursorSupport {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: CURSOR_TEXT.unsupported, helperPath: null }
  }
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    return {
      ok: false,
      reason: '未找到隐藏鼠标组件（cursor-hide），请重新构建或重新安装本应用',
      helperPath: null
    }
  }
  const probe = probeHelper(helperPath)
  return { ok: probe.ok, reason: probe.reason, helperPath: probe.helperPath }
}

/* ------------------------------------------------------------------ *
 * 常驻 holder（--hold）
 * ------------------------------------------------------------------ */

let holder: ChildProcess | null = null
let exitHookInstalled = false

function isRunning(child: ChildProcess | null): boolean {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // 主进程真要退出时，尽力让 helper 走它的清理路径（SIGTERM → 先 Show 再退）
  process.once('exit', () => {
    if (isRunning(holder)) {
      try {
        holder?.kill('SIGTERM')
      } catch {
        /* 忽略 */
      }
    }
  })
}

function waitForReady(child: ChildProcess, marker: string, timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let timer: NodeJS.Timeout | null = null

    const finish = (ok: boolean, detail?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout?.off('data', onOut)
      child.stderr?.off('data', onOut)
      child.off('exit', onExit)
      child.off('error', onSpawnError)
      resolve({ ok, detail })
    }
    const onOut = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      if (buffer.includes(marker)) finish(true)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        false,
        field(buffer, 'CURSOR_ERROR') ??
          `隐藏鼠标组件启动后立即退出（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`
      )
    }
    const onSpawnError = (error: Error): void => {
      finish(false, `无法启动隐藏鼠标组件：${error.message}`)
    }

    timer = setTimeout(() => finish(false, CURSOR_TEXT.failed), timeoutMs)
    child.stdout?.on('data', onOut)
    child.stderr?.on('data', onOut)
    child.once('exit', onExit)
    child.once('error', onSpawnError)
  })
}

/** 停掉常驻 holder：SIGTERM（helper 会先恢复光标）→ 等退出 → 超时才 SIGKILL */
function stopHolder(graceMs = 2000): Promise<boolean> {
  const child = holder
  holder = null
  if (!isRunning(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let done = false
    let killTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let exitedGracefully = false
    const finish = (): void => {
      if (done) return
      done = true
      if (killTimer) clearTimeout(killTimer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve(exitedGracefully)
    }

    child?.once('exit', () => {
      exitedGracefully = true
      finish()
    })
    try {
      child?.kill('SIGTERM')
    } catch {
      finish()
      return
    }
    killTimer = setTimeout(() => {
      try {
        if (isRunning(child)) child?.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, graceMs)
    hardTimer = setTimeout(finish, graceMs + 500)
  })
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

interface StatusResult {
  ok: boolean
  hidden: boolean
  stale: boolean
  visible: boolean | null
  reason?: string
}

function readStatus(helperPath: string): StatusResult {
  const run = runOneShot(helperPath, ['--status'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
  if (!run.ok || !run.output.includes('CURSOR_STATUS=1')) {
    return { ok: false, hidden: false, stale: false, visible: null, reason: run.reason ?? '读取隐藏鼠标状态失败' }
  }
  const visibleRaw = field(run.output, 'CURSOR_VISIBLE')
  const ledgerCount = Number(field(run.output, 'LEDGER_COUNT') ?? '0')
  const stale = field(run.output, 'STALE') === '1'
  /*
   * 是否「我们把它藏起来了」只由台账决定，不看 helper 的 HIDDEN 字段。
   *
   * 原因：helper 的 HIDDEN 由 CURSOR_VISIBLE 推导，而那个系统查询**不可信**——
   * 实测在完全没有 hold 进程时它会瞬时返回 0（例如系统「打字时自动隐藏光标」），
   * 于是 HIDDEN 变成 1，调用方就会误以为光标被我们藏了，多发一次无谓的 Show。
   * 判据：台账还有欠账（count>0）或台账陈旧（stale，说明有 hold 被强杀）。
   */
  return {
    ok: true,
    hidden: ledgerCount > 0 || stale,
    stale,
    visible: visibleRaw === null ? null : visibleRaw === '1'
  }
}

/* ------------------------------------------------------------------ *
 * hide / show
 * ------------------------------------------------------------------ */

export async function hide(): Promise<CursorActionResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: CURSOR_TEXT.unsupported }
  }
  const support = getSupport()
  if (!support.ok || !support.helperPath) {
    return { ok: false, message: support.reason ?? CURSOR_TEXT.failed }
  }
  const helperPath = support.helperPath

  if (isRunning(holder)) {
    return { ok: true, message: CURSOR_TEXT.hidden }
  }

  // 上一次可能异常退出留下了「欠着的隐藏」，先把光标拉回来再重新隐藏，避免计数叠高
  const status = readStatus(helperPath)
  if (status.ok && status.stale) {
    runOneShot(helperPath, ['--force-show'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
  }

  installExitHook()
  const child = spawn(helperPath, ['--hold', '--parent-pid', String(process.pid), '--ledger', ledgerPath()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const ready = await waitForReady(child, 'CURSOR_READY=1', envInt(ENV_READY_TIMEOUT, DEFAULT_READY_TIMEOUT_MS))

  if (!ready.ok) {
    await stopHolder(1200)
    // 启动失败也要确认光标没被留在隐藏态
    runOneShot(helperPath, ['--force-show'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
    return { ok: false, message: ready.detail ?? CURSOR_TEXT.failed }
  }

  holder = child
  child.stdout?.resume()
  child.stderr?.resume()
  return { ok: true, message: CURSOR_TEXT.hidden }
}

/**
 * 恢复显示。**无条件**尝试恢复：
 *   ① SIGTERM 常驻 holder（它自己会先 Show 再退）
 *   ② 再补一次 --force-show 兜底（即使 holder 已经不在也照样执行）
 */
export async function show(): Promise<CursorActionResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: CURSOR_TEXT.unsupported }
  }
  const helperPath = resolveHelperPath()
  const graceful = await stopHolder()

  if (!helperPath) {
    return { ok: false, message: '未找到隐藏鼠标组件（cursor-hide），无法确认光标已恢复' }
  }

  const forced = runOneShot(helperPath, ['--force-show'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
  if (!forced.ok && !graceful) {
    return { ok: false, message: forced.reason ?? '恢复鼠标失败，请重试。' }
  }
  return { ok: true, message: CURSOR_TEXT.shown }
}

export async function isHidden(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const helperPath = resolveHelperPath()
  if (!helperPath) {
    // helper 缺失时，本进程持有的隐藏仍算隐藏（但通常此时并没有隐藏）
    return isRunning(holder)
  }
  const status = readStatus(helperPath)
  if (!status.ok) {
    // 状态读不到时，退化为「本进程是否持有隐藏」这一保守判断
    return isRunning(holder)
  }
  // 以台账为准（确定性），系统查询只作诊断：
  //   · 台账 count>0 → 我们欠着一次 Show，光标极可能仍被隐藏 → true
  //   · 台账干净但 CURSOR_VISIBLE=0 → **不能**判定为「随思隐藏中」：
  //     实测该查询会瞬时变 0（系统「打字时自动隐藏光标」等），把它当权威会误报，
  //     进而让界面/调用方多发一次不必要的 Show。详见 native/cursor-hide/README.md
  return status.hidden || isRunning(holder)
}

/* ------------------------------------------------------------------ *
 * shutdown（附加导出：建议在 app.before-quit 调用）
 * ------------------------------------------------------------------ */

let shutdownDone = false

/** 幂等；无论调用多少次、当前是否隐藏，都会尝试把光标恢复回来 */
export async function shutdown(): Promise<void> {
  if (shutdownDone) {
    // 幂等：已收尾过也不再抛异常，但仍再补一次恢复（廉价且安全）
    const helperPath = resolveHelperPath()
    if (helperPath && process.platform === 'darwin') {
      runOneShot(helperPath, ['--force-show'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
    }
    return
  }
  shutdownDone = true

  await stopHolder()
  if (process.platform === 'darwin') {
    const helperPath = resolveHelperPath()
    if (helperPath) {
      runOneShot(helperPath, ['--force-show'], envInt(ENV_STATUS_TIMEOUT, DEFAULT_STATUS_TIMEOUT_MS))
    }
  }
}

/** 仅测试用：清掉 probe 缓存并复位 shutdown 标记 */
export function __resetForTest(): void {
  probeCache = null
  shutdownDone = false
}
