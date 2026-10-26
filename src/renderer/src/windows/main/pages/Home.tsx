import React from 'react'
import { Badge, Button, Card, Empty, Input, ListRow, Select, Tabs, Textarea, cx } from '@renderer/ui'
import type { SessionKind, SessionRecord, Settings, TodoItem } from '@shared/types'
import type { MainWindowApi } from '@shared/ipc'
import QuizPrep from './QuizPrep'

/** 随思助手首页：标签页 + 工具条 + 会话列表（布局对齐原版主界面） */

const api = window.api as unknown as MainWindowApi

type HomeTab = 'meeting' | 'interview' | 'quiz' | 'todos'

const TAB_KINDS: Record<Exclude<HomeTab, 'todos'>, SessionKind[]> = {
  meeting: ['meeting', 'interview_assist'],
  interview: ['ai_interview'],
  quiz: ['quiz']
}

export default function Home({
  settings,
  sessions,
  onReload,
  onOpenRecord
}: {
  settings: Settings
  sessions: SessionRecord[]
  onReload: () => void
  onOpenRecord: (record: SessionRecord) => void
}): React.ReactElement {
  const [tab, setTab] = React.useState<HomeTab>('meeting')
  const [query, setQuery] = React.useState('')
  const [sort, setSort] = React.useState<'recent' | 'oldest'>('recent')
  const [todos, setTodos] = React.useState<TodoItem[]>([])
  const [newTitle, setNewTitle] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    void api.todos.list().then(setTodos)
  }, [tab])

  const counts = React.useMemo(() => {
    const by = (kinds: SessionKind[]) => sessions.filter((s) => kinds.includes(s.kind)).length
    return {
      meeting: by(TAB_KINDS.meeting),
      interview: by(TAB_KINDS.interview),
      quiz: by(TAB_KINDS.quiz),
      todos: todos.length
    }
  }, [sessions, todos])

  const list = React.useMemo(() => {
    if (tab === 'todos') return []
    const kinds = TAB_KINDS[tab]
    let items = sessions.filter((s) => kinds.includes(s.kind))
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      items = items.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.qa.some((qa) => qa.question.toLowerCase().includes(q) || qa.answer.toLowerCase().includes(q))
      )
    }
    return items.sort((a, b) => (sort === 'recent' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt))
  }, [tab, sessions, query, sort])

  /** 新建会话并直接进入悬浮窗开始 */
  const startMeeting = async (): Promise<void> => {
    setBusy(true)
    /*
     * 只负责「把悬浮窗叫起来开始」，会话与采集都由悬浮窗建立。
     *
     * 以前这里先自己 sessions.create 再 live.start，会留下一个空的「未命名会话」；
     * 而且悬浮窗一打开就是「停止」态，但并没有采集音频，
     * 用户得先点停止、再点开始（走设备检查）才真正跑起来。
     */
    await api.floating.start({ kind: 'meeting', title: newTitle.trim() || undefined })
    setBusy(false)
    setCreating(false)
    setNewTitle('')
    onReload()
  }

  return (
    <>
      {/* 标题 + 标签页 */}
      <header className="shrink-0 px-6 pt-5">
        <h1 className="ss-page-title">以下犯上</h1>
        <div className="mt-3">
          <Tabs<HomeTab>
            value={tab}
            onChange={setTab}
            items={[
              { value: 'meeting', label: '会议/面试助答' },
              { value: 'interview', label: 'AI 面试' },
              { value: 'quiz', label: '笔试解题' },
              { value: 'todos', label: '我的安排' }
            ]}
          />
        </div>
      </header>

      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--ss-border))] px-6 py-3">
        <div className="relative w-[260px] shrink-0">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模板或记录…"
            className="pl-8"
          />
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-[rgb(var(--ss-faint))]">
            🔍
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button size="sm" variant={query === '' ? 'secondary' : 'ghost'} onClick={() => setQuery('')}>
            全部 {sessions.length}
          </Button>
          <Button size="sm" variant="ghost" disabled>
            麦克风 {settings.audio.micEnabled ? counts.meeting : 0}
          </Button>
          <Button size="sm" variant="ghost" disabled>
            电脑音频 {settings.audio.systemAudioEnabled ? counts.meeting : 0}
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'oldest')} className="w-[92px]">
            <option value="recent">最近</option>
            <option value="oldest">最早</option>
          </Select>
          <Button onClick={onReload}>刷新</Button>

          {tab === 'meeting' && (
            <Button variant="primary" onClick={() => setCreating((v) => !v)}>
              新建会话
            </Button>
          )}
          {tab === 'interview' && (
            <Button variant="primary" onClick={() => void api.app.openWindow('interview')}>
              新建面试
            </Button>
          )}
          {tab === 'todos' && (
            <Button variant="primary" onClick={() => void api.todos.add('新的待办').then(setTodos)}>
              新建待办
            </Button>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {creating && tab === 'meeting' && (
          <Card className="mb-4" title="新建会话">
            <div className="space-y-3">
              <Textarea
                rows={2}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="会话名称（可留空）"
              />
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void startMeeting()}>
                  {busy ? '启动中…' : '创建并打开悬浮窗'}
                </Button>
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <span className="ss-list-count">
                  当前采集方式：
                  {settings.audio.systemAudioEnabled ? '电脑音频' : settings.audio.micEnabled ? '麦克风' : '未开启'}
                </span>
              </div>
            </div>
          </Card>
        )}

        {tab === 'quiz' ? (
          /* 原版流程：点笔试先进「准备」页，选好截图来源与名称再开始 */
          <QuizPrep settings={settings} onStarted={onReload} />
        ) : tab === 'todos' ? (
          <TodoList todos={todos} onChange={setTodos} />
        ) : list.length === 0 ? (
          <Empty>
            {tab === 'meeting'
              ? '还没有会话记录。点击右上「新建会话」开始一次会议助答，内容会自动保存到本机。'
              : tab === 'interview'
                ? '还没有面试记录。点击「新建面试」开始一次模拟面试。'
                : '还没有笔试记录。'}
          </Empty>
        ) : (
          <div className="space-y-1">
            {list.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                agentName={
                  settings.agents.find((a) => a.id === settings.activeAgentId)?.name ?? '默认'
                }
                captureMode={settings.audio.systemAudioEnabled ? '电脑音频' : '麦克风'}
                onOpen={() => onOpenRecord(session)}
                onDelete={async () => {
                  await api.sessions.remove(session.id)
                  onReload()
                }}
                onStart={async () => {
                  await api.floating.start({ kind: 'meeting' })
                }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function SessionRow({
  session,
  agentName,
  captureMode,
  onOpen,
  onDelete,
  onStart
}: {
  session: SessionRecord
  agentName: string
  captureMode: string
  onOpen: () => void
  onDelete: () => void
  onStart: () => void
}): React.ReactElement {
  const kindLabel =
    session.kind === 'meeting'
      ? '会议'
      : session.kind === 'interview_assist'
        ? '面试助答'
        : session.kind === 'ai_interview'
          ? 'AI 面试'
          : session.kind === 'quiz'
            ? '笔试'
            : '对话'

  return (
    <ListRow className="gap-4 border-b border-[rgb(var(--ss-border)/0.6)] py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--ss-2))] text-[14px]">
        {session.kind === 'quiz' ? '📝' : session.kind === 'ai_interview' ? '🎤' : '🎧'}
      </div>

      <div className="min-w-0 flex-[2]">
        <div className="truncate text-[13px] font-medium">{session.title}</div>
        <div className="ss-list-count truncate">
          {kindLabel} · 问答 {session.qa.length} · 转写 {session.transcript.length}
        </div>
      </div>

      <div className="w-[92px] shrink-0">
        <Button size="sm" onClick={onStart}>
          开始 →
        </Button>
      </div>

      <div className="w-[86px] shrink-0">
        <Badge>{captureMode}</Badge>
      </div>

      <div className="w-[120px] shrink-0 truncate">
        <Badge tone="mic">@{agentName}</Badge>
      </div>

      <div className="ss-list-count w-[120px] shrink-0">
        {new Date(session.updatedAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onOpen} title="查看记录">
          查看
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} title="删除记录">
          ✕
        </Button>
      </div>
    </ListRow>
  )
}

function TodoList({
  todos,
  onChange
}: {
  todos: TodoItem[]
  onChange: (next: TodoItem[]) => void
}): React.ReactElement {
  const [draft, setDraft] = React.useState('')
  return (
    <div className="max-w-3xl space-y-3">
      <Card title={`今日待办（${todos.filter((t) => !t.done).length} 项未完成）`}>
        <div className="mb-3 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                void api.todos.add(draft.trim()).then((next) => {
                  onChange(next)
                  setDraft('')
                })
              }
            }}
            placeholder="添加一项待办，回车确认"
          />
          <Button
            variant="primary"
            onClick={() => {
              if (!draft.trim()) return
              void api.todos.add(draft.trim()).then((next) => {
                onChange(next)
                setDraft('')
              })
            }}
          >
            添加
          </Button>
        </div>

        {todos.length === 0 ? (
          <Empty>今天没有安排</Empty>
        ) : (
          <div className="space-y-1">
            {todos.map((todo) => (
              <div key={todo.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[rgb(var(--ss-2)/0.6)]">
                <button
                  onClick={() => void api.todos.toggle(todo.id).then(onChange)}
                  className={cx(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                    todo.done
                      ? 'border-transparent bg-[rgb(var(--ss-success))] text-white'
                      : 'border-[rgb(var(--ss-border))]'
                  )}
                >
                  {todo.done ? '✓' : ''}
                </button>
                <span className={cx('min-w-0 flex-1 text-[13px]', todo.done && 'text-[rgb(var(--ss-faint))] line-through')}>
                  {todo.text}
                </span>
                <span className="ss-list-count">{new Date(todo.createdAt).toLocaleDateString('zh-CN')}</span>
                <Button size="sm" variant="ghost" onClick={() => void api.todos.remove(todo.id).then(onChange)}>
                  ✕
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
