import React from 'react'
import { Badge, Button, Card, Empty, Field, Select, Switch, cx } from '@renderer/ui'
import { listDevices, runDeviceCheck, summarizeDeviceCheck } from '@renderer/diagnostics/deviceCheck'
import type { AudioDeviceInfo, CheckState, DeviceCheckResult, PermissionState, SecurityCheckResult } from '@shared/types'
import type { MainWindowApi } from '@shared/ipc'

/** 设备检查 / 环境检查（对齐随思原版的「设备权限」与「环境安全」两块） */

const api = window.api as unknown as MainWindowApi

type PatchFn = (patch: Parameters<MainWindowApi['settings']['patch']>[0]) => Promise<void>

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: '已授权',
  denied: '已拒绝',
  'not-determined': '未申请',
  restricted: '受系统限制',
  unknown: '未知'
}

const PERMISSION_TONE: Record<PermissionState, 'ok' | 'danger' | 'warn' | 'muted'> = {
  granted: 'ok',
  denied: 'danger',
  'not-determined': 'warn',
  restricted: 'warn',
  unknown: 'muted'
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'danger',
  unknown: 'muted'
}

const STATUS_ICON: Record<string, string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' }

export default function Diagnostics({
  micDeviceId,
  cameraDeviceId,
  checkSystemAudio,
  preflightCheck,
  onPatch
}: {
  micDeviceId: string
  cameraDeviceId: string
  checkSystemAudio: boolean
  preflightCheck: boolean
  onPatch: PatchFn
}): React.ReactElement {
  const [devices, setDevices] = React.useState<AudioDeviceInfo[]>([])
  const [permissions, setPermissions] = React.useState<Awaited<ReturnType<MainWindowApi['device']['getPermissions']>> | null>(null)
  const [deviceResult, setDeviceResult] = React.useState<DeviceCheckResult | null>(null)
  const [securityResult, setSecurityResult] = React.useState<SecurityCheckResult | null>(null)
  const [busy, setBusy] = React.useState<'device' | 'security' | null>(null)
  const [screen, setScreen] = React.useState<{ ok: boolean; message: string } | null>(null)

  const refreshPermissions = React.useCallback(async () => {
    setPermissions(await api.device.getPermissions())
  }, [])

  React.useEffect(() => {
    void refreshPermissions()
    void listDevices().then(setDevices)
    void api.diagnostics.getCheckState().then((state: CheckState) => {
      if (state.device) setDeviceResult(state.device)
      if (state.security) setSecurityResult(state.security)
    })
    const off = api.diagnostics.onCheckStateChanged((state: CheckState) => {
      if (state.device) setDeviceResult(state.device)
      if (state.security) setSecurityResult(state.security)
    })
    return off
  }, [refreshPermissions])

  /** 设备枚举需要先授权，所以检查完再刷新一次列表（拿到设备名） */
  const refreshDevices = React.useCallback(async () => {
    setDevices(await listDevices())
  }, [])

  const runDevice = async (): Promise<void> => {
    setBusy('device')
    try {
      const result = await runDeviceCheck({
        micDeviceId: micDeviceId || undefined,
        cameraDeviceId: cameraDeviceId || undefined,
        checkSystemAudio
      })
      setDeviceResult(result)
      await api.diagnostics.saveDeviceCheck(result)
      await refreshPermissions()
      await refreshDevices()
    } finally {
      setBusy(null)
    }
  }

  const runSecurity = async (): Promise<void> => {
    setBusy('security')
    try {
      const state = await api.diagnostics.scanSecurity()
      if (state.security) setSecurityResult(state.security)
    } finally {
      setBusy(null)
    }
  }

  const probeScreen = async (): Promise<void> => {
    setScreen(await api.device.probeScreenCapture())
  }

  const mics = devices.filter((d) => d.kind === 'audioinput')
  const cameras = devices.filter((d) => d.kind === 'videoinput')

  return (
    <div className="max-w-3xl space-y-4">
      {/* ---------------- 设备权限 ---------------- */}
      <Card
        title="设备权限"
        extra={
          <Button onClick={() => void refreshPermissions()} size="sm">
            刷新
          </Button>
        }
      >
        <div className="space-y-2">
          {permissions ? (
            (
              [
                ['microphone', '麦克风', '会议助答采集你的声音'],
                ['camera', '摄像头', '本应用不依赖摄像头，仅用于设备自检'],
                ['screen', '屏幕录制', '截图解题、系统音频采集'],
                ['accessibility', '辅助功能', '全局快捷键']
              ] as const
            ).map(([kind, label, purpose]) => (
              <div key={kind} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{label}</div>
                  <div className="ss-list-count">{purpose}</div>
                </div>
                <Badge tone={PERMISSION_TONE[permissions[kind]]}>{PERMISSION_LABEL[permissions[kind]]}</Badge>
                {permissions[kind] !== 'granted' && (
                  <>
                    <Button size="sm" onClick={() => void api.device.requestPermission(kind).then(setPermissions)}>
                      申请
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void api.device.openSystemSettings(kind)}>
                      打开系统设置
                    </Button>
                  </>
                )}
              </div>
            ))
          ) : (
            <Empty>读取中…</Empty>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => void probeScreen()}>
            实测屏幕录制
          </Button>
          {screen && (
            <span className={cx('text-[12px]', screen.ok ? 'text-[rgb(var(--ss-success))]' : 'text-[rgb(var(--ss-danger))]')}>
              {screen.ok ? '✓' : '✕'} {screen.message}
            </span>
          )}
        </div>
      </Card>

      {/* ---------------- 设备检查 ---------------- */}
      <Card
        title="设备检查"
        extra={
          <Button variant="primary" size="sm" disabled={busy === 'device'} onClick={() => void runDevice()}>
            {busy === 'device' ? '检查中…' : '开始检查'}
          </Button>
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-4">
          <Field label="麦克风" hint="留空表示跟随系统默认设备">
            <Select value={micDeviceId} onChange={(e) => void onPatch({ audio: { micDeviceId: e.target.value } })}>
              <option value="">系统默认</option>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="摄像头（仅自检用）">
            <Select value={cameraDeviceId} onChange={(e) => void onPatch({ audio: { cameraDeviceId: e.target.value } })}>
              <option value="">系统默认</option>
              {cameras.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Switch
          checked={preflightCheck}
          onChange={(v) => void onPatch({ preflightCheck: v })}
          label="开始会话前自动检查"
          hint="开始会议助答前先确认麦克风与摄像头权限；检查失败也可以继续。"
        />

        {deviceResult ? (
          <div className="mt-3 space-y-2">
            <div className="text-[12px] text-[rgb(var(--ss-muted))]">
              {summarizeDeviceCheck(deviceResult)} ·{' '}
              {new Date(deviceResult.checkedAt).toLocaleTimeString('zh-CN')}
            </div>
            {deviceResult.items.map((item) => (
              <CheckRow
                key={item.id}
                status={item.status}
                label={item.label}
                message={item.message}
                detail={item.detail}
              />
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <Empty>还没有检查过。点「开始检查」会真实打开麦克风与摄像头各测一次。</Empty>
          </div>
        )}

        <div className="ss-list-count mt-3">
          检查失败不会影响使用：没有麦克风时可手动输入问题，没有系统音频时可改用麦克风采集。
        </div>
      </Card>

      {/* ---------------- 环境检查 ---------------- */}
      <Card
        title="环境检查"
        extra={
          <Button variant="primary" size="sm" disabled={busy === 'security'} onClick={() => void runSecurity()}>
            {busy === 'security' ? '检测中…' : '重新检测'}
          </Button>
        }
      >
        <div className="ss-list-count mb-3">
          检测录屏、屏幕共享与安全软件等环境风险。检测结果不影响其他功能使用。
        </div>

        {securityResult ? (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Badge
                tone={
                  securityResult.risk === 'safe'
                    ? 'ok'
                    : securityResult.risk === 'warn'
                      ? 'warn'
                      : securityResult.risk === 'risk'
                        ? 'danger'
                        : 'muted'
                }
              >
                {securityResult.risk === 'safe' ? '环境安全' : securityResult.risk === 'risk' ? '环境存在风险' : '环境基本可用'}
              </Badge>
              <span className="ss-list-count">
                {securityResult.summary} · {new Date(securityResult.checkedAt).toLocaleTimeString('zh-CN')}
              </span>
            </div>
            <div className="space-y-2">
              {securityResult.items.map((item) => (
                <CheckRow
                  key={item.id}
                  status={item.status}
                  label={item.label}
                  message={item.message}
                  advice={item.advice}
                />
              ))}
            </div>
            {(securityResult.detections.recorders.length > 0 || securityResult.detections.securitySoftware.length > 0) && (
              <div className="ss-list-count mt-3">
                建议把本应用加入这些软件的白名单，可避免共享画面出现黑框或防录屏组件被拦截。
              </div>
            )}
          </>
        ) : (
          <Empty>还没有检测过。点「重新检测」扫描当前环境。</Empty>
        )}
      </Card>
    </div>
  )
}

function CheckRow({
  status,
  label,
  message,
  detail,
  advice
}: {
  status: string
  label: string
  message: string
  detail?: string
  advice?: string
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-2.5">
      <span
        className={cx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
          status === 'pass'
            ? 'bg-[rgb(var(--ss-success))]'
            : status === 'fail'
              ? 'bg-[rgb(var(--ss-danger))]'
              : status === 'warn'
                ? 'bg-[rgb(var(--ss-warning))]'
                : 'bg-[rgb(var(--ss-faint))]'
        )}
      >
        {STATUS_ICON[status] ?? '?'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{label}</span>
          <Badge tone={STATUS_TONE[status] ?? 'muted'}>
            {status === 'pass' ? '通过' : status === 'warn' ? '留意' : status === 'fail' ? '未通过' : '未完成'}
          </Badge>
        </div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-[rgb(var(--ss-muted))]">{message}</div>
        {detail && <div className="ss-list-count mt-0.5">{detail}</div>}
        {advice && <div className="mt-1 text-[12px] text-[rgb(var(--ss-accent))]">建议：{advice}</div>}
      </div>
    </div>
  )
}
