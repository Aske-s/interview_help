import { exec } from 'node:child_process'
import { app, systemPreferences } from 'electron'
import { settingsStore } from '../store/settings'
import type { CheckState, SecurityCheckItem, SecurityCheckResult } from '@shared/types'

/**
 * 环境检查：检测录屏 / 屏幕共享 / 安全软件，以及防录屏是否真的生效。
 *
 * 设计原则（对齐原版）：
 *  - 「检测结果不影响其他功能使用」——本模块只做提示，绝不阻断任何功能
 *  - 检测手段是进程名 + 权限状态 + 组件状态，属启发式，会漏报，因此如实说明
 */

/** 录屏 / 屏幕共享 / 会议软件 */
const RECORDER_PATTERNS: Array<{ match: string; name: string }> = [
  { match: 'zoom.us', name: 'Zoom' },
  { match: 'TencentMeeting', name: '腾讯会议' },
  { match: 'wemeet', name: '腾讯会议' },
  { match: 'feishu', name: '飞书' },
  { match: 'Lark', name: '飞书' },
  { match: 'DingTalk', name: '钉钉' },
  { match: 'Microsoft Teams', name: 'Microsoft Teams' },
  { match: 'obs', name: 'OBS' },
  { match: 'ScreenFlow', name: 'ScreenFlow' },
  { match: 'Camtasia', name: 'Camtasia' },
  { match: 'QuickTime Player', name: 'QuickTime Player' },
  { match: 'Recordit', name: 'Recordit' },
  { match: 'Loom', name: 'Loom' },
  { match: 'Snagit', name: 'Snagit' },
  { match: 'CleanShot', name: 'CleanShot X' },
  { match: 'ScreenRecorder', name: '录屏工具' },
  { match: 'sunlogin', name: '向日葵' },
  { match: 'todesk', name: 'ToDesk' },
  { match: 'TeamViewer', name: 'TeamViewer' },
  { match: 'AnyDesk', name: 'AnyDesk' }
]

/**
 * 杀毒 / 防火墙等安全软件。
 * 它们可能拦截窗口防录屏能力，导致共享画面出现黑框。
 */
const SECURITY_PATTERNS: Array<{ match: string; name: string }> = [
  // 国际
  { match: 'Sophos', name: 'Sophos' },
  { match: 'Kaspersky', name: '卡巴斯基' },
  { match: 'Norton', name: 'Norton' },
  { match: 'McAfee', name: 'McAfee' },
  { match: 'Bitdefender', name: 'Bitdefender' },
  { match: 'Avast', name: 'Avast' },
  { match: 'AVG', name: 'AVG' },
  { match: 'ESET', name: 'ESET' },
  { match: 'Malwarebytes', name: 'Malwarebytes' },
  { match: 'CrowdStrike', name: 'CrowdStrike' },
  { match: 'SentinelOne', name: 'SentinelOne' },
  { match: 'LittleSnitch', name: 'Little Snitch' },
  { match: 'LuLu', name: 'LuLu 防火墙' },
  // 国内
  { match: '360', name: '360 安全卫士' },
  { match: 'ZhuDongFangYu', name: '360 主动防御' },
  { match: 'huorong', name: '火绒' },
  { match: 'HipsTray', name: '火绒' },
  { match: 'QQPCTray', name: '腾讯电脑管家' },
  { match: 'BaiduSd', name: '百度卫士' },
  { match: 'Kingsoft', name: '金山毒霸' }
]

/** 取当前进程列表（一次调用供两类检测复用） */
function listProcesses(): Promise<string> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      exec('tasklist /FO CSV /NH', { timeout: 5000 }, (_err, stdout) => resolve(stdout ?? ''))
    })
  }
  return new Promise((resolve) => {
    exec('ps -axo comm,args', { timeout: 5000 }, (_err, stdout) => resolve(stdout ?? ''))
  })
}

/**
 * 按关键词匹配软件名。
 * 必须忽略大小写：真实进程名大小写混杂（OBS.app / obs64.exe、Snagit / snagit），
 * 大小写敏感会漏检。
 */
function matchPatterns(haystack: string, patterns: Array<{ match: string; name: string }>): string[] {
  const lower = haystack.toLowerCase()
  const found = new Set<string>()
  for (const pattern of patterns) {
    if (lower.includes(pattern.match.toLowerCase())) found.add(pattern.name)
  }
  return [...found]
}

/* ------------------------------------------------------------------ *
 * 检查结果的轻量持久化，供各窗口共享
 * ------------------------------------------------------------------ */

let cached: CheckState = {}

export function getCheckState(): CheckState {
  return cached
}

export function setDeviceCheck(result: CheckState['device']): CheckState {
  cached = { ...cached, device: result }
  return cached
}

export function setSecurityCheck(result: SecurityCheckResult): CheckState {
  cached = { ...cached, security: result }
  return cached
}

/** 供主进程内部（如悬浮窗编排）快速判断环境是否安全 */
export function currentRecorders(): string[] {
  return cached.security?.detections.recorders ?? []
}

/** 应用名，用于在建议文案里指代自己 */
export function appName(): string {
  return app.getName()
}

