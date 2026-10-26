import React from 'react'
import { Badge, Markdown, cx } from '@renderer/ui'
import type { QuizbarWindowApi } from '@shared/ipc'
import type { Mode, QaRecord, SessionKind, Settings } from '@shared/types'

/**
 * 笔试 / 面试悬浮窗（原版「快捷操作」）。
 *
 * 它是一个可拖动、可缩放的半透明浮窗，不是一条只能看的横条：
 *   ┌──────────────────────────────────────┐
 *   │ ⠿ 抓手   模式名 · 快捷键     按钮组  │  ← 标题栏（拖动区）
 *   ├──────────────────────────────────────┤
 *   │                                      │
 *   │   识题结果显示在这里（内容区，可滚）  │
 *   │                                      │
 *   └──────────────────────────────────────┘ ◢ ← 右下角缩放手柄
 *
 * 早先版本把整条塞满按钮且高度只有 56px，用户反馈「巨小、无法拖动、无法拉大」——
 * 现在的布局专门解决这三点：留出明确的拖动区、给足默认尺寸、加显式缩放手柄。
 */

/**
 * 桥接对象。
 *
 * 用 `?? {}` 兜底：窗口的 preload 一旦没加载成功，window.api 就是 undefined，
 * 直接 `api.settings.xxx` 会抛出「Cannot read properties of undefined」这种看不懂的错误。
 * 兜底后所有调用都会变成 no-op，界面至少还能显示并提示用户。
 */
const api = (window.api ?? {}) as unknown as QuizbarWindowApi

/** 把 Electron Accelerator 显示成 macOS 习惯的符号 */
function prettyShortcut(acc: string): string {
  if (!acc) return '未设置'
  return acc
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Shift/gi, '⇧')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/\+/g, '')
    .replace(/Space/gi, '空格')
}

const DEFAULT_WIDTH = 460
const DEFAULT_HEIGHT = 320

