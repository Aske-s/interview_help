import React from 'react'
import { Badge, Button, Card, Field, Input, cx } from '@renderer/ui'
import type { MainWindowApi } from '@shared/ipc'
import type { Settings } from '@shared/types'

/**
 * 笔试「准备」页。
 *
 * 对齐原版：点「笔试」先进入准备页，选好截图来源、给本次笔试取个名字，
 * 点开始后才进入那个半透明悬浮框（快捷操作条），在那里截图识题。
 *
 * 原版有三种截图来源：
 *  - 本机截图：就在这台电脑上答题
 *  - 为他机截图：把这台电脑当截图源，把设备码给对方
 *  - 远程截图：用另一台设备截图，输入对方设备码
 * 后两者需要服务端做设备配对中转，本地版没有后端，因此明确标注不可用，
 * 而不是做一个假的按钮骗点击。
 */

const api = window.api as unknown as MainWindowApi

type Source = 'local' | 'serve' | 'remote'

const SOURCES: Array<{
  value: Source
  title: string
  desc: string
  available: boolean
}> = [
  {
    value: 'local',
    title: '本机截图答题',
    desc: '适合在这台电脑上答题：点击开始后，用快捷键截取题目并生成答案。',
    available: true
  },
  {
    value: 'serve',
    title: '为他机截图答题',
    desc: '适合把这台电脑作为截图来源：开启后，把设备码给另一端，让另一端请求本机截图。',
    available: false
  },
  {
    value: 'remote',
    title: '远程截图',
    desc: '适合用另一台设备截图：输入对方设备码后，由我方发起截图识别。',
    available: false
  }
]

export default function QuizPrep({
  settings,
  onStarted
}: {
  settings: Settings
  onStarted: () => void
}): React.ReactElement {
  const [source, setSource] = React.useState<Source>('local')
  const [name, setName] = React.useState('')
  const [saveRecord, setSaveRecord] = React.useState(true)
  const [deviceCode, setDeviceCode] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const quizMode = settings.modes.find((m) => m.type === 'quiz')
  const shortcut = quizMode?.quizConfig?.shortcut ?? settings.hotkeys.screenshot

  const start = async (): Promise<void> => {
    if (source !== 'local') {
      setError('该截图来源需要服务端设备配对，本地版暂未提供')
      return
    }
    setBusy(true)
    setError('')
    try {
      // 记录本次笔试名称，便于之后在记录里区分
      await api.settings.patch({ quizPrep: { lastName: name.trim(), saveRecord } } as never)
      // 先激活笔试模式，让答题参数（结论格式/语言/截屏键）跟着走
      if (quizMode) await api.modes.activate(quizMode.id)
      // 进入半透明悬浮框（原版：点开始后就是那个透明框，不是大窗口）
      await api.app.openWindow('quizbar')
      onStarted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card title="创建笔试">
        <div className="space-y-2">
          <Field
            label="本次笔试名称"
            hint="名称用于区分笔试记录，便于之后查找题目和答案。"
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入笔试名称（可留空）"
            />
          </Field>
          <div className="text-[12px] text-[rgb(var(--ss-muted))]">
            聊天记忆自动保存在本机。此处仅选择是否另存本次笔试记录，关闭后仍可从聊天历史继续。
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={saveRecord} onChange={(e) => setSaveRecord(e.target.checked)} />
            另存本次笔试记录
          </label>
        </div>
      </Card>

      <Card title="截图来源">
        <div className="space-y-2">
          {SOURCES.map((s) => {
            const selected = source === s.value
            return (
              <button
                key={s.value}
                onClick={() => {
                  setSource(s.value)
                  setError('')
                }}
                className={cx(
                  'w-full rounded-lg border p-3 text-left transition-colors',
                  selected
                    ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary)/0.08)]'
                    : 'border-[rgb(var(--ss-border))] hover:bg-[rgb(var(--ss-2))]'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{s.title}</span>
                  {!s.available && <Badge tone="muted">本地版暂未提供</Badge>}
                  {selected && s.available && <Badge tone="accent">已选择</Badge>}
                </div>
                <div className="mt-1 text-[12px] text-[rgb(var(--ss-muted))]">{s.desc}</div>

                {/* 远程截图需要填对方设备码 */}
                {s.value === 'remote' && selected && (
                  <div className="mt-2">
                    <Input
                      value={deviceCode}
                      onChange={(e) => setDeviceCode(e.target.value)}
                      placeholder="输入对方设备码"
                      className="font-mono text-[12px]"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.12)] px-3 py-2 text-[12px]">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => void start()}>
          {busy ? '正在准备…' : '开始笔试'}
        </Button>
        <span className="text-[12px] text-[rgb(var(--ss-muted))]">
          开始后会进入半透明快捷操作框；按 <span className="font-mono">{shortcut}</span> 截屏识题。
        </span>
      </div>

      <Card title="详细视图">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void api.app.openWindow('quiz')}>
            打开笔试窗口
          </Button>
          <span className="ss-list-count">
            需要批量截图、长截图拼接、测试样例判题或导出记录时用这个（信息更全）。
          </span>
        </div>
      </Card>
    </div>
  )
}
