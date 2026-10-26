/**
 * 键盘防护 / 安全输入（主进程侧封装）
 *
 * 职责：定位并驱动 native/keyboard-guard/keyboard-guard 这个原生 helper。
 *
 * 安全边界（重要，改动前先读）：
 *   本模块是**防御性隐私**功能。它只做两件事：
 *     1) 让 helper 吞掉某一侧 Command 相关的键盘事件（键盘记录器因此看不到这些按键）；
 *     2) 开关 macOS 的 Secure Event Input。
 *   本模块与 helper 都**不读取、不缓存、不落盘、不上报任何按键内容**，
 *   只传递「是否启动成功 / 是否已启用」这类状态。请不要在这里加任何按键内容相关的日志。
 *
 * 契约：
 *   - 所有导出函数都不抛异常；失败一律返回 { ok:false, message: 可读中文原因 }。
 *   - getSupport() 是同步的：它用带超时的 spawnSync 跑一次 `--probe`，不会卡住主进程。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { systemPreferences } from 'electron'

/* ------------------------------------------------------------------ *
 * 类型（对外契约，签名不要改）
 * ------------------------------------------------------------------ */

export type GuardSide = 'left' | 'right' | 'both'

export interface GuardSupport {
  ok: boolean
  /** 不可用时的人类可读原因 */
  reason?: string
  /** helper 可执行文件路径（不存在时为 null） */
  helperPath: string | null
  /** 是否已获得辅助功能权限 */
  hasAccessibility: boolean
}

export interface GuardStatus {
  /** 键盘防护是否启用 */
  enabled: boolean
  side: GuardSide
  /** 安全输入是否处于开启状态 */
  secureInput: boolean
  support: GuardSupport
}

export interface GuardActionResult {
  ok: boolean
  message: string
  status: GuardStatus
}

/* ------------------------------------------------------------------ *
 * 文案常量（与原版语义对齐，界面层可直接复用）
 * ------------------------------------------------------------------ */

export const GUARD_TEXT = {
  enabled: '键盘防护已生效',
  failed: '键盘防护未生效，请重试。',
  unsupported: '当前系统暂不支持键盘防护',
  noPermission: '尚未获得辅助功能权限，键盘防护未生效。请在系统设置的辅助功能中允许AI 面试助手',
  secureInputOn: '安全输入中…',
  secureInputOff: '点击开始安全输入'
} as const

const GUARD_SIDES: GuardSide[] = ['left', 'right', 'both']

/* ------------------------------------------------------------------ *
 * 可调参数（测试/排障可用环境变量覆盖）
 * ------------------------------------------------------------------ */

/** helper 路径覆盖：显式指定即视为权威（指向不存在的文件时不再回退其它候选路径） */
const ENV_HELPER = 'SUISI_KEYBOARD_GUARD_HELPER'
const ENV_PROBE_TIMEOUT = 'SUISI_KEYBOARD_GUARD_PROBE_TIMEOUT_MS'
const ENV_READY_TIMEOUT = 'SUISI_KEYBOARD_GUARD_READY_TIMEOUT_MS'

const DEFAULT_PROBE_TIMEOUT_MS = 1500
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

/** 向上找 package.json，兼容 out/main（打包/构建产物）与源码目录 */
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
    candidates.push(path.join(resourcesPath, 'keyboard-guard', 'keyboard-guard'))
    candidates.push(path.join(resourcesPath, 'native', 'keyboard-guard', 'keyboard-guard'))
    candidates.push(path.join(resourcesPath, 'bin', 'keyboard-guard'))
  }
  candidates.push(path.join(projectRoot(), 'native', 'keyboard-guard', 'keyboard-guard'))

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 辅助功能权限（辅助功能权限查询本身也可能抛，一律吞掉）
 * ------------------------------------------------------------------ */

function readAccessibility(): boolean {
  try {
    const sp = systemPreferences as unknown as { isTrustedAccessibilityClient?: (prompt: boolean) => boolean }
    if (sp && typeof sp.isTrustedAccessibilityClient === 'function') {
      return Boolean(sp.isTrustedAccessibilityClient(false))
    }
  } catch {
    /* 忽略：拿不到权限状态时按「未授权」处理，绝不抛给调用方 */
  }
  return false
}

/* ------------------------------------------------------------------ *
 * --probe
 * ------------------------------------------------------------------ */

interface ProbeResult {
  ok: boolean
  tapCreatable: boolean
  axTrusted: boolean
  /** null 表示 helper 未上报（老版本 helper） */
  secureInput: boolean | null
  reason?: string
}

function field(output: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(output)
  return match ? match[1].trim() : null
}

