import React from 'react'
import { Badge, Button, cx } from '@renderer/ui'
import { runDeviceCheck, summarizeDeviceCheck } from '@renderer/diagnostics/deviceCheck'
import type { DeviceCheckItem, DeviceCheckResult } from '@shared/types'

/**
 * 开始前的设备检查闸门。
 *
 * 对齐原版语义：
 *  - 先确认麦克风/摄像头权限
 *  - 「检查失败也可以继续，系统会按纯音频或文字输入兜底」
 * 因此这里永远提供「仍然开始」的出口，绝不硬拦。
 */

const STATUS_ICON: Record<string, string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' }

export function PreflightGate({
  checkSystemAudio,
  micDeviceId,
  cameraDeviceId,
  onProceed,
  onCancel,
  onResult
}: {
  checkSystemAudio: boolean
  micDeviceId?: string
  cameraDeviceId?: string
  onProceed: () => void
  onCancel: () => void
  onResult?: (result: DeviceCheckResult) => void
}): React.ReactElement {
  const [phase, setPhase] = React.useState<'checking' | 'done'>('checking')
  const [items, setItems] = React.useState<DeviceCheckItem[]>([])
  const [result, setResult] = React.useState<DeviceCheckResult | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const checked = await runDeviceCheck({
        micDeviceId,
        cameraDeviceId,
        checkSystemAudio
      })
      if (cancelled) return
      setResult(checked)
      setItems(checked.items)
      setPhase('done')
      onResult?.(checked)
    })()
    return () => {
      cancelled = true
    }
    // 只在挂载时跑一次，避免重复申请权限
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const failed = items.filter((i) => i.status === 'fail').length
  const warned = items.filter((i) => i.status === 'warn').length

  return (
    <div className="flex h-full flex-col">
      <header className="ss-drag flex h-9 shrink-0 items-center gap-2 border-b border-[rgb(var(--ss-border))] px-3">
        <span className="text-[12px] font-medium">开始前检查</span>
        <span className="ss-list-count">
          {phase === 'checking' ? '正在检查设备…' : summarizeDeviceCheck(result ?? undefined)}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
          ✕
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-3">
        {phase === 'checking' ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[rgb(var(--ss-faint))]">
            正在打开麦克风与摄像头各测一次…
          </div>
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-start gap-2 rounded-lg bg-[rgb(var(--ss-2)/0.6)] p-2">
              <span
                className={cx(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white',
                  item.status === 'pass'
                    ? 'bg-[rgb(var(--ss-success))]'
                    : item.status === 'fail'
                      ? 'bg-[rgb(var(--ss-danger))]'
                      : item.status === 'warn'
                        ? 'bg-[rgb(var(--ss-warning))]'
                        : 'bg-[rgb(var(--ss-faint))]'
                )}
              >
                {STATUS_ICON[item.status] ?? '?'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium">{item.label}</div>
                <div className="text-[11px] leading-relaxed text-[rgb(var(--ss-muted))]">{item.message}</div>
                {item.detail && <div className="ss-list-count">{item.detail}</div>}
              </div>
            </div>
          ))
        )}
      </div>

      <footer className="shrink-0 border-t border-[rgb(var(--ss-border))] p-2.5 ss-no-drag">
        {phase === 'done' && (failed > 0 || warned > 0) && (
          <div className="mb-2 text-[11px] leading-relaxed text-[rgb(var(--ss-muted))]">
            {failed > 0
              ? '设备权限不完整，仍可继续使用可用输入方式。'
              : '有需要留意的地方，通常不影响使用。'}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={phase === 'checking'} onClick={onProceed}>
            开始助答
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          {phase === 'done' && <Badge tone={failed ? 'warn' : 'ok'}>{failed ? '部分未通过' : '检查完成'}</Badge>}
        </div>
      </footer>
    </div>
  )
}
