import { spawn, type ChildProcess } from 'node:child_process'
import type { AsrConfig } from '@shared/types'

/**
 * whisper-server 生命周期管理。
 *
 * 为什么必须常驻：实测同一段 6.2 秒音频，
 *   每次调 whisper-cli（重载 465MB 模型）约 14.9 秒
 *   常驻 whisper-server 约 1.0 秒
 * 实时助答只能走常驻；CLI 仅适合离线批量。
 *
 * 这里只负责「检查端口 → 没在跑就拉起来 → 退出时收掉」，
 * 且**只关我们自己拉起的那个进程**，不动用户手动启动的实例。
 */

let child: ChildProcess | null = null
/** 是否由本进程拉起（决定退出时要不要关掉） */
let ownedByUs = false

/** 探测服务是否已就绪 */
export async function isServerUp(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** 解析端口，默认 8178（与 whisper.cpp 文档示例一致） */
function portOf(url: string): number {
  try {
    const parsed = new URL(url)
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 8178
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

/**
 * 确保服务可用。
 *
 * 已就绪 → 直接返回 true；
 * 未就绪且允许自动拉起 → 启动并等待就绪（最多 waitMs）。
 */
export async function ensureServer(
  cfg: AsrConfig,
  waitMs = 30000
): Promise<{ ok: boolean; started: boolean; message: string }> {
  const url = cfg.serverUrl || 'http://127.0.0.1:8178'

  if (await isServerUp(url)) {
    return { ok: true, started: false, message: `whisper-server 已在运行（${url}）` }
  }

  if (!cfg.autoStartServer) {
    return { ok: false, started: false, message: `whisper-server 未运行，且未开启自动启动（${url}）` }
  }

  const binary = (cfg.serverBinaryPath || '').trim() || 'whisper-server'
  const model = (cfg.modelPath || '').trim()
  if (!model) {
    return { ok: false, started: false, message: '未配置模型文件路径，无法自动启动 whisper-server' }
  }

  /*
   * 启用 Silero VAD：这是识别准确度的关键。
   *
   * 原版把音频连续推给服务端，由阿里云的 VAD 做端点检测
   * （aliyunMaxSentenceSilenceMs: 800 = 停顿 800ms 判一句结束）。
   * 本地版没有服务端，就让 whisper-server 内置的 Silero VAD 承担同一件事：
   *   -vsd 800  静音多久切分（对齐原版的 800ms）
   *   -vp  30   语音前后各留 30ms 填充，避免掐掉字头字尾
   *   -vo  0.1  相邻段之间 0.1s 重叠，避免边界词被切开后丢失
   * 只靠固定阈值 + 硬切 12 秒会把句子切碎，这正是之前识别不准的原因。
   */
  const args = ['-m', model, '--host', hostOf(url), '--port', String(portOf(url))]
  const vadModel = (cfg.vadModelPath || '').trim()
  if (vadModel) {
    args.push(
      '--vad',
      '-vm', vadModel,
      '-vsd', String(Math.max(100, Math.round(cfg.vadSilenceMs || 800))),
      '-vt', String(cfg.vadThreshold || 0.5),
      '-vp', '30',
      '-vo', '0.1'
    )
  }

  try {
    child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false })
  } catch (error) {
    return { ok: false, started: false, message: `启动失败：${error instanceof Error ? error.message : String(error)}` }
  }

  ownedByUs = true
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-400)
  })
  child.on('error', (error) => {
    console.warn('[whisper-server] 进程错误：', error.message)
  })
  child.on('close', (code) => {
    console.log(`[whisper-server] 进程退出，code=${code}`)
    child = null
    ownedByUs = false
  })

  // 等待就绪：模型加载需要时间（small 约 3-8 秒）
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await isServerUp(url, 1200)) {
      return { ok: true, started: true, message: `whisper-server 已启动（${url}）` }
    }
    if (!child) {
      return { ok: false, started: false, message: `whisper-server 启动后立即退出：${stderrTail || '无输出'}` }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, started: true, message: `whisper-server 启动超时（${waitMs}ms）：${stderrTail || '无输出'}` }
}

/**
 * 关掉由我们拉起的服务。
 *
 * 只杀自己拉起的那个进程：用户手动开的实例不该被应用退出带走。
 */
export function stopServer(): void {
  if (!child || !ownedByUs) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* 忽略 */
  }
  // 宽限 2 秒后强杀，避免留下占着端口的孤儿进程
  const target = child
  setTimeout(() => {
    try {
      if (target && !target.killed) target.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }, 2000)
  child = null
  ownedByUs = false
}

/** 服务是否由本进程拉起 */
export function isOwned(): boolean {
  return ownedByUs
}

/** 仅测试用 */
export function __resetForTest(): void {
  child = null
  ownedByUs = false
}