function runProbeSync(helperPath: string): ProbeResult {
  const timeout = envInt(ENV_PROBE_TIMEOUT, DEFAULT_PROBE_TIMEOUT_MS)
  const base: ProbeResult = { ok: false, tapCreatable: false, axTrusted: false, secureInput: null }

  const result = spawnSync(helperPath, ['--probe'], {
    timeout,
    // 超时用 SIGKILL：helper 不会因为忙而忽略 SIGTERM，避免上层被拖住
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    windowsHide: true
  })

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') {
      return { ...base, reason: `键盘防护探测超时（组件未在 ${timeout} 毫秒内返回）` }
    }
    if (code === 'EACCES') {
      return { ...base, reason: '键盘防护组件没有执行权限，请重新构建后重试' }
    }
    return { ...base, reason: `无法运行键盘防护组件：${result.error.message}` }
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

  if (result.signal === 'SIGKILL' || result.signal === 'SIGTERM') {
    return { ...base, reason: `键盘防护探测被强制结束（${result.signal}），可能是探测超时` }
  }
  if (!output.includes('GUARD_PROBE=1')) {
    const helperReason = field(output, 'PROBE_REASON') ?? field(output, 'GUARD_ERROR')
    return {
      ...base,
      reason: helperReason ?? `键盘防护组件探测失败（退出码 ${result.status ?? '未知'}）`
    }
  }

  const tapCreatable = field(output, 'TAP_CREATABLE') === '1'
  const axTrusted = field(output, 'AX_TRUSTED') === '1'
  const secureRaw = field(output, 'SECURE_INPUT')
  const secureInput = secureRaw === null ? null : secureRaw === '1'

  return {
    ok: true,
    tapCreatable,
    axTrusted,
    secureInput,
    reason: field(output, 'PROBE_REASON') ?? undefined
  }
}

let probeCache: { helperPath: string; at: number; result: ProbeResult } | null = null

function probeHelper(helperPath: string): ProbeResult {
  const now = Date.now()
  if (probeCache && probeCache.helperPath === helperPath && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result
  }
  const result = runProbeSync(helperPath)
  probeCache = { helperPath, at: now, result }
  return result
}

/* ------------------------------------------------------------------ *
 * getSupport
 * ------------------------------------------------------------------ */

export function getSupport(): GuardSupport {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: GUARD_TEXT.unsupported, helperPath: null, hasAccessibility: false }
  }

  const hasAccessibility = readAccessibility()
  const helperPath = resolveHelperPath()

  if (!helperPath) {
    return {
      ok: false,
      reason: '未找到键盘防护组件（keyboard-guard），请重新构建或重新安装本应用',
      helperPath: null,
      hasAccessibility
    }
  }

  const probe = probeHelper(helperPath)
  const ax = hasAccessibility || probe.axTrusted

  if (!probe.ok) {
    return { ok: false, reason: probe.reason ?? GUARD_TEXT.failed, helperPath, hasAccessibility: ax }
  }
  if (!probe.tapCreatable) {
    // 权限缺失与「系统拒绝」要分开说，否则用户不知道该去点哪里。
    // 只要 Electron 或 helper 任一方认为已授权，就不要再让用户去授权（那会让人反复点却没有出路）。
    return {
      ok: false,
      reason: ax ? '无法创建键盘事件监听，键盘防护未生效，请重试。' : GUARD_TEXT.noPermission,
      helperPath,
      hasAccessibility: ax
    }
  }
  return { ok: true, helperPath, hasAccessibility: ax }
}

/* ------------------------------------------------------------------ *
 * 常驻子进程管理
 * ------------------------------------------------------------------ */

let guardChild: ChildProcess | null = null
let secureChild: ChildProcess | null = null
let currentSide: GuardSide = 'right'
let exitHookInstalled = false

function isRunning(child: ChildProcess | null): boolean {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // 主进程真的要退出时，尽力收掉子进程（helper 自己还有父进程看门狗兜底）
  process.once('exit', () => {
    for (const child of [guardChild, secureChild]) {
      if (isRunning(child)) {
        try {
          child?.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
      }
    }
  })
}

function spawnHelper(helperPath: string, args: string[]): ChildProcess {
  installExitHook()
  return spawn(helperPath, [...args, '--parent-pid', String(process.pid)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

interface ReadyResult {
  ok: boolean
  detail?: string
}

/** 等 helper 打印就绪标记；超时/提前退出都返回可读原因，不抛异常 */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<ReadyResult> {
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let timer: NodeJS.Timeout | null = null

    const finish = (ok: boolean, detail?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onError2)
      child.off('exit', onExit)
      child.off('error', onSpawnError)
      resolve({ ok, detail })
    }

    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      if (buffer.includes('GUARD_READY=1')) finish(true)
    }
    const onError2 = (chunk: Buffer | string): void => {
      buffer += String(chunk)
      if (buffer.includes('GUARD_READY=1')) finish(true)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const reason = field(buffer, 'GUARD_ERROR')
      finish(
        false,
        reason ??
          `键盘防护组件启动后立即退出（code=${code === null ? 'null' : code}${
            signal ? `, signal=${signal}` : ''
          }）`
      )
    }
    const onSpawnError = (error: Error): void => {
      finish(false, `无法启动键盘防护组件：${error.message}`)
    }

    timer = setTimeout(() => finish(false, GUARD_TEXT.failed), timeoutMs)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onError2)
    child.once('exit', onExit)
    child.once('error', onSpawnError)
  })
}

