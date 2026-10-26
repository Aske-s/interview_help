import React from 'react'
import { PreflightGate } from '@renderer/windows/floating/PreflightGate'
import { Badge, Button, Card, Empty, Field, Input, Markdown, Select, Tabs, Textarea, cx } from '@renderer/ui'
import type {
  InterviewConfig,
  InterviewDifficulty,
  InterviewFocus,
  InterviewPacing,
  InterviewSession
} from '@shared/types'
import type { InterviewWindowApi } from '@shared/ipc'

/**
 * AI 面试窗口。
 *
 * 配置维度：岗位、面试官角色设定、难度等级、考察节奏（评分驱动/固定轮数）、
 * 考察偏好、单题超时、简历 PDF 解析。
 * 流程：开场自我介绍 → 项目深挖 → 技术考察 → 行为协作 → 候选人反问 → 复盘。
 * 另支持随时生成复盘（不结束面试）、结束并生成复盘、导出 Markdown。
 */

const api = window.api as unknown as InterviewWindowApi

/**
 * 预加载层仍按 `invoke(IPC.InterviewCreate, role, background)` 透传参数，
 * 因此这里把整份 InterviewConfig 当作第一个参数传过去，主进程会识别对象形态。
 * （shared/ipc.ts 的 InterviewApi.create 仍是旧签名，故需要一次显式断言。）
 */

const PHASE_LABEL: Record<string, string> = {
  idle: '未开始',
  intro: '开场自我介绍',
  project: '项目深挖',
  technical: '技术考察',
  behavioral: '行为协作',
  candidate_qa: '反问环节',
  review: '复盘'
}

/** 计入考察轮数的核心阶段（开场与反问不计入） */
const CORE_PHASES = ['project', 'technical', 'behavioral']

const DIFFICULTY_OPTIONS: Array<{ value: InterviewDifficulty; label: string }> = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
  { value: 'expert', label: '专家' }
]

const FOCUS_OPTIONS: Array<{ value: InterviewFocus; label: string }> = [
  { value: 'balanced', label: '均衡' },
  { value: 'fundamentals', label: '侧重八股基础' },
  { value: 'system_design', label: '侧重系统设计架构' },
  { value: 'project', label: '基础+项目各半' },
  { value: 'breadth', label: '广度优先' }
]

const DEFAULT_CONFIG: InterviewConfig = {
  role: '',
  interviewer: '资深技术面试官',
  difficulty: 'medium',
  pacing: 'adaptive',
  fixedRounds: 6,
  focus: 'balanced',
  timeoutSec: 0,
  background: ''
}

const MAX_TURNS = 15