export default function App(): React.ReactElement {
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [hovered, setHovered] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const [showSettings, setShowSettings] = React.useState(false)
  const [answer, setAnswer] = React.useState('')
  /** 本次识题的全部截图（批量时为多张，支持上一张/下一张） */
  const [shots, setShots] = React.useState<string[]>([])
  const [shotIndex, setShotIndex] = React.useState(0)
  /** 卡片缩放（原版 quizCard.zoomIn/zoomOut） */
  const [zoom, setZoom] = React.useState(1)
  /** 等待生成 / 生成中 / 完成 / 失败（原版 quizCard.waiting = 等待生成...） */
  const [phase, setPhase] = React.useState<'idle' | 'waiting' | 'streaming' | 'done' | 'failed'>('idle')
  /** 截图来源：手动 / 媒体键 / 快捷键（原版 quizCard.manual/mediaKey/shortcut） */
  const [source, setSource] = React.useState<'manual' | 'mediaKey' | 'shortcut'>('manual')
  /** 长截图标记（原版 quizCard.longScreenshot） */
  const [isLong, setIsLong] = React.useState(false)
  /** 已参考的知识库（原版 quizCard.knowledgeReference） */
  const [kbNames, setKbNames] = React.useState('')
  const [localOpacity, setLocalOpacity] = React.useState(0.7)
  /** 当前生效的穿透解锁快捷键（穿透开启时提示用户怎么关） */
  const [ctKey, setCtKey] = React.useState('⌘⇧9')
  /** 自动收起标题栏造成的收起（只收内容区） */
  const [collapsed, setCollapsed] = React.useState(false)
  /** 悬停显隐：鼠标已离开窗口（主进程推送） */
  const [hoverHidden, setHoverHidden] = React.useState(false)
  /** 本次会话累计的问答，退出时决定是否存盘 */
  const [items, setItems] = React.useState<QaRecord[]>([])
  /** 退出确认弹层 */
  const [askingExit, setAskingExit] = React.useState(false)
  const [rememberChoice, setRememberChoice] = React.useState(false)

  const stealth = settings?.stealth
  const clickThrough = stealth?.clickThrough ?? false
  const autoCollapse = stealth?.autoCollapse ?? false
  const activeMode: Mode | null =
    settings?.modes.find((m) => m.id === settings.activeModeId) ?? settings?.modes[0] ?? null
  /** 会话类型跟着模式走，保存记录时用 */
  const kindOfMode: SessionKind =
    activeMode?.type === 'interview' ? 'interview_assist' : activeMode?.type === 'quiz' ? 'quiz' : 'meeting'
  const title = items[0]?.question?.slice(0, 30) ?? (activeMode?.name ?? '未命名会话')

  /** 桥接是否可用（preload 失败时为 false） */
  const [bridgeOk, setBridgeOk] = React.useState(true)

  /* ---- 设置加载与同步 ---- */
  React.useEffect(() => {
    if (!window.api) {
      setBridgeOk(false)
      return
    }
    void api.settings?.get?.().then((s) => {
      if (!s) return
      setSettings(s)
      setLocalOpacity(s.ui.opacity)
    })
    const off = api.settings?.onChanged?.((s) => {
      setSettings(s)
      setLocalOpacity(s.ui.opacity)
    })
    // 悬停显隐由主进程判定（穿透窗口自己收不到 mousemove）
    const offHover = api.onHoverReveal?.((hidden) => setHoverHidden(hidden))
    void api.bar?.clickThroughHotkey?.().then((k) => k && setCtKey(prettyShortcut(k)))
    return () => {
      off?.()
      offHover?.()
    }
  }, [])

  /* ---- 识题流 ---- */
  React.useEffect(() => {
    // 截图完成：把图放进卡片（原版行为：截图直接进框，不等用户再点）
    const offShot = api.capture?.onDone?.((dataUrl) => {
      if (!dataUrl) return
      setShots((prev) => [...prev, dataUrl])
      setShotIndex(0)
      setPhase('waiting')
    })
    /*
     * 主进程广播的是**一个对象**：{reqId, delta} / {reqId, text, error, ...}。
     * 曾经按 (reqId, text) 两个参数接收，导致 text 永远是 undefined、
     * 答案永远不显示（一直停在「等待生成」），错误也被吞掉。
     */
    const offDelta = api.onAnswerDelta?.((_reqId, delta) => {
      if (delta?.kind === 'content' && delta.text) {
        setPhase('streaming')
        setAnswer((prev) => prev + delta.text)
        setStatus('正在识别截图…')
      }
    })
    const offDone = api.onAnswerDone?.((_reqId, text, error) => {
      setStatus('')
      // 失败要明确告诉用户，不能无声地停在「生成中」
      if (error) {
        setPhase('failed')
        setStatus(error)
        return
      }
      if (text) {
        setAnswer(text)
        setPhase('done')
        // 每得到一次答案就记一条，退出时据此决定是否保存
        setItems((prev) => [
          ...prev,
          {
            id: `qa-${Date.now()}`,
            question: status || '（截图识题）',
            answer: text,
            trigger: 'manual',
            createdAt: Date.now()
          } as QaRecord
        ])
      } else {
        setPhase('failed')
        setStatus('模型没有返回内容，请检查模型网关配置后重试')
      }
    })
    return () => {
      offShot?.()
      offDelta?.()
      offDone?.()
    }
  }, [])

  /* ---- 悬停显隐：鼠标移开只收起内容区，标题栏保留 ---- */
  React.useEffect(() => {
    if (!autoCollapse) {
      setCollapsed(false)
      return
    }
    let timer: number | undefined
    const el = document.documentElement
    const onEnter = (): void => {
      if (timer) window.clearTimeout(timer)
      setHovered(true)
    }
    const onLeave = (): void => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setHovered(false), 400)
    }
    el.addEventListener('mouseenter', onEnter)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      if (timer) window.clearTimeout(timer)
      el.removeEventListener('mouseenter', onEnter)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [autoCollapse])

  React.useEffect(() => {
    if (!autoCollapse) return
    setCollapsed(!hovered)
  }, [hovered, autoCollapse])

  /* ---- 右下角手柄缩放（无边框窗口没有原生缩放边） ---- */
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.screenX
    const startY = e.screenY
    const startW = window.innerWidth
    const startH = window.innerHeight

    const onMove = (ev: MouseEvent): void => {
      void api.bar?.setSize?.(startW + (ev.screenX - startX), startH + (ev.screenY - startY))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /**
   * 退出悬浮窗。
   * 对齐原版：先问「保存本次记录？」；若开启「退出自动保存记录」则直接保存并关闭。
   */
  const requestExit = React.useCallback((): void => {
    const autoSave = settings?.stealth.autoSaveOnExit ?? false
    if (items.length === 0 || autoSave) {
      void api.bar?.exit?.({ kind: kindOfMode, title: title, items, save: items.length > 0 })
      return
    }
    setAskingExit(true)
  }, [items, settings, kindOfMode, title])

  const doExit = (save: boolean): void => {
    if (rememberChoice) {
      void api.settings?.patch?.({ stealth: { autoSaveOnExit: save } } as never)
    }
    void api.bar?.exit?.({ kind: kindOfMode, title, items, save })
  }

  /* Esc 退出（原版：Esc 退出） */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (askingExit) {
        setAskingExit(false)
        return
      }
      requestExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [askingExit, requestExit])

  const patchStealth = (patch: Record<string, unknown>): void => {
    void api.settings?.patch?.({ stealth: patch } as never)
  }

  /** 截图识题 */
  const shoot = async (): Promise<void> => {
    if (busy) {
      setStatus('正在处理当前截图，请稍后再试')
      return
    }
    setBusy(true)
    setStatus('截屏中')
    setPhase('waiting')
    setSource('manual')
    setIsLong(false)
    try {
      const res = await api.capture?.start?.('region')
      if (res && !res.ok) setStatus(res.error ?? '截图读取失败')
      else setStatus('')
    } catch {
      setStatus('截图失败，请重试')
      setPhase('failed')
    } finally {
      setBusy(false)
    }
  }

  /*
   * 悬停显隐：整个悬浮窗「消失」——原版就是这个行为。
   * 用不透明度而不是 hide()：hide 之后鼠标再移进来收不到任何事件，窗口就永远回不来了。
   * 留 0.02 的下限，避免完全透明后用户以为程序崩了。
   */
  const revealOpacity = settings?.stealth.hoverRevealOpacity ?? 0.06
  const hiddenNow = Boolean(settings?.stealth.hoverReveal) && hoverHidden

  return (
    <div
      className="flex h-full w-full flex-col p-1 transition-opacity duration-200"
      style={{ opacity: hiddenNow ? Math.max(0.02, revealOpacity) : 1 }}
      title={hiddenNow ? '鼠标移入即可恢复显示' : undefined}
    >
      <div
        className={cx(
          'ss-panel-bg flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border',
          clickThrough ? 'border-[rgb(var(--ss-warning)/0.6)]' : 'border-[rgb(var(--ss-border))]'
        )}
      >
        {!bridgeOk && (
          <div className="border-b border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.12)] px-3 py-2 text-[11px]">
            窗口初始化失败：未加载到桥接接口。请完全退出应用后重新打开；若仍失败请反馈。
          </div>
        )}

        {/* ================= 标题栏（拖动区） ================= */}
        <div className="ss-drag flex shrink-0 items-center gap-1.5 border-b border-[rgb(var(--ss-border))] px-2 py-1.5">
          {/* 明确的抓手：让用户一眼知道这里能拖 */}
          <span className="select-none text-[13px] leading-none text-[rgb(var(--ss-faint))]" title="拖动此区域移动窗口">
            ⠿
          </span>

          {/* 截图识题 */}
          <button
            className="ss-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))] hover:brightness-110 disabled:opacity-50"
            title="点击右上角相机，截屏识别当前题目"
            disabled={busy}
            onClick={() => void shoot()}
          >
            <span aria-hidden>📷</span>
          </button>

          {/* 模式 + 快捷键（这段留白也是拖动区） */}
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[11px] font-medium" title={activeMode?.name}>
              {activeMode?.name ?? '未选择模式'}
            </span>
            <span className="truncate text-[10px] text-[rgb(var(--ss-faint))]">
              截屏 {prettyShortcut(settings?.hotkeys?.screenshot ?? '')}
            </span>
          </div>

          {status && <Badge tone="accent">{status}</Badge>}

          <button
            className={cx(
              'ss-no-drag h-6 shrink-0 rounded-md px-1.5 text-[11px]',
              settings?.stealth.hoverReveal
                ? 'bg-[rgb(var(--ss-accent)/0.2)] text-[rgb(var(--ss-accent))]'
                : 'text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-3))]'
            )}
            title={
              settings?.stealth.hoverReveal
                ? '关闭悬停显隐（鼠标移开时整个悬浮窗会消失）'
                : '开启悬停显隐（鼠标移开时整个悬浮窗会消失）'
            }
            onClick={() => patchStealth({ hoverReveal: !settings?.stealth.hoverReveal })}
          >
            悬停显隐
          </button>

          <button
            className={cx(
              'ss-no-drag h-6 shrink-0 rounded-md px-1.5 text-[11px]',
              clickThrough
                ? 'bg-[rgb(var(--ss-warning)/0.25)] text-[rgb(var(--ss-warning))]'
                : 'text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-3))]'
            )}
            title={clickThrough ? `关闭鼠标穿透（也可按 ${ctKey}）` : '开启鼠标穿透'}
            onClick={() => patchStealth({ clickThrough: !clickThrough })}
          >
            穿透
          </button>

          <button
            className="ss-no-drag h-6 shrink-0 rounded-md px-1.5 text-[11px] text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-3))]"
            title="悬浮条设置"
            onClick={() => setShowSettings((v) => !v)}
          >
            设置
          </button>

          {/* 明确的退出入口：原版叫「退出悬浮窗，不保存本次记录」 */}
          <button
            className="ss-no-drag h-6 shrink-0 rounded-md border border-[rgb(var(--ss-danger)/0.4)] px-2 text-[11px] text-[rgb(var(--ss-danger))] hover:bg-[rgb(var(--ss-danger)/0.12)]"
            title="退出悬浮窗，不保存本次记录"
            onClick={requestExit}
          >
            退出
          </button>
        </div>

        {/* ================= 内容区 ================= */}
        {!collapsed && (
          <div className="relative min-h-0 flex-1 overflow-auto p-3">
            {clickThrough && (
              <div className="mb-2 rounded-lg border border-[rgb(var(--ss-warning)/0.5)] bg-[rgb(var(--ss-warning)/0.1)] px-2 py-1 text-[11px]">
                鼠标穿透已开启，窗口不响应鼠标 —— 按 <span className="font-mono font-semibold">{ctKey}</span> 关闭
              </div>
            )}

            {/* ============ 答案卡片（原版 quizCard.*）============ */}
            <div className="flex h-full flex-col">
              {/* 截图区：批量时支持上一张/下一张 */}
              {shots.length > 0 && (
                <div className="mb-2 shrink-0">
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-[rgb(var(--ss-faint))]">
                    <span>{source === 'manual' ? '手动' : source === 'mediaKey' ? '媒体键' : '快捷键'}</span>
                    {isLong && <span>长截图</span>}
                    <span>共 {shots.length} 张</span>
                    <button className="ml-auto hover:underline" onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>
                      放大
                    </button>
                    <button className="hover:underline" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
                      缩小
                    </button>
                  </div>
                  <img
                    src={shots[shotIndex]}
                    alt="题目截图"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                    className="max-h-40 w-full rounded-lg border border-[rgb(var(--ss-border))] object-contain"
                  />
                  {shots.length > 1 && (
                    <div className="mt-1 flex items-center gap-2 text-[10px]">
                      <button
                        className="hover:underline disabled:opacity-40"
                        disabled={shotIndex === 0}
                        onClick={() => setShotIndex((i) => Math.max(0, i - 1))}
                      >
                        上一张
                      </button>
                      <span className="text-[rgb(var(--ss-faint))]">
                        {shotIndex + 1}/{shots.length}
                      </span>
                      <button
                        className="hover:underline disabled:opacity-40"
                        disabled={shotIndex >= shots.length - 1}
                        onClick={() => setShotIndex((i) => Math.min(shots.length - 1, i + 1))}
                      >
                        下一张
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 正文区：等待生成 / 生成中 / 结果 / 失败 */}
              <div className="min-h-0 flex-1 overflow-auto">
                {phase === 'waiting' && !answer && (
                  <div className="flex h-full flex-col items-center justify-center gap-2">
                    <div className="text-[12px] text-[rgb(var(--ss-muted))]">等待生成...</div>
                    <button className="text-[11px] text-[rgb(var(--ss-accent))] hover:underline" onClick={() => void shoot()}>
                      重试
                    </button>
                  </div>
                )}
                {phase === 'failed' && (
                  <div className="flex h-full flex-col items-center justify-center gap-2">
                    <div className="text-[12px] text-[rgb(var(--ss-danger))]">{status || '截图失败，请重试'}</div>
                    <button className="text-[11px] text-[rgb(var(--ss-accent))] hover:underline" onClick={() => void shoot()}>
                      重试
                    </button>
                  </div>
                )}
                {answer && (
                  <>
                    {/* 用 Markdown 渲染：代码题才会有代码框 + 复制按钮（原版 codeBlock.*） */}
                    <Markdown className="select-text text-[12px]">{answer}</Markdown>
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-[rgb(var(--ss-faint))]">
                      {kbNames && <span>已参考知识库 {kbNames} 生成</span>}
                      <button
                        className="hover:underline"
                        onClick={() => {
                          // 下载图片：把当前截图存下来（原版 quizCard.download）
                          const a = document.createElement('a')
                          a.href = shots[shotIndex] ?? ''
                          a.download = `题目-${Date.now()}.jpg`
                          if (a.href) a.click()
                        }}
                      >
                        下载图片
                      </button>
                      <span className="ml-auto">{Math.round(zoom * 100)}%</span>
                    </div>
                  </>
                )}
                {!answer && phase === 'idle' && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <div className="text-[12px] text-[rgb(var(--ss-muted))]">
                      {activeMode?.type === 'interview' ? '面试问答会显示在这里' : '点击右上角相机，截屏识别当前题目'}
                    </div>
                    <div className="text-[11px] text-[rgb(var(--ss-faint))]">识题结果显示在这里</div>
                  </div>
                )}
              </div>

              {/* ============ 底部栏：题型 / 代码格式 / 判题语言 / 模式 ============ */}
              {activeMode?.quizConfig && (
                <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 border-t border-[rgb(var(--ss-border))] pt-2 text-[10px]">
                  <label className="flex items-center gap-1">
                    <span className="text-[rgb(var(--ss-faint))]">题型</span>
                    <select
                      className="rounded border border-[rgb(var(--ss-border))] bg-transparent px-1 py-0.5"
                      value={activeMode.quizConfig.kind}
                      onChange={(e) =>
                        void api.modes?.save?.({
                          ...activeMode,
                          quizConfig: { ...activeMode.quizConfig!, kind: e.target.value as 'normal' | 'coding' }
                        })
                      }
                      title="题型：常规按问答题作答；Coding 按编程题格式输出"
                    >
                      <option value="normal">常规</option>
                      <option value="coding">Coding</option>
                    </select>
                  </label>

                  {activeMode.quizConfig.kind === 'coding' && (
                    <>
                      <label className="flex items-center gap-1">
                        <span className="text-[rgb(var(--ss-faint))]">代码格式</span>
                        <select
                          className="rounded border border-[rgb(var(--ss-border))] bg-transparent px-1 py-0.5"
                          value={activeMode.quizConfig.codeMode}
                          onChange={(e) =>
                            void api.modes?.save?.({
                              ...activeMode,
                              quizConfig: { ...activeMode.quizConfig!, codeMode: e.target.value as 'core' | 'acm' }
                            })
                          }
                        >
                          <option value="core">核心（仅函数）</option>
                          <option value="acm">ACM（完整 IO）</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-1">
                        <span className="text-[rgb(var(--ss-faint))]">判题语言</span>
                        <select
                          className="rounded border border-[rgb(var(--ss-border))] bg-transparent px-1 py-0.5"
                          value={activeMode.quizConfig.language}
                          onChange={(e) =>
                            void api.modes?.save?.({
                              ...activeMode,
                              quizConfig: { ...activeMode.quizConfig!, language: e.target.value }
                            })
                          }
                        >
                          <option value="auto">自动</option>
                          {['cpp', 'java', 'python', 'javascript', 'go', 'rust'].map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  <label className="ml-auto flex items-center gap-1">
                    <span className="text-[rgb(var(--ss-faint))]">模式</span>
                    <select
                      className="rounded border border-[rgb(var(--ss-border))] bg-transparent px-1 py-0.5"
                      value={activeMode.quizConfig.solveMode}
                      onChange={(e) =>
                        void api.modes?.save?.({
                          ...activeMode,
                          quizConfig: { ...activeMode.quizConfig!, solveMode: e.target.value as 'normal' | 'agent' }
                        })
                      }
                      title="常规：一次多模态作答；Agent：本机工作区解题并自测"
                    >
                      <option value="normal">常规</option>
                      <option value="agent">Agent</option>
                    </select>
                  </label>
                </div>
              )}
            </div>

            {/* 退出确认：原版「保存本次记录？」+ 保存并关闭 / 不保存，直接关闭 */}
            {askingExit && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgb(var(--ss-base)/0.55)] p-4">
                <div className="w-full max-w-[300px] rounded-xl border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-3 shadow-xl">
                  <div className="mb-1 text-[13px] font-medium">
                    {activeMode?.type === 'quiz' ? '是否保存本次常规答题记录？' : '保存本次记录？'}
                  </div>
                  <div className="mb-3 text-[11px] text-[rgb(var(--ss-muted))]">
                    共 {items.length} 条问答。不保存则直接关闭，之后无法找回。
                  </div>
                  <label className="mb-3 flex items-center gap-2 text-[11px] text-[rgb(var(--ss-muted))]">
                    <input
                      type="checkbox"
                      checked={rememberChoice}
                      onChange={(e) => setRememberChoice(e.target.checked)}
                    />
                    开启后，退出自动保存记录，不再弹出确认
                  </label>
                  <div className="flex gap-2">
                    <button
                      className="flex-1 rounded-md bg-[rgb(var(--ss-primary))] px-2 py-1.5 text-[12px] text-[rgb(var(--ss-primary-fg))] hover:brightness-110"
                      onClick={() => {
                        setAskingExit(false)
                        doExit(true)
                      }}
                    >
                      保存并关闭
                    </button>
                    <button
                      className="flex-1 rounded-md border border-[rgb(var(--ss-border))] px-2 py-1.5 text-[12px] text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-3))]"
                      onClick={() => {
                        setAskingExit(false)
                        doExit(false)
                      }}
                    >
                      不保存，直接关闭
                    </button>
                  </div>
                  <button
                    className="mt-2 w-full text-[11px] text-[rgb(var(--ss-faint))] hover:underline"
                    onClick={() => setAskingExit(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 设置弹层 */}
            {showSettings && (
              <div className="absolute right-2 top-2 z-20 w-64 rounded-xl border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-3 shadow-lg">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[12px] font-medium">悬浮条设置</span>
                  <button className="ml-auto text-[11px] text-[rgb(var(--ss-muted))]" onClick={() => setShowSettings(false)}>
                    收起
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="mb-1 text-[11px] text-[rgb(var(--ss-muted))]">
                      悬浮条透明度：{Math.round(localOpacity * 100)}%
                    </div>
                    <input
                      type="range"
                      min="0.2"
                      max="1"
                      step="0.01"
                      value={localOpacity}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setLocalOpacity(v)
                        void api.bar?.setOpacity?.(v)
                      }}
                      onMouseUp={() => void api.settings?.patch?.({ ui: { opacity: localOpacity } } as never)}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="text-[11px] text-[rgb(var(--ss-muted))]">截屏快捷键</div>
                    <div className="font-mono text-[12px]">{prettyShortcut(settings?.hotkeys?.screenshot ?? '')}</div>
                    <div className="text-[10px] text-[rgb(var(--ss-faint))]">在「高级设置 → 快捷键」里修改</div>
                  </div>

                  <label className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={activeMode?.quizConfig?.useMediaKey ?? false}
                      onChange={(e) => {
                        if (!activeMode?.quizConfig) return
                        void api.modes
                          ?.save?.({
                            ...activeMode,
                            quizConfig: { ...activeMode.quizConfig, useMediaKey: e.target.checked }
                          })
                          ?.catch(() => undefined)
                      }}
                    />
                    媒体键触发截屏（耳机播放键）
                  </label>

                  {activeMode?.quizConfig && (
                    <div>
                      <div className="mb-1 text-[11px] text-[rgb(var(--ss-muted))]">
                        截图质量：{activeMode.quizConfig.jpegQuality}
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={activeMode.quizConfig.jpegQuality}
                        onChange={(e) => {
                          void api.modes
                            ?.save?.({
                              ...activeMode,
                              quizConfig: { ...activeMode.quizConfig!, jpegQuality: Number(e.target.value) }
                            })
                            ?.catch(() => undefined)
                        }}
                        className="w-full"
                      />
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      className="rounded-md border border-[rgb(var(--ss-border))] px-2 py-1 text-[11px] hover:bg-[rgb(var(--ss-3))]"
                      onClick={() => void api.app?.openWindow?.('main')}
                    >
                      打开主界面
                    </button>
                    <button
                      className="rounded-md border border-[rgb(var(--ss-border))] px-2 py-1 text-[11px] hover:bg-[rgb(var(--ss-3))]"
                      onClick={() => void api.app?.openWindow?.('quiz')}
                    >
                      打开笔试窗口
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================= 右下角缩放手柄 ================= */}
      <div
        className="ss-no-drag fixed bottom-0.5 right-0.5 z-30 h-4 w-4 cursor-nwse-resize"
        title="拖动调整窗口大小"
        onMouseDown={startResize}
        style={{
          background:
            'linear-gradient(135deg, transparent 0 45%, rgb(var(--ss-faint) / 0.6) 45% 55%, transparent 55% 65%, rgb(var(--ss-faint) / 0.6) 65% 75%, transparent 75%)'
        }}
      />
    </div>
  )
}
