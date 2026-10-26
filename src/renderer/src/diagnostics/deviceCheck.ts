import type { AudioDeviceInfo, CheckState, DeviceCheckItem, DeviceCheckResult, SecurityCheckResult } from '@shared/types'
import { describeAudioError, detectAudioPlatform } from '@renderer/audio/capture'

/**
 * 设备检查（渲染层）。
 *
 * 为什么必须在渲染层做：主进程只能读到「系统权限状态」，
 * 而「设备到底能不能用」必须真的打开一次才知道——
 * 麦克风要测到有效电平，摄像头要测到非黑画面。
 *
 * 对齐原版语义：检查失败也不阻断，只是提示会退化到可用输入方式。
 */

const MIC_TEST_MS = 1600
const MIC_RMS_THRESHOLD = 0.004
const CAMERA_TEST_MS = 900
/** 单项检查的硬超时：getUserMedia 可能因权限弹窗/设备被独占而永不返回 */
const ITEM_TIMEOUT_MS = 8000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 给一项检查加硬超时。
 * 必须要有：否则 getUserMedia 挂起时整个检查面板会永远停在「检查中…」。
 */
async function withTimeout(
  task: Promise<DeviceCheckItem>,
  id: string,
  label: string
): Promise<DeviceCheckItem> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<DeviceCheckItem>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id,
          label,
          status: 'warn',
          message: '检查超时：设备可能被其他程序占用，或系统权限弹窗未处理。',
          optional: true,
          detail: '可以继续使用；如需确认，请关闭占用该设备的程序后重试'
        }),
      ITEM_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 枚举设备；未授权时 label 为空，用编号兜底 */
export async function listDevices(): Promise<AudioDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput' || d.kind === 'videoinput')
    .map((d, index) => ({
      deviceId: d.deviceId,
      label: d.label || `${kindLabel(d.kind)} ${index + 1}（未授权看不到名称）`,
      kind: d.kind as AudioDeviceInfo['kind']
    }))
}

function kindLabel(kind: string): string {
  if (kind === 'audioinput') return '麦克风'
  if (kind === 'audiooutput') return '扬声器'
  if (kind === 'videoinput') return '摄像头'
  return '设备'
}

/* ------------------------------------------------------------------ *
 * 麦克风
 * ------------------------------------------------------------------ */

export async function testMicrophone(deviceId?: string): Promise<DeviceCheckItem> {
  const base: DeviceCheckItem = { id: 'microphone', label: '麦克风', status: 'fail', message: '', optional: true }

  if (!navigator.mediaDevices?.getUserMedia) {
    return { ...base, status: 'unknown', message: '当前环境不支持音频采集。' }
  }

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    })
    const track = stream.getAudioTracks()[0]
    const label = track?.label || '默认麦克风'

    context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    const buffer = new Float32Array(analyser.fftSize)
    let peakRms = 0
    const deadline = Date.now() + MIC_TEST_MS
    while (Date.now() < deadline) {
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
      peakRms = Math.max(peakRms, Math.sqrt(sum / buffer.length))
      await sleep(60)
    }

    if (peakRms >= MIC_RMS_THRESHOLD) {
      return {
        ...base,
        status: 'pass',
        message: '麦克风工作正常，已采集到声音。',
        detail: `${label}（电平 ${(peakRms * 100).toFixed(1)}）`
      }
    }
    return {
      ...base,
      status: 'warn',
      message: '麦克风已打开，但没检测到声音。请对着麦克风说句话再重试。',
      detail: label
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const denied = /denied|NotAllowed|Permission/i.test(message)
    return {
      ...base,
      status: 'fail',
      message: denied
        ? '未获得麦克风权限，无法采集声音。'
        : `麦克风打开失败：${message}`,
      detail: denied ? '请在系统设置中授予麦克风权限后重试' : undefined
    }
  } finally {
    stream?.getTracks().forEach((t) => t.stop())
    await context?.close().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ *
 * 摄像头
 * ------------------------------------------------------------------ */

export async function testCamera(deviceId?: string): Promise<DeviceCheckItem> {
  const base: DeviceCheckItem = { id: 'camera', label: '摄像头', status: 'fail', message: '', optional: true }

  if (!navigator.mediaDevices?.getUserMedia) {
    return { ...base, status: 'unknown', message: '当前环境不支持摄像头采集。' }
  }

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { width: 640, height: 480 }
    })
    const track = stream.getVideoTracks()[0]
    const label = track?.label || '默认摄像头'

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play().catch(() => undefined)
    await sleep(CAMERA_TEST_MS)

    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 120
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return { ...base, status: 'unknown', message: '无法创建预览画布。', detail: label }
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data

    // 全黑通常意味着被占用、盖子关着或权限异常
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3
    const avg = sum / (data.length / 4)

    video.srcObject = null

    if (avg < 3) {
      return {
        ...base,
        status: 'warn',
        message: '摄像头已打开，但画面全黑。可能被其他程序占用，或镜头被遮挡。',
        detail: label
      }
    }
    return { ...base, status: 'pass', message: '摄像头工作正常，已获取画面。', detail: `${label}（亮度 ${avg.toFixed(0)}）` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const denied = /denied|NotAllowed|Permission/i.test(message)
    const notFound = /NotFound|Requested device not found/i.test(message)
    return {
      ...base,
      status: notFound ? 'warn' : 'fail',
      message: notFound
        ? '未检测到摄像头。本应用不依赖摄像头，会议助答仍可正常使用。'
        : denied
          ? '未获得摄像头权限。'
          : `摄像头打开失败：${message}`,
      detail: denied ? '请在系统设置中授予摄像头权限后重试' : undefined
    }
  } finally {
    stream?.getTracks().forEach((t) => t.stop())
  }
}

