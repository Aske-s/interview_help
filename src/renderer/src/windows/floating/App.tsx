import React from 'react'
import { Badge, Button, Markdown, ThinkBlock, cx } from '@renderer/ui'
import { AudioCapture } from '@renderer/audio/capture'
import { useZoom } from '@renderer/hooks/useZoom'
import { PreflightGate } from './PreflightGate'
import type { ChatDelta, LiveState, QaRecord, Settings, TranscriptSegment } from '@shared/types'
import type { FloatingWindowApi } from '@shared/ipc'

/**
 * 悬浮窗 —— 布局对齐「随思」原版：
 *   顶栏（会话状态 + 窗口操作）
 *   ├ 左栏「实时转写」：带序号的问答列表，每项 = 问题 + @智能体 标签 + 来源
 *   └ 右栏「答案」：工具行（对话思考 / 知识库 / 智能体胶囊）+ Markdown 答案
 *   底栏（开始停止、清空、翻页、透明度、穿透）
 *
 * 透明窗口约束：根容器背景必须透明，面板底色由 --ss-panel-alpha 控制。
 */

const api = window.api as unknown as FloatingWindowApi

interface AnswerView {
  id: string
  question: string
  text: string
  reasoning: string
  streaming: boolean
  firstTokenMs?: number | null
  totalMs?: number
}