/** 先 SIGTERM 让 helper 自己清理，到点再 SIGKILL；幂等 */
function stopChild(which: 'guard' | 'secure', graceMs = 2000): Promise<void> {
  const child = which === 'guard' ? guardChild : secureChild
  if (which === 'guard') guardChild = null
  else secureChild = null

  if (!isRunning(child)) return Promise.resolve()

  return new Promise((resolve) => {
    let done = false
    let killTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    const finish = (): void => {
      if (done) return
      done = true
      if (killTimer) clearTimeout(killTimer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve()
    }

    child?.once('exit', finish)
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
 * getStatus
 * ------------------------------------------------------------------ */

export async function getStatus(): Promise<GuardStatus> {
  const support = getSupport()
  const guardAlive = isRunning(guardChild)

  let secureInput = isRunning(secureChild)
  if (!secureInput && support.helperPath) {
    // 非本进程持有的安全输入也可能处于开启状态（例如上次异常退出残留），以系统实际状态为准
    const probe = probeHelper(support.helperPath)
    if (probe.ok && probe.secureInput !== null) secureInput = probe.secureInput
  }

  return { enabled: guardAlive, side: currentSide, secureInput, support }
}

/* ------------------------------------------------------------------ *
 * enable / disable
 * ------------------------------------------------------------------ */

export async function enable(side: GuardSide): Promise<GuardActionResult> {
  if (!GUARD_SIDES.includes(side)) {
    return { ok: false, message: '键盘防护侧参数无效（只允许 left / right / both）', status: await getStatus() }
  }

  const support = getSupport()
  if (!support.ok || !support.helperPath) {
    return { ok: false, message: support.reason ?? GUARD_TEXT.failed, status: await getStatus() }
  }

  if (isRunning(guardChild)) {
    if (currentSide === side) {
      return { ok: true, message: GUARD_TEXT.enabled, status: await getStatus() }
    }
    // 换侧：先停掉旧进程，避免两个 helper 同时吞事件
    await stopChild('guard')
  }

  const child = spawnHelper(support.helperPath, ['--side', side])
  const ready = await waitForReady(child, envInt(ENV_READY_TIMEOUT, DEFAULT_READY_TIMEOUT_MS))

  if (!ready.ok) {
    guardChild = null
    await killQuietly(child)
    return { ok: false, message: ready.detail ?? GUARD_TEXT.failed, status: await getStatus() }
  }

  guardChild = child
  currentSide = side
  child.stdout?.resume()
  child.stderr?.resume()
  return { ok: true, message: GUARD_TEXT.enabled, status: await getStatus() }
}

async function killQuietly(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* 忽略 */
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        if (isRunning(child)) child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
      done()
    }, 1500)
    child.once('exit', done)
  })
}

export async function disable(): Promise<GuardStatus> {
  await stopChild('guard')
  return getStatus()
}

/* ------------------------------------------------------------------ *
 * setSecureInput
 * ------------------------------------------------------------------ */

export async function setSecureInput(on: boolean): Promise<GuardActionResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: '当前系统暂不支持安全输入', status: await getStatus() }
  }

  if (!on) {
    await stopChild('secure')
    return { ok: true, message: GUARD_TEXT.secureInputOff, status: await getStatus() }
  }

  const support = getSupport()
  if (!support.ok || !support.helperPath) {
    return { ok: false, message: support.reason ?? '安全输入开启失败，请重试。', status: await getStatus() }
  }

  if (isRunning(secureChild)) {
    return { ok: true, message: GUARD_TEXT.secureInputOn, status: await getStatus() }
  }

  // Secure Event Input 按进程计数：必须让 helper 常驻持有，进程一退就失效
  const child = spawnHelper(support.helperPath, ['--secure-input', 'on'])
  const ready = await waitForReady(child, envInt(ENV_READY_TIMEOUT, DEFAULT_READY_TIMEOUT_MS))

  if (!ready.ok) {
    secureChild = null
    await killQuietly(child)
    return { ok: false, message: ready.detail ?? '安全输入开启失败，请重试。', status: await getStatus() }
  }

  secureChild = child
  child.stdout?.resume()
  child.stderr?.resume()
  return { ok: true, message: GUARD_TEXT.secureInputOn, status: await getStatus() }
}

/* ------------------------------------------------------------------ *
 * 退出清理（附加导出：Lead 在 app.before-quit 时调用即可）
 * ------------------------------------------------------------------ */

/** 收掉所有 helper。不调用也不会残留：helper 自带父进程看门狗。 */
export async function shutdown(): Promise<void> {
  await Promise.all([stopChild('guard'), stopChild('secure')])
}

/** 仅测试用：清掉 probe 缓存，让下一次 getSupport() 重新探测 */
export function __resetProbeCacheForTest(): void {
  probeCache = null
}