export async function scanEnvironment(): Promise<SecurityCheckResult> {
  const settings = settingsStore.get()
  const items: SecurityCheckItem[] = []

  /* ---- 1. 防录屏保护本身 ---- */
  const protectionSupported = process.platform === 'darwin' || process.platform === 'win32'
  if (!settings.stealth.contentProtection) {
    items.push({
      id: 'content-protection',
      label: '防录屏保护',
      status: 'warn',
      message: '未开启。开启后本应用窗口会从录屏与截屏中隐藏。',
      advice: '在「隐身与安全」里打开「防录屏保护」'
    })
  } else if (!protectionSupported) {
    items.push({
      id: 'content-protection',
      label: '防录屏保护',
      status: 'unknown',
      message: `当前系统（${process.platform}）不支持防录屏保护。`,
      advice: '本应用仍可正常使用，只是窗口无法从录屏中隐藏'
    })
  } else {
    items.push({
      id: 'content-protection',
      label: '防录屏保护',
      status: 'pass',
      message: '已开启，本应用窗口已从录屏与截屏中隐藏。'
    })
  }

  /* ---- 2. 进程扫描：录屏/共享软件 + 安全软件 ---- */
  let processList = ''
  let scanFailed = false
  try {
    processList = await listProcesses()
  } catch {
    scanFailed = true
  }

  const recorders = scanFailed ? [] : matchPatterns(processList, RECORDER_PATTERNS)
  const securitySoftware = scanFailed ? [] : matchPatterns(processList, SECURITY_PATTERNS)

  if (scanFailed) {
    items.push({
      id: 'screen-recording',
      label: '屏幕录制检测',
      status: 'unknown',
      message: '检测未完成：无法读取系统进程列表。',
      advice: '可继续使用；如需确认，请手动检查是否有录屏或共享软件在运行'
    })
  } else if (recorders.length) {
    items.push({
      id: 'screen-recording',
      label: '屏幕录制检测',
      status: 'warn',
      message: `检测到录屏/屏幕共享软件正在运行：${recorders.join('、')}。`,
      advice: '防录屏保护可阻止本应用窗口被录屏捕获；若仍担心暴露，建议开启「安全模式」'
    })
  } else {
    items.push({
      id: 'screen-recording',
      label: '屏幕录制检测',
      status: 'pass',
      message: '未检测到录屏或屏幕共享软件在运行。'
    })
  }

  if (scanFailed) {
    /* 已在上面给出 unknown，不再重复一项 */
  } else if (securitySoftware.length) {
    items.push({
      id: 'security-software',
      label: '防火墙 / 杀毒软件检测',
      status: 'warn',
      message: `检测到安全软件正在运行（${securitySoftware.join('、')}）。可能导致共享画面出现黑框，或拦截防录屏组件。`,
      advice: '建议把本应用加入该软件的白名单后重新检测'
    })
  } else {
    items.push({
      id: 'security-software',
      label: '防火墙 / 杀毒软件检测',
      status: 'pass',
      message: '未检测到会干扰防录屏的安全软件。'
    })
  }

  /* ---- 3. 辅助功能权限（键盘防护 / 全局快捷键依赖） ---- */
  if (process.platform === 'darwin') {
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      trusted = false
    }
    items.push({
      id: 'accessibility',
      label: '辅助功能权限',
      status: trusted ? 'pass' : 'warn',
      message: trusted ? '已授权，全局快捷键可正常工作。' : '尚未获得辅助功能权限，部分全局快捷键可能无法生效。',
      advice: trusted ? undefined : '在「系统设置 → 隐私与安全性 → 辅助功能」中允许本应用'
    })
  }

  /* ---- 4. 安全模式状态 ---- */
  items.push({
    id: 'safe-mode',
    label: '安全模式',
    status: settings.stealth.safeMode ? 'pass' : 'unknown',
    message: settings.stealth.safeMode
      ? '已开启：检测到录屏或共享时会自动隐藏悬浮窗并告警。'
      : '未开启。开启后，检测到录屏或屏幕共享时会自动隐藏悬浮窗。',
    advice: settings.stealth.safeMode ? undefined : '在「隐身与安全」里打开「安全模式」'
  })

  /* ---- 汇总 ---- */
  const hasRisk = items.some((i) => i.status === 'fail')
  const hasWarn = items.some((i) => i.status === 'warn')
  const allUnknown = items.every((i) => i.status === 'unknown')
  const risk: SecurityCheckResult['risk'] = hasRisk ? 'risk' : hasWarn ? 'warn' : allUnknown ? 'unknown' : 'safe'

  const summary = hasRisk
    ? '环境存在风险，请处理下列问题'
    : hasWarn
      ? '环境基本可用，但有需要留意的地方'
      : allUnknown
        ? '检测未完成'
        : '环境安全'

  const result: SecurityCheckResult = {
    items,
    risk,
    summary,
    detections: { recorders, securitySoftware },
    checkedAt: Date.now()
  }
  // 由本函数统一写缓存：保证「调用即已记录」，避免调用方忘记同步
  setSecurityCheck(result)
  return result
}