/* ------------------------------------------------------------------ *
 * 系统音频 & 屏幕录制
 * ------------------------------------------------------------------ */

export async function testSystemAudio(enabled: boolean): Promise<DeviceCheckItem> {
  const base: DeviceCheckItem = { id: 'system-audio', label: '系统音频采集', status: 'warn', message: '', optional: true }

  if (!enabled) {
    return { ...base, status: 'unknown', message: '未启用「电脑音频」采集。若需采集会议里对方的声音，请到「语音识别 → 采音设置」开启。' }
  }

  /*
   * macOS 上必须走原生采集：getDisplayMedia 能拿到音轨对象，但数据恒为 0，
   * 自检会误判成「正常」，真开会议时才发现没声音。所以这里直接问原生通道。
   */
  const platform = await detectAudioPlatform()
  if (platform.isMacOS) {
    const api = window.api as unknown as {
      systemAudio?: { checkAccess: () => Promise<{ ok: boolean; error?: string }> }
    }
    if (!api.systemAudio) {
      return { ...base, status: 'fail', message: '当前窗口不支持电脑音频采集，请改用麦克风。' }
    }
    try {
      const result = await api.systemAudio.checkAccess()
      if (result.ok) {
        return {
          ...base,
          status: 'pass',
          message: '电脑音频采集正常（macOS 原生采集），会议软件里对方的声音可以直接采集。',
          detail: 'ScreenCaptureKit 原生采集'
        }
      }
      return { ...base, status: 'fail', message: describeAudioError(result.error) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ...base, status: 'fail', message: `电脑音频采集失败：${message}` }
    }
  }

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    const audioTracks = stream.getAudioTracks()
    if (!audioTracks.length) {
      return {
        ...base,
        status: 'fail',
        message: '未能获取系统音频。本机可能不支持直接捕获，建议改用麦克风。',
        detail: '需要在系统设置中授予「屏幕录制」权限'
      }
    }
    return {
      ...base,
      status: 'pass',
      message: '系统音频采集正常，会议软件里对方的声音可以直接采集。',
      detail: audioTracks[0].label || '系统音频'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      status: 'fail',
      message: `系统音频采集失败：${message}`,
      detail: '可改用麦克风；或在「语音识别 → 采音设置」点「检测电脑音频」查看具体原因'
    }
  } finally {
    stream?.getTracks().forEach((t) => t.stop())
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

export interface DeviceCheckOptions {
  micDeviceId?: string
  cameraDeviceId?: string
  /** 是否检查系统音频（仅当用户启用了该采集方式时才检查） */
  checkSystemAudio: boolean
}

export async function runDeviceCheck(opts: DeviceCheckOptions): Promise<DeviceCheckResult> {
  const [microphone, camera, systemAudio] = await Promise.all([
    withTimeout(testMicrophone(opts.micDeviceId), 'microphone', '麦克风'),
    withTimeout(testCamera(opts.cameraDeviceId), 'camera', '摄像头'),
    withTimeout(testSystemAudio(opts.checkSystemAudio), 'system-audio', '系统音频采集')
  ])

  // 原版的「三项检查」：麦克风、摄像头、系统音频
  const items = [microphone, camera, systemAudio]
  const core = items.filter((i) => i.id !== 'camera' || i.status !== 'warn')
  const allPassed = items.every((i) => i.status === 'pass')
  const canProceed = items.some((i) => i.status === 'pass') || items.every((i) => i.status !== 'fail')

  return {
    items,
    allPassed,
    canProceed: core.length > 0 || canProceed,
    checkedAt: Date.now()
  }
}

/** 生成一句人类可读的结论（对齐原版文案风格） */
export function summarizeDeviceCheck(result: DeviceCheckResult | undefined): string {
  if (!result) return '尚未检查'
  const failed = result.items.filter((i) => i.status === 'fail')
  if (result.allPassed) return '三项检查均已通过'
  if (!failed.length) return '设备可用，但有需要留意的地方'
  return '设备权限不完整，仍可继续使用可用输入方式'
}

export function summarizeSecurityCheck(result: SecurityCheckResult | undefined): string {
  if (!result) return '尚未检查'
  return result.summary
}

export type { CheckState }