export default function App(): React.ReactElement {
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [state, setState] = React.useState<LiveState | null>(null)
  const [segments, setSegments] = React.useState<TranscriptSegment[]>([])
  const [answers, setAnswers] = React.useState<AnswerView[]>([])
  const [question, setQuestion] = React.useState('')
  /** null 表示跟随最新一条 */
  const [selected, setSelected] = React.useState<number | null>(null)
  const [error, setError] = React.useState('')
  const [cycling, setCycling] = React.useState(false)
  const [level, setLevel] = React.useState(0)
  /** 当前激活的模式（原版：会议角色） */
  const activeMode = settings?.modes.find((m) => m.id === settings.activeModeId) ?? settings?.modes[0] ?? null
  /** 开始前的设备检查闸门 */
  const [preflight, setPreflight] = React.useState(false)

  const captureRef = React.useRef<AudioCapture | null>(null)
  /** 主窗口传来的会话标题 */
  const [pendingTitle, setPendingTitle] = React.useState('')
  /** 主窗口请求开始的待办（等 settings 加载完再跑，否则会跳过设备检查） */
  const [startRequest, setStartRequest] = React.useState<{ title?: string } | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const answerRef = React.useRef<HTMLDivElement>(null)
  const { zoom, zoomIn, zoomOut, reset: resetZoom } = useZoom()

  /* ---- 设置与实时事件订阅 ---- */
  React.useEffect(() => {
    void api.settings.get().then(setSettings)
    void api.live.state().then(setState)

    const offs = [
      api.settings.onChanged(setSettings),
      api.live.onState(setState),
      api.live.onTranscript((segment) => setSegments((prev) => [...prev.slice(-199), segment])),
      /*
       * 提问一确定就把卡片建出来（带题目）。
       *
       * 之前只在第一个 token 到达时才建卡片，而首字实测要等 8 秒量级 ——
       * 这段时间界面上是一张「没有题目的空白卡」，用户会以为「这一句没在回答」。
       * 同时把选中位置拉回「跟随最新」，否则用户翻过旧答案之后，
       * 新答案会悄悄地不显示（这正是「第二句不自动回答」的观感来源）。
       */
      api.live.onAnswerStart((info) => {
        setAnswers((prev) =>
          prev.some((a) => a.id === info.qaId)
            ? prev
            : [
                ...prev,
                {
                  id: info.qaId,
                  question: info.question,
                  text: '',
                  reasoning: '',
                  streaming: true
                }
              ]
        )
        setSelected(null)
      }),
      api.live.onAnswerDelta((qaId, delta: ChatDelta) =>
        setAnswers((prev) => {
          const index = prev.findIndex((a) => a.id === qaId)
          if (index < 0) {
            return [
              ...prev,
              {
                id: qaId,
                question: '',
                text: delta.kind === 'content' ? delta.text : '',
                reasoning: delta.kind === 'reasoning' ? delta.text : '',
                streaming: true
              }
            ]
          }
          const next = [...prev]
          const item = { ...next[index] }
          if (delta.kind === 'content') item.text += delta.text
          else item.reasoning += delta.text
          next[index] = item
          return next
        })
      ),
      /** 上一条被新提问打断：收掉「生成中」，别再让界面一直转 */
      api.live.onAnswerAborted((qaId: string) =>
        setAnswers((prev) => {
          const index = prev.findIndex((a) => a.id === qaId)
          if (index < 0) return prev
          const next = [...prev]
          next[index] = { ...next[index], streaming: false }
          return next
        })
      ),
      api.live.onAnswerDone((record: QaRecord, timing: { firstTokenMs?: number; totalMs?: number }) =>
        setAnswers((prev) => {
          const index = prev.findIndex((a) => a.id === record.id)
          if (index < 0) {
            return [
              ...prev,
              {
                id: record.id,
                question: record.question,
                text: record.answer,
                reasoning: record.reasoning ?? '',
                streaming: false,
                firstTokenMs: timing?.firstTokenMs ?? null,
                totalMs: timing?.totalMs
              }
            ]
          }
          const next = [...prev]
          next[index] = {
            ...next[index],
            question: record.question,
            streaming: false,
            firstTokenMs: timing?.firstTokenMs ?? next[index].firstTokenMs,
            totalMs: timing?.totalMs ?? next[index].totalMs
          }
          return next
        })
      ),
      api.live.onAutoStopped((info) =>
        setError(`已 ${Math.round(info.seconds / 60)} 分钟无人发言，已自动停止采集。点「继续采集」可恢复。`)
      ),
      /*
       * 主窗口点「开始」时，真正的开跑在悬浮窗里完成（设备检查 → 建采集）。
       * 以前是主窗口直接 live.start，结果悬浮窗一打开就显示「停止」但根本没采集，
       * 用户得先点停止再点开始才真正启动。
       */
      api.onStartRequested((opts) => {
        setPendingTitle(opts?.title ?? '')
        setStartRequest({ title: opts?.title })
      }),
      api.live.onSecurityAlert((reason) => setError(`检测到录屏/共享：${reason}`)),
      api.live.onError((scope, message) => setError(`[${scope}] ${message}`))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  /* ---- 面板不透明度 ---- */
  React.useEffect(() => {
    if (!settings) return
    document.documentElement.style.setProperty('--ss-panel-alpha', String(settings.ui.opacity))
  }, [settings])

  /* ---- 输入电平 ---- */
  React.useEffect(() => {
    if (!state?.running) {
      setLevel(0)
      return
    }
    const timer = setInterval(() => setLevel(captureRef.current?.getLevel() ?? 0), 200)
    return () => clearInterval(timer)
  }, [state?.running])

  /* ---- 自动滚动 ---- */
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [segments.length, state?.pendingQuestion])

  React.useEffect(() => {
    answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight })
  }, [answers.length, answers[answers.length - 1]?.text])

  /** 点击「开始」：按设置决定是否先做一次设备检查 */
  const beginSession = (): void => {
    if (settings?.preflightCheck) {
      setPreflight(true)
      return
    }
    void startSession()
  }
  /*
   * 真正执行「开始」。
   * 必须等 settings 到位：设备检查开关（preflightCheck）在设置里，
   * 若在设置加载完之前就开跑，会静默跳过检查。
   */
  React.useEffect(() => {
    if (!startRequest || !settings) return
    setStartRequest(null)
    beginSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRequest, settings])

  const startSession = async () => {
    setError('')
    setPreflight(false)
    const result = await api.live.start({ kind: 'meeting', title: pendingTitle || undefined })
    if (!result.ok) {
      setError(result.error ?? '启动失败')
      return
    }
    // 已经在采了就不再造一路（重复 start 会把每帧音频推两次）
    if (captureRef.current) return
    if (settings && (settings.audio.micEnabled || settings.audio.systemAudioEnabled)) {
      const capture = new AudioCapture()
      capture.onFrame((pcm, source) => api.live.pushAudio(pcm.buffer as ArrayBuffer, source))
      capture.onError((scope, message) => setError(`[${scope}] ${message}`))
      captureRef.current = capture
      await capture.start({
        mic: settings.audio.micEnabled,
        system: settings.audio.systemAudioEnabled,
        micDeviceId: settings.audio.micDeviceId || undefined
      })
    }
  }

  const stopSession = async () => {
    await captureRef.current?.stop()
    captureRef.current = null
    await api.live.stop()
  }

  const submit = (text?: string): void => {
    const value = (text ?? question).trim()
    if (!value) return
    setSelected(null)
    void api.live.ask(value)
    setQuestion('')
  }

  const currentIndex = selected ?? answers.length - 1
  const goPrev = (): void => setSelected(Math.max(0, currentIndex - 1))
  const goNext = (): void => setSelected(currentIndex + 1 >= answers.length ? null : currentIndex + 1)

  if (!settings) return <div className="h-full" />

  const agents = settings.agents
  const activeAgent = agents.find((a) => a.id === settings.activeAgentId) ?? agents[0]
  const alerting = Boolean(state?.securityAlert)
  const current = answers[currentIndex]

  // 设备检查闸门：占用整个悬浮窗，检查完再进入正式界面
  if (preflight && settings) {
    return (
      <div className="h-full w-full">
        <div className="ss-panel-bg h-full overflow-hidden rounded-xl border border-[rgb(var(--ss-border))] shadow-2xl">
          <PreflightGate
            checkSystemAudio={settings.audio.systemAudioEnabled}
            micDeviceId={settings.audio.micDeviceId || undefined}
            cameraDeviceId={settings.audio.cameraDeviceId || undefined}
            onProceed={() => void startSession()}
            onCancel={() => setPreflight(false)}
            onResult={(result) => void api.diagnostics.saveDeviceCheck(result)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <div
        className={cx(
          'ss-panel-bg flex h-full flex-col overflow-hidden rounded-xl border shadow-2xl',
          alerting ? 'border-[rgb(var(--ss-danger))]' : 'border-[rgb(var(--ss-border))]'
        )}
      >
        {/* ---------- 顶栏（可拖动） ---------- */}
        <header className="ss-drag flex h-10 shrink-0 items-center gap-2 px-3">
          <span
            className={cx(
              'h-2 w-2 shrink-0 rounded-full',
              state?.running ? 'bg-[rgb(var(--ss-success))]' : 'bg-[rgb(var(--ss-faint))]'
            )}
          />
          <span className="shrink-0 whitespace-nowrap text-[12px] font-medium">会议助答</span>
          <span className="ss-list-count truncate">
            {state?.running ? (state.asr === 'transcribing' ? '识别中…' : '正在听…') : '未开始'}

          </span>
          {activeAgent && <Badge tone="mic">{activeAgent.name}</Badge>}
          {/* 模式切换（原版：切换到上一个/下一个会议角色） */}
          <div className="ss-no-drag flex items-center gap-1">
            <button
              className="ss-icon-btn"
              title="上一个角色"
              disabled={cycling}
              onClick={async () => {
                setCycling(true)
                try {
                  await api.modes.cycle(-1)
                } finally {
                  setCycling(false)
                }
              }}
            >
              ‹
            </button>
            <span className="max-w-[120px] truncate text-[11px] text-[rgb(var(--ss-muted))]" title={activeMode?.name}>
              {activeMode?.name ?? '未选择模式'}
            </span>
            <button
              className="ss-icon-btn"
              title="下一个角色"
              disabled={cycling}
              onClick={async () => {
                setCycling(true)
                try {
                  await api.modes.cycle(1)
                } finally {
                  setCycling(false)
                }
              }}
            >
              ›
            </button>
          </div>
          {state?.streaming && <Badge tone="accent">生成中</Badge>}
          {settings.asrTuning.cumulative && <Badge tone="mic">累积转写</Badge>}
          {state?.autoStopped && <Badge tone="warn">采集已暂停</Badge>}
          {settings.voiceprint.enabled && (
            <Badge tone={state?.voiceprintEnrolled ? 'ok' : 'muted'}>
              {state?.voiceprintEnrolled ? '声纹过滤' : '声纹未录入'}
            </Badge>
          )}
          {alerting && <Badge tone="danger">安全风险</Badge>}

          {/* 电平指示 */}
          <div className="ml-1 h-1 w-14 shrink-0 overflow-hidden rounded-full bg-[rgb(var(--ss-3))]">
            <div
              className="h-full bg-[rgb(var(--ss-success))] transition-[width] duration-150"
              style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
            />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1 ss-no-drag">
            <Button size="sm" variant="ghost" onClick={() => void api.app.openWindow('main')}>
              主界面
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void api.app.closeWindow()} title="隐藏悬浮窗">
              ✕
            </Button>
          </div>
        </header>

        {/* ---------- 主体两栏 ---------- */}
        <div className="flex min-h-0 flex-1 divide-x divide-[rgb(var(--ss-border))] border-t border-[rgb(var(--ss-border))]">

          {/* 左：实时转写 */}
          <section className="flex w-[46%] min-w-[220px] flex-col">
            <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
              <span className="text-[12px] text-[rgb(var(--ss-muted))]">实时转写</span>
              <span className="ss-list-count">{segments.length} 段</span>
            </div>

            {/* 流式识别的实时行：对应原版 isFinal=false 的增量显示 */}
            {state?.hearing && state.lastTranscript && (
              <div className="mx-3 mb-1 shrink-0 rounded-lg border border-dashed border-[rgb(var(--ss-mic)/0.5)] bg-[rgb(var(--ss-mic)/0.08)] px-2.5 py-1.5 ss-no-drag">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-[rgb(var(--ss-mic))]">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[rgb(var(--ss-mic))]" />
                  正在识别
                </div>
                <div className="text-[12px] leading-snug text-[rgb(var(--ss-text)/0.85)]">
                  {state.lastTranscript}
                </div>
              </div>
            )}

            <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
              {segments.length === 0 && !state?.pendingQuestion && !state?.hearing ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-[12px] leading-relaxed text-[rgb(var(--ss-faint))]">
                  {state?.running ? '正在聆听…识别到问题后会自动生成答案' : '点击下方「开始」进入会议助答'}
                </div>
              ) : (
                <ol className="pb-2">
                  {segments.map((segment, index) => (
                    <li key={segment.id}>
                      <button
                        onClick={() => submit(segment.text)}
                        className="flex w-full gap-2 px-3 py-2 text-left transition-colors hover:bg-[rgb(var(--ss-2)/0.5)] ss-no-drag"
                        title="点击作为问题提问"
                      >
                        <span className="w-4 shrink-0 pt-[2px] text-right text-[11px] text-[rgb(var(--ss-faint))]">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] leading-snug text-[rgb(var(--ss-text))]">
                            {segment.text}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] leading-snug text-[rgb(var(--ss-muted))]">
                            <span className="text-[rgb(var(--ss-mic))]">@{activeAgent?.name ?? '默认'}</span>
                            {segment.source === 'mic' ? '（我方）' : '（对方）'}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}

                  {state?.pendingQuestion && (
                    <li className="mx-2 rounded-lg bg-[rgb(var(--ss-2))]">
                      <div className="flex gap-2 px-1.5 py-2">
                        <span className="w-4 shrink-0 pt-[2px] text-right text-[11px] text-[rgb(var(--ss-muted))]">
                          {segments.length + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] leading-snug">{state.pendingQuestion}</span>
                          <span className="mt-0.5 block text-[11px] text-[rgb(var(--ss-mic))]">
                            @{activeAgent?.name ?? '默认'} · 待回答
                          </span>
                        </span>
                      </div>
                    </li>
                  )}
                </ol>
              )}
            </div>

            {/* 手动输入 */}
            <div className="shrink-0 border-t border-[rgb(var(--ss-border))] p-2 ss-no-drag">
              {settings.asrTuning.cumulative && (state?.accumulated || state?.pendingQuestion) ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] text-[rgb(var(--ss-muted))]">
                    累积转写中 —— 说完后点「发送当前转写」
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" className="flex-1" onClick={() => void api.live.sendAccumulated()}>
                      发送当前转写
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void api.live.clearAccumulated()}>
                      清空
                    </Button>
                  </div>
                </div>
              ) : (
              <div className="flex gap-1.5">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                  }}
                  placeholder={settings.stealth.releaseFocus ? '也可输入文字（当前不抢焦点）' : '也可输入文字…'}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] px-2 text-[12px] outline-none focus:border-[rgb(var(--ss-accent))]"
                />
                <Button size="sm" variant="primary" onClick={() => submit()}>
                  回答
                </Button>
              </div>
              )}
            </div>
          </section>

          {/* 右：答案 */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 ss-no-drag">
              <span className="shrink-0 whitespace-nowrap text-[12px] text-[rgb(var(--ss-muted))]">对话思考</span>
              <span className="shrink-0 text-[11px] text-[rgb(var(--ss-faint))]" title="答案由你配置的模型网关生成">
                ⓘ
              </span>
              <span className="mx-0.5 h-3 w-px shrink-0 bg-[rgb(var(--ss-border))]" />
              <span className="shrink-0 whitespace-nowrap text-[12px] text-[rgb(var(--ss-muted))]">知识库</span>

              <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto">
                {agents.slice(0, 4).map((agent) => {
                  const active = agent.id === settings.activeAgentId
                  return (
                    <button
                      key={agent.id}
                      onClick={() => void api.settings.patch({ activeAgentId: agent.id })}
                      className={cx(
                        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                        active
                          ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))]'
                          : 'border-[rgb(var(--ss-border))] text-[rgb(var(--ss-muted))] hover:text-[rgb(var(--ss-text))]'
                      )}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--ss-danger))]" />}
                      {agent.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <div ref={answerRef} className="min-h-0 flex-1 overflow-auto px-3 pb-3">
              {/* 题目翻译：只影响展示，AI 仍用原题作答 */}
              {settings.translate.enabled && state?.questionTranslation && (
                <div className="mb-2 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2)/0.7)] px-2.5 py-1.5">
                  <div className="text-[10px] text-[rgb(var(--ss-faint))]">题目翻译</div>
                  <div className="text-[12px] leading-snug text-[rgb(var(--ss-muted))]">
                    {state.questionTranslation}
                  </div>
                </div>
              )}

              {error && (
                <div className="mb-2 rounded-lg border border-[rgb(var(--ss-danger)/0.4)] bg-[rgb(var(--ss-danger)/0.08)] px-2.5 py-1.5 text-[11px] leading-relaxed">
                  {error}
                </div>
              )}

              {current ? (
                <>
                  <div className="mb-1.5 text-[12px] leading-snug">
                    <span className="text-[rgb(var(--ss-danger))]">@{activeAgent?.name ?? '默认'}：</span>
                    <span className="text-[rgb(var(--ss-faint))]">
                      {current.question || state?.pendingQuestion || ''}
                    </span>
                  </div>
                  {current.reasoning && <ThinkBlock text={current.reasoning} streaming={current.streaming} />}
                  <Markdown>{current.text || (current.streaming ? '正在生成…' : '')}</Markdown>
                  {!current.streaming && current.totalMs !== undefined && (
                    <div className="mt-2 text-[11px] text-[rgb(var(--ss-faint))]">
                      首字 {current.firstTokenMs ?? '—'}ms · 总计 {current.totalMs}ms
                    </div>
                  )}
                </>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-[12px] leading-relaxed text-[rgb(var(--ss-faint))]">
                  {state?.running ? '识别到完整问题后，答案会显示在这里' : '开始会话后，AI 会在这里实时作答'}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ---------- 底栏 ---------- */}
        <footer className="flex shrink-0 items-center gap-1.5 border-t border-[rgb(var(--ss-border))] px-3 py-2 ss-no-drag">
          {state?.running ? (
            <Button size="sm" onClick={() => void stopSession()}>
              停止
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={beginSession}>
              开始
            </Button>
          )}
          {state?.autoStopped && (
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                setError('')
                await api.live.resumeCapture()
              }}
            >
              继续采集
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void api.live.clear()} title="清空当前会话">
            清空
          </Button>
          <Button size="sm" variant="ghost" disabled={answers.length === 0 || currentIndex <= 0} onClick={goPrev} title="上一条">
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={answers.length === 0 || selected === null}
            onClick={goNext}
            title="下一条"
          >
            ↓
          </Button>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* 等比缩放 */}
            <div className="flex items-center gap-0.5" title="等比缩放（⌘+ / ⌘- / ⌘0）">
              <Button size="sm" variant="ghost" onClick={zoomOut} disabled={zoom <= 0.5}>
                −
              </Button>
              <button
                onClick={resetZoom}
                className="min-w-[38px] rounded px-1 text-[11px] text-[rgb(var(--ss-faint))] hover:text-[rgb(var(--ss-text))]"
                title="点击复位到 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button size="sm" variant="ghost" onClick={zoomIn} disabled={zoom >= 2.5}>
                +
              </Button>
            </div>

            <span className="h-3 w-px bg-[rgb(var(--ss-border))]" />

            <span className="text-[11px] text-[rgb(var(--ss-faint))]">{Math.round(settings.ui.opacity * 100)}%</span>
            <input
              type="range"
              min="0.2"
              max="1"
              step="0.02"
              value={settings.ui.opacity}
              onChange={(e) => void api.settings.patch({ ui: { opacity: Number(e.target.value) } })}
              className="w-14"
              title="背景透明度"
            />
            <Button
              size="sm"
              variant="ghost"
              title="鼠标穿透"
              onClick={() => {
                const next = !settings.stealth.clickThrough
                void api.settings.patch({ stealth: { clickThrough: next } })
                void api.floating.setClickThrough(next)
              }}
            >
              {settings.stealth.clickThrough ? '穿透中' : '穿透'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}