function labelOf<T extends string>(options: Array<{ value: T; label: string }>, value: T): string {
  return options.find((o) => o.value === value)?.label ?? value
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 兼容旧会话：config 缺失时用默认值补齐，避免渲染期崩溃 */
function configOf(session: InterviewSession | null): InterviewConfig {
  return { ...DEFAULT_CONFIG, ...(session?.config ?? {}) }
}

export default function App(): React.ReactElement {
  // —— 配置表单 ——
  const [role, setRole] = React.useState('')
  const [interviewer, setInterviewer] = React.useState(DEFAULT_CONFIG.interviewer)
  const [difficulty, setDifficulty] = React.useState<InterviewDifficulty>('medium')
  const [pacing, setPacing] = React.useState<InterviewPacing>('adaptive')
  const [fixedRounds, setFixedRounds] = React.useState(6)
  const [focus, setFocus] = React.useState<InterviewFocus>('balanced')
  const [timeoutSec, setTimeoutSec] = React.useState(0)
  const [background, setBackground] = React.useState('')
  const [resumeName, setResumeName] = React.useState('')

  // —— 会话 ——
  const [session, setSession] = React.useState<InterviewSession | null>(null)
  const [sessions, setSessions] = React.useState<InterviewSession[]>([])
  const [tab, setTab] = React.useState<'chat' | 'review'>('chat')
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [now, setNow] = React.useState(() => Date.now())

  /** 面试前的设备检查（原版：开始前先确认摄像头和麦克风权限） */
  const [preflight, setPreflight] = React.useState(false)
  const [settings, setSettings] = React.useState<Awaited<ReturnType<typeof api.settings.get>> | null>(null)

  const refreshSessions = React.useCallback(async (): Promise<void> => {
    try {
      setSessions(await api.interview.list())
    } catch {
      /* 历史记录读取失败不影响主流程 */
    }
  }, [])

  React.useEffect(() => {
    void api.settings.get().then(setSettings)
    void refreshSessions()
  }, [refreshSessions])

  const config = configOf(session)
  const live = session ? session.phase !== 'review' : false

  /**
   * 当前待回答的问题：最后一轮还没写回 answer 的那条。
   * 反问环节里 question 是「候选人自己的提问」，因此不参与待答判断。
   */
  const pendingTurn = React.useMemo(() => {
    if (!session || session.phase === 'candidate_qa') return null
    const last = session.turns[session.turns.length - 1]
    return last && last.answer === undefined ? last : null
  }, [session])

  // 计时器：有待答问题或处于反问环节时按秒刷新
  React.useEffect(() => {
    if (!session || session.phase === 'review') return
    if (!pendingTurn && session.phase !== 'candidate_qa') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [session, pendingTurn])

  const elapsedSec = pendingTurn ? Math.max(0, Math.floor((now - pendingTurn.createdAt) / 1000)) : 0
  const overTime = Boolean(pendingTurn) && config.timeoutSec > 0 && elapsedSec > config.timeoutSec

  const coreAnswered = session ? session.turns.filter((t) => t.answer !== undefined && CORE_PHASES.includes(t.phase)).length : 0
  const answeredTurns = session ? session.turns.filter((t) => t.answer !== undefined).length : 0

  const guard = async (fn: () => Promise<InterviewSession>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setSession(await fn())
      void refreshSessions()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const guardVoid = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const currentConfig = (): InterviewConfig => ({
    role: role.trim() || DEFAULT_CONFIG.role,
    interviewer: interviewer.trim() || DEFAULT_CONFIG.interviewer,
    difficulty,
    pacing,
    fixedRounds,
    focus,
    timeoutSec,
    background,
    resumeName: resumeName || undefined
  })

  const begin = (): void => {
    if (!role.trim() || busy) return
    if (settings?.preflightCheck) {
      setPreflight(true)
      return
    }
    void startInterview()
  }

  const startInterview = () =>
    guard(async () => {
      const created = await api.interview.create(currentConfig())
      // 先切到会话态：即使随后出题失败，也不会丢掉刚创建的会话
      setSession(created)
      setTab('chat')
      return api.interview.start(created.id)
    })

  /** 上一题已作答但下一题没生成成功时，重新让面试官提问 */
  const resumeAsking = () => {
    if (!session) return
    void guard(() => api.interview.start(session.id))
  }

  const send = () => {
    if (!session || !text.trim() || busy) return
    // 反问环节：用户输入的是给面试官的问题
    if (session.phase !== 'candidate_qa' && !pendingTurn) return
    const answer = text
    setText('')
    return guard(() => api.interview.answer(session.id, answer))
  }

  const uploadResume = () =>
    guardVoid(async () => {
      setHint('')
      const path = await api.app.pickFile({ title: '选择简历文件', extensions: ['pdf', 'docx', 'txt', 'md'] })
      if (!path) return
      setBusy(true)
      const result = await api.interview.parseResume(path)
      if (!result.ok || !result.data) {
        setError(result.error ?? '简历解析失败')
        return
      }
      setBackground(result.data.text)
      setResumeName(result.data.name)
      setHint(`已解析《${result.data.name}》，提取 ${result.data.text.length} 字，可在下方手动编辑`)
    })

  const generateReview = () => {
    if (!session) return
    void guard(async () => {
      const next = await api.interview.generateReview(session.id)
      setTab('review')
      setHint('已生成复盘报告，可随时返回对话继续面试')
      return next
    })
  }

  const finish = () => {
    if (!session) return
    void guard(async () => {
      const next = await api.interview.finish(session.id)
      setTab('review')
      setHint('面试已结束，复盘报告已生成')
      return next
    })
  }

  const exportMarkdown = async (): Promise<void> => {
    if (!session?.review) return
    const cfg = configOf(session)
    const header = [
      `# 模拟面试复盘报告`,
      '',
      `- 目标岗位：${session.role}`,
      `- 面试官设定：${cfg.interviewer}`,
      `- 难度：${labelOf(DIFFICULTY_OPTIONS, cfg.difficulty)}`,
      `- 考察偏好：${labelOf(FOCUS_OPTIONS, cfg.focus)}`,
      `- 考察节奏：${cfg.pacing === 'fixed' ? `固定 ${cfg.fixedRounds} 轮核心问题` : '评分驱动自适应'}`,
      `- 单题限时：${cfg.timeoutSec > 0 ? `${cfg.timeoutSec} 秒` : '不限'}`,
      `- 生成时间：${new Date().toLocaleString()}`,
      '',
      '---',
      ''
    ].join('\n')
    const markdown = `${header}${session.review}\n`
    try {
      // 用系统保存对话框，让用户自己选位置（此前是浏览器式下载，桌面端不合适）
      const saved = await api.app.saveFile({
        title: '保存面试复盘',
        defaultName: `面试复盘-${session.role}-${new Date().toISOString().slice(0, 10)}.md`,
        content: markdown,
        extensions: ['md']
      })
      setHint(saved ? `已导出到 ${saved}` : '已取消导出')
    } catch (e) {
      setError(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    // 备份路径：部分环境不会弹出保存框，顺便复制到剪贴板
    // 悬浮窗场景下 navigator.clipboard 会因「文档未聚焦」失败，统一走主进程
    void api.clipboard.writeText(markdown).catch(() => undefined)
  }

  const openSession = (item: InterviewSession): void => {
    setSession(item)
    setResumeName(item.config?.resumeName ?? '')
    setRole(item.role)
    setTab('chat')
    setError('')
    setNow(Date.now())
  }

  const removeSession = (id: string) =>
    guardVoid(async () => {
      await api.interview.remove(id)
      if (session?.id === id) setSession(null)
      await refreshSessions()
    })

  if (preflight && settings) {
    return (
      <div className="ss-app-shell h-full">
        <PreflightGate
          checkSystemAudio={settings.audio.systemAudioEnabled}
          micDeviceId={settings.audio.micDeviceId || undefined}
          cameraDeviceId={settings.audio.cameraDeviceId || undefined}
          onProceed={() => void startInterview()}
          onCancel={() => setPreflight(false)}
          onResult={(result) => void api.diagnostics.saveDeviceCheck(result)}
        />
      </div>
    )
  }

  const inputDisabled = !session || busy || session.phase === 'review'
  const canSend = Boolean(session) && !busy && text.trim().length > 0 && (session?.phase === 'candidate_qa' || Boolean(pendingTurn))

  return (
    <div className="ss-app-shell flex h-full">
      <aside className="w-80 shrink-0 space-y-3 overflow-auto border-r border-[rgb(var(--ss-border)/0.5)] p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">模拟面试</div>
          {session && <Badge tone="accent">{PHASE_LABEL[session.phase] ?? session.phase}</Badge>}
        </div>

        <Field label="目标岗位">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如：资深后端工程师" disabled={Boolean(session)} />
        </Field>

        <Field label="面试官角色设定" hint="决定提问视角与追问风格，例如「资深后端面试官 / 架构师 / HRBP」">
          <Input
            value={interviewer}
            onChange={(e) => setInterviewer(e.target.value)}
            placeholder="例如：一线大厂资深后端面试官"
            disabled={Boolean(session)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="难度等级">
            <Select value={difficulty} onChange={(e) => setDifficulty(e.target.value as InterviewDifficulty)} disabled={Boolean(session)}>
              {DIFFICULTY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="考察节奏">
            <Select value={pacing} onChange={(e) => setPacing(e.target.value as InterviewPacing)} disabled={Boolean(session)}>
              <option value="adaptive">评分驱动</option>
              <option value="fixed">固定轮数</option>
            </Select>
          </Field>
        </div>

        {pacing === 'fixed' && (
          <Field label="核心问题轮数" hint="3-15 轮，仅限制核心技术问题；开场与反问不计入">
            <Select value={String(fixedRounds)} onChange={(e) => setFixedRounds(Number(e.target.value))} disabled={Boolean(session)}>
              {Array.from({ length: 13 }, (_, i) => i + 3).map((n) => (
                <option key={n} value={n}>
                  {n} 轮
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="考察偏好">
          <Select value={focus} onChange={(e) => setFocus(e.target.value as InterviewFocus)} disabled={Boolean(session)}>
            {FOCUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="单题超时（秒）" hint="0 表示不限；超时只提示，不强制结束">
          <Input
            type="number"
            min={0}
            max={3600}
            value={String(timeoutSec)}
            onChange={(e) => setTimeoutSec(Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
            disabled={Boolean(session)}
          />
        </Field>

        <Field label="候选人背景（简历）" hint="上传 PDF 自动解析，或直接粘贴/输入简历内容">
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || Boolean(session)} onClick={() => void uploadResume()}>
              上传 PDF
            </Button>
            {resumeName && <span className="min-w-0 truncate text-[11px] text-[rgb(var(--ss-muted))]">{resumeName}</span>}
          </div>
          <Textarea
            className="mt-2"
            rows={7}
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="项目经历、技术栈、想重点准备的内容…"
            disabled={Boolean(session)}
          />
        </Field>

        {!session ? (
          <Button variant="primary" className="w-full" disabled={busy || !role.trim()} onClick={begin}>
            {busy ? '准备中…' : '开始面试'}
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={busy || Boolean(pendingTurn) || session.phase === 'candidate_qa'} onClick={resumeAsking}>
                继续提问
              </Button>
              <Button disabled={busy} onClick={generateReview}>
                生成复盘
              </Button>
            </div>
            <Button disabled={busy || !session.review} onClick={exportMarkdown}>
              导出 Markdown
            </Button>
            <Button variant="primary" className="w-full" disabled={busy} onClick={finish}>
              结束考察并生成复盘
            </Button>
            <Button className="w-full" disabled={busy} onClick={() => setSession(null)}>
              重新配置新面试
            </Button>
            <div className="text-[11px] leading-relaxed text-[rgb(var(--ss-muted))]">
              已作答 {answeredTurns} 轮
              {session.config?.pacing === 'fixed'
                ? ` · 核心问题 ${coreAnswered}/${session.config.fixedRounds}`
                : ` · 上限 ${MAX_TURNS} 轮`}
            </div>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="space-y-1.5 border-t border-[rgb(var(--ss-border)/0.5)] pt-3">
            <div className="text-[12px] font-medium text-[rgb(var(--ss-muted))]">历史面试</div>
            {sessions.slice(0, 8).map((item) => (
              <div
                key={item.id}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]',
                  session?.id === item.id ? 'bg-[rgb(var(--ss-2))]' : 'hover:bg-[rgb(var(--ss-2)/0.6)]'
                )}
              >
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => openSession(item)} title={item.role}>
                  {item.role}
                  <span className="ml-1 text-[rgb(var(--ss-faint))]">
                    {item.finished || item.phase === 'review' ? '已结束' : PHASE_LABEL[item.phase] ?? item.phase}
                  </span>
                </button>
                <button
                  className="shrink-0 text-[rgb(var(--ss-faint))] hover:text-[rgb(var(--ss-danger))]"
                  onClick={() => void removeSession(item.id)}
                  title="删除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-[rgb(var(--ss-border)/0.5)] px-4 py-3">
          <span className="min-w-0 truncate text-sm font-semibold">{session?.role ?? '未开始面试'}</span>
          {session && (
            <>
              <Badge tone="accent">{PHASE_LABEL[session.phase] ?? session.phase}</Badge>
              <Badge>{labelOf(DIFFICULTY_OPTIONS, config.difficulty)}</Badge>
              <Badge>{labelOf(FOCUS_OPTIONS, config.focus)}</Badge>
              {config.pacing === 'fixed' && <Badge>固定 {config.fixedRounds} 轮</Badge>}
            </>
          )}
          {session && session.review && (
            <div className="ml-auto">
              <Tabs
                value={tab}
                onChange={(v) => setTab(v)}
                items={[
                  { value: 'chat', label: '对话' },
                  { value: 'review', label: '复盘' }
                ]}
              />
            </div>
          )}
        </header>

        {/* 反问环节提示 + 单题计时 */}
        {pendingTurn && (
          <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--ss-border)/0.5)] px-4 py-2 text-[11px] text-[rgb(var(--ss-muted))]">
            <span>本题已用 {formatDuration(elapsedSec)}</span>
            {config.timeoutSec > 0 && <span>限时 {config.timeoutSec} 秒</span>}
            {overTime && <span className="text-[rgb(var(--ss-danger))]">已超时，可以继续作答，超时不会强制结束</span>}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {(error || hint) && (
            <div className="space-y-2">
              {error && (
                <div className="rounded-lg border border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.12)] px-3 py-2 text-xs">
                  {error}
                </div>
              )}
              {hint && <div className="px-1 text-[11px] text-[rgb(var(--ss-muted))]">{hint}</div>}
            </div>
          )}

          {!session ? (
            <Empty>填写岗位与面试官设定后点「开始面试」</Empty>
          ) : tab === 'review' && session.review ? (
            <Card
              title="复盘报告"
              extra={
                <Button size="sm" onClick={exportMarkdown}>
                  导出 Markdown
                </Button>
              }
            >
              <Markdown>{session.review}</Markdown>
            </Card>
          ) : (
            <>
              {session.phase === 'candidate_qa' && (
                <div className="rounded-lg border border-[rgb(var(--ss-accent)/0.5)] bg-[rgb(var(--ss-accent)/0.08)] px-3 py-2.5 text-sm">
                  <span className="font-medium">轮到你了：可以向面试官提问</span>
                  <span className="ml-2 text-[11px] text-[rgb(var(--ss-muted))]">
                    例如岗位职责、团队协作方式、技术栈与成长空间；问完后点「结束考察并生成复盘」
                  </span>
                </div>
              )}

              {session.turns.length === 0 && (
                <div className="rounded-lg bg-[rgb(var(--ss-2))] px-3 py-2 text-[12px] text-[rgb(var(--ss-muted))]">
                  会话已创建，点左侧「继续提问」让面试官出第一题。
                </div>
              )}

              {session.turns.map((turn, index) => {
                const isQa = turn.phase === 'candidate_qa'
                const seconds = typeof turn.elapsedMs === 'number' ? Math.round(turn.elapsedMs / 1000) : null
                return (
                  <div key={turn.id} className="space-y-2">
                    <div className="rounded-lg bg-[rgb(var(--ss-2))] p-3 text-sm">
                      <span className="mr-2 text-[11px] text-[rgb(var(--ss-muted))]">
                        {isQa ? `第 ${index + 1} 条 · 我的提问` : `第 ${index + 1} 题 · ${PHASE_LABEL[turn.phase]}`}
                      </span>
                      {turn.question}
                    </div>
                    {turn.answer && (
                      <div className="rounded-lg border border-[rgb(var(--ss-border)/0.5)] p-3 text-sm">
                        <div className="mb-1 text-[11px] text-[rgb(var(--ss-muted))]">{isQa ? '面试官' : '我的回答'}</div>
                        <Markdown>{turn.answer}</Markdown>
                        {(turn.score !== undefined || seconds !== null) && (
                          <div className="mt-2 flex items-center gap-2">
                            {turn.score !== undefined && (
                              <Badge tone={turn.score >= 75 ? 'ok' : turn.score >= 55 ? 'warn' : 'danger'}>{turn.score} 分</Badge>
                            )}
                            {turn.comment && <span className="text-[11px] text-[rgb(var(--ss-muted))]">{turn.comment}</span>}
                            {seconds !== null && (
                              <span className="ml-auto shrink-0 text-[11px] text-[rgb(var(--ss-faint))]">用时 {seconds}s</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {busy && <div className="text-xs text-[rgb(var(--ss-muted))]">面试官思考中…</div>}
        </div>

        <footer className="shrink-0 border-t border-[rgb(var(--ss-border)/0.5)] p-3">
          <div className="flex gap-2">
            <Textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={
                session?.phase === 'candidate_qa'
                  ? '输入你想问面试官的问题，Enter 发送'
                  : pendingTurn
                    ? '输入你的回答，Enter 发送，Shift+Enter 换行'
                    : '上一题已作答，请点左侧「继续提问」'
              }
              disabled={inputDisabled}
            />
            <Button variant="primary" disabled={!canSend} onClick={() => void send()}>
              {session?.phase === 'candidate_qa' ? '提问' : '发送'}
            </Button>
          </div>
          {live && session?.phase !== 'candidate_qa' && !pendingTurn && session && session.turns.length > 0 && (
            <div className="mt-2 text-[11px] text-[rgb(var(--ss-muted))]">点左侧「继续提问」让面试官出下一题。</div>
          )}
        </footer>
      </main>
    </div>
  )
}
