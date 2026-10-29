import React from 'react'
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  ListRow,
  Markdown,
  Select,
  Switch,
  Tabs,
  Textarea,
  cx
} from '@renderer/ui'
import { useZoom } from '@renderer/hooks/useZoom'
import { AudioCapture, describeAudioError } from '@renderer/audio/capture'
import type {
  AgentTemplate,
  KnowledgeBase,
  Mode,
  KnowledgeDocument,
  KnowledgePurpose,
  ProviderConfig,
  RetrievedChunk,
  SessionRecord,
  Settings
} from '@shared/types'
import type { GuardSide, GuardStatus, GuardSupport, MainWindowApi } from '@shared/ipc'

/** 主窗口各功能页：AI 智能体 / 知识库 / 最近记录 / 高级设置 */

const api = window.api as unknown as MainWindowApi

type PatchFn = (patch: Parameters<MainWindowApi['settings']['patch']>[0]) => Promise<void>

/**
 * 校验自定义请求参数（渲染层版本，主进程另有一份用于实际合并前的兜底）。
 * 规则保持一致：留空合法；必须是 JSON 对象。
 */
function validateExtraBodyJs(text: string): { ok: boolean; message: string } {
  const raw = (text ?? '').trim()
  if (!raw) return { ok: true, message: '' }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '必须是 JSON 对象，例如 {"enable_thinking": true}' }
    }
    return { ok: true, message: `将合并字段：${Object.keys(parsed).join(', ')}` }
  } catch (error) {
    return { ok: false, message: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` }
  }
}

/* ================================================================== *
 * AI 智能体
 * ================================================================== */

export function Agents({ settings, onPatch }: { settings: Settings; onPatch: PatchFn }): React.ReactElement {
  const [editing, setEditing] = React.useState<AgentTemplate | null>(null)

  const save = async (agent: AgentTemplate): Promise<void> => {
    const next = await api.agents.save(agent)
    await onPatch({ agents: next })
    setEditing(null)
  }

  const remove = async (id: string): Promise<void> => {
    const next = await api.agents.remove(id)
    await onPatch({ agents: next })
  }

  const createNew = (): void => {
    setEditing({
      id: `agent-${Date.now()}`,
      name: '新智能体',
      persona: '',
      style: '',
      knowledgeBaseIds: [],
      // 新建时给原版默认值，避免用户以为"默认就不带上下文"
      memoryRounds: 10
    })
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between px-6 pt-5">
        <h1 className="ss-page-title">AI 智能体</h1>
        <Button variant="primary" onClick={createNew}>
          新建智能体
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div className="grid grid-cols-[280px_1fr] gap-4">
          <div className="space-y-1">
            {settings.agents.map((agent) => (
              <ListRow key={agent.id} active={editing?.id === agent.id} onClick={() => setEditing({ ...agent })}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{agent.name}</div>
                  <div className="ss-list-count truncate">{agent.persona || '未填写角色设定'}</div>
                </div>
                {agent.id === settings.activeAgentId && <Badge tone="ok">使用中</Badge>}
                {agent.builtin && <Badge>内置</Badge>}
              </ListRow>
            ))}
          </div>

          {editing ? (
            <Card title={editing.name || '编辑智能体'}>
              <div className="space-y-4">
                <Field label="角色名称">
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </Field>
                <Field label="角色身份（persona）" hint="定义这个智能体是谁、擅长什么">
                  <Textarea
                    rows={4}
                    value={editing.persona}
                    onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
                    placeholder="你是一名资深的会议参谋，擅长在听会时快速抓住对方问题的要点。"
                  />
                </Field>
                <Field label="回答风格（style）" hint="约束输出结构、语气与长度">
                  <Textarea
                    rows={4}
                    value={editing.style}
                    onChange={(e) => setEditing({ ...editing, style: e.target.value })}
                    placeholder="先给出一句话结论，再用 2-4 个要点展开；语气自然，方便直接照读。"
                  />
                </Field>
                <Field label="绑定知识库" hint="回答时会先检索这些知识库并注入上下文">
                  <div className="space-y-1.5">
                    <KbPicker
                      selected={editing.knowledgeBaseIds}
                      onChange={(ids) => setEditing({ ...editing, knowledgeBaseIds: ids })}
                    />
                  </div>
                </Field>

                <Field
                  label="上下文轮数"
                  hint="带上最近多少轮问答作为对话历史。追问时答案才接得上；0 = 不带历史（原版默认 10）"
                >
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    value={editing.memoryRounds ?? 10}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        // 夹到 0-50：负数没意义，太大既烧 token 也没收益
                        memoryRounds: Math.max(0, Math.min(50, Number(e.target.value) || 0))
                      })
                    }
                  />
                </Field>

                <div className="flex items-center gap-2 pt-1">
                  <Button variant="primary" onClick={() => void save(editing)}>
                    保存
                  </Button>
                  <Button
                    onClick={() => {
                      void onPatch({ activeAgentId: editing.id })
                      void save(editing)
                    }}
                  >
                    保存并设为当前
                  </Button>
                  {!editing.builtin && (
                    <Button variant="danger" onClick={() => void remove(editing.id)}>
                      删除
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    取消
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <Empty>从左侧选择一个智能体进行编辑，或点击「新建智能体」</Empty>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function KbPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }): React.ReactElement {
  const [list, setList] = React.useState<KnowledgeBase[]>([])
  React.useEffect(() => {
    void api.knowledge.list().then(setList)
  }, [])
  if (list.length === 0) return <div className="ss-list-count">还没有知识库，请先到「知识库」创建</div>
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((kb) => {
        const on = selected.includes(kb.id)
        return (
          <button
            key={kb.id}
            onClick={() => onChange(on ? selected.filter((id) => id !== kb.id) : [...selected, kb.id])}
            className={cx(
              'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
              on
                ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))]'
                : 'border-[rgb(var(--ss-border))] text-[rgb(var(--ss-muted))]'
            )}
          >
            {kb.name}
          </button>
        )
      })}
    </div>
  )
}

/* ================================================================== *
 * 知识库
 * ================================================================== */

export function Knowledge(): React.ReactElement {
  const [kbs, setKbs] = React.useState<KnowledgeBase[]>([])
  const [activeKb, setActiveKb] = React.useState<string | null>(null)
  const [docs, setDocs] = React.useState<KnowledgeDocument[]>([])
  const [newName, setNewName] = React.useState('')
  const [newPurpose, setNewPurpose] = React.useState<KnowledgePurpose>('general')
  const [hits, setHits] = React.useState<RetrievedChunk[]>([])
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState('')

  /** 当前选中的知识库对象（用于展示/切换用途） */
  const activeKb_item = kbs.find((kb) => kb.id === activeKb) ?? null

  const reload = React.useCallback(async () => {
    const list = await api.knowledge.list()
    setKbs(list)
    setActiveKb((prev) => prev ?? list[0]?.id ?? null)
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  React.useEffect(() => {
    if (!activeKb) {
      setDocs([])
      return
    }
    void api.knowledge.listDocuments(activeKb).then(setDocs)
    void reload()
  }, [activeKb, status, reload])

  const importFile = async (): Promise<void> => {
    if (!activeKb) return
    const path = await api.app.pickFile({
      title: '选择要导入的文档',
      extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json', 'csv']
    })
    if (!path) return
    setStatus('导入中…')
    const result = await api.knowledge.addDocument(activeKb, { path })
    setStatus(result.ok ? `已导入：${result.data?.name}（${result.data?.chunks} 个分块）` : `导入失败：${result.error}`)
  }

  const pasteText = async (): Promise<void> => {
    if (!activeKb) return
    const text = window.prompt('粘贴文本内容（将作为一个文档导入）')
    if (!text?.trim()) return
    setStatus('导入中…')
    const result = await api.knowledge.addDocument(activeKb, { name: '粘贴文本', text })
    setStatus(result.ok ? `已导入 ${result.data?.chunks} 个分块` : `导入失败：${result.error}`)
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between px-6 pt-5">
        <h1 className="ss-page-title">知识库</h1>
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新知识库名称"
            className="w-[180px]"
          />
          <Select
            value={newPurpose}
            onChange={(e) => setNewPurpose(e.target.value as KnowledgePurpose)}
            className="w-[132px]"
          >
            <option value="general">通用（检索）</option>
            <option value="resume">简历</option>
            <option value="quiz">题库</option>
          </Select>
          <Button
            variant="primary"
            /*
             * 名称为空时直接禁用，而不是点了静默 return ——
             * 后者对用户就是「点了没反应」，很难自己定位。
             */
            disabled={!newName.trim()}
            title={newName.trim() ? '创建知识库' : '请先填写知识库名称'}
            onClick={() => {
              if (!newName.trim()) {
                setStatus('请先填写知识库名称')
                return
              }
              setStatus('正在创建…')
              void api.knowledge
                .create(newName.trim(), undefined, newPurpose)
                .then((list) => {
                  setKbs(list)
                  /*
                   * 新建的库在列表最前面（集合是"新的在前"）。这里主动切过去：
                   * 否则右侧还停在旧库上，看起来就像"没创建成功"。
                   */
                  const created = list[0]
                  if (created) setActiveKb(created.id)
                  setStatus(`已创建「${created?.name ?? newName.trim()}」，可以导入文档了`)
                  setNewName('')
                  setNewPurpose('general')
                })
                .catch((error: unknown) => {
                  setStatus(`创建失败：${error instanceof Error ? error.message : String(error)}`)
                })
            }}
          >
            创建知识库
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <div className="grid grid-cols-[240px_1fr] gap-4">
          <div className="space-y-1">
            {kbs.length === 0 ? (
              <div className="ss-list-count px-2 py-3">还没有知识库</div>
            ) : (
              kbs.map((kb) => (
                <ListRow key={kb.id} active={kb.id === activeKb} onClick={() => setActiveKb(kb.id)}>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{kb.name}</span>
                  {kb.purpose && kb.purpose !== 'general' && (
                    <Badge tone={kb.purpose === 'resume' ? 'ok' : 'warn'}>
                      {kb.purpose === 'resume' ? '简历' : '题库'}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async (e) => {
                      e.stopPropagation()
                      const list = await api.knowledge.remove(kb.id)
                      setKbs(list)
                      if (activeKb === kb.id) setActiveKb(list[0]?.id ?? null)
                    }}
                  >
                    ✕
                  </Button>
                </ListRow>
              ))
            )}
          </div>

          <div className="space-y-4">
            {activeKb ? (
              <>
                <Card title="用途">
                  <div className="flex items-center gap-3">
                    <Select
                      value={activeKb_item?.purpose ?? 'general'}
                      onChange={(e) => {
                        void api.knowledge.setPurpose(activeKb, e.target.value as KnowledgePurpose).then(setKbs)
                      }}
                      className="w-[160px]"
                    >
                      <option value="general">通用（检索）</option>
                      <option value="resume">简历</option>
                      <option value="quiz">题库</option>
                    </Select>
                    <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-[rgb(var(--ss-muted))]">
                      {(activeKb_item?.purpose ?? 'general') === 'resume'
                        ? '上传后由大模型提炼成一份精炼的「速查卡」存下来，之后每次答问只注入这份速查卡（约 1200 字），既贴事实又不占上下文。'
                        : (activeKb_item?.purpose ?? 'general') === 'quiz'
                          ? '整份注入到截图解题的提示词里，作为同类题的解法与模板参考（适合几千字以内的题库）。'
                          : '按当前问题做相似度检索，只注入最相关的几块。适合资料量大、按需查阅的内容。'}
                    </div>
                  </div>
                  {(activeKb_item?.purpose ?? 'general') === 'resume' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[rgb(var(--ss-border))] pt-3">
                      {activeKb_item?.profile ? (
                        <Badge tone="ok">速查卡 {activeKb_item.profile.length} 字</Badge>
                      ) : (
                        <Badge tone="warn">还没生成速查卡</Badge>
                      )}
                      {activeKb_item?.profileAt && (
                        <span className="ss-list-count">
                          {new Date(activeKb_item.profileAt).toLocaleString('zh-CN', { hour12: false })}
                        </span>
                      )}
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (!activeKb) return
                          setStatus('正在解析简历（会调用一次模型，约 10 秒）…')
                          const res = await api.knowledge.distillResume(activeKb)
                          setStatus(res.ok ? `速查卡已生成：${res.chars} 字` : `解析失败：${res.error}`)
                          await reload()
                        }}
                      >
                        {activeKb_item?.profile ? '重新解析' : '解析简历'}
                      </Button>
                      {!activeKb_item?.profile && (
                        <span className="ss-list-count">未生成时仍会用简历原文兜底，不影响使用</span>
                      )}
                    </div>
                  )}
                </Card>
                <Card
                  title={`文档（${docs.length}）`}
                  extra={
                    <div className="flex gap-2">
                      <Button onClick={() => void pasteText()}>粘贴文本</Button>
                      <Button variant="primary" onClick={() => void importFile()}>
                        导入文档
                      </Button>
                    </div>
                  }
                >
                  {status && (
                    <div className="mb-3 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2))] px-3 py-2 text-[12px]">
                      {status}
                    </div>
                  )}
                  {docs.length === 0 ? (
                    <Empty>还没有文档。支持 txt / md / pdf / docx / json / csv，单个文件不超过 20MB。</Empty>
                  ) : (
                    <div className="space-y-1">
                      {docs.map((doc) => (
                        <div key={doc.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[rgb(var(--ss-2)/0.6)]">
                          <span className="min-w-0 flex-1 truncate text-[13px]">{doc.name}</span>
                          <span className="ss-list-count">{doc.chunks} 块</span>
                          <span className="ss-list-count">{doc.chars} 字</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void api.knowledge.removeDocument(doc.id).then(() => setStatus(`已删除 ${doc.name}`))
                            }
                          >
                            ✕
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title="检索测试">
                  <div className="flex gap-2">
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && query.trim()) {
                          void api.knowledge.search([activeKb], query.trim(), 5).then(setHits)
                        }
                      }}
                      placeholder="输入问题，回车测试召回效果"
                    />
                    <Button
                      onClick={() => {
                        if (query.trim()) void api.knowledge.search([activeKb], query.trim(), 5).then(setHits)
                      }}
                    >
                      检索
                    </Button>
                  </div>
                  {hits.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {hits.map((hit, index) => (
                        <div key={index} className="rounded-lg border border-[rgb(var(--ss-border))] p-2.5">
                          <div className="mb-1 flex items-center gap-2">
                            <Badge tone="accent">#{index + 1}</Badge>
                            <span className="ss-list-count truncate">{hit.docName}</span>
                            <span className="ss-list-count ml-auto">score {hit.score.toFixed(3)}</span>
                          </div>
                          <div className="text-[12px] leading-relaxed text-[rgb(var(--ss-muted))]">{hit.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </>
            ) : (
              <Card>
                <Empty>先创建一个知识库，然后导入文档</Empty>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/* ================================================================== *
 * 最近记录
 * ================================================================== */

export function Records({
  sessions,
  active,
  onSelect,
  onReload
}: {
  sessions: SessionRecord[]
  active: SessionRecord | null
  onSelect: (s: SessionRecord | null) => void
  onReload: () => void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')

  const list = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const items = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.qa.some((x) => x.question.toLowerCase().includes(q) || x.answer.toLowerCase().includes(q))
        )
      : sessions
    return items.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query])

  const exportMarkdown = (session: SessionRecord): void => {
    const lines = [
      `# ${session.title}`,
      '',
      `- 类型：${session.kind}`,
      `- 时间：${new Date(session.createdAt).toLocaleString('zh-CN')}`,
      '',
      '## 问答记录',
      '',
      ...session.qa.flatMap((qa, i) => [`### ${i + 1}. ${qa.question}`, '', qa.answer, '']),
      '## 实时转写',
      '',
      ...session.transcript.map((t) => `- ${t.source === 'mic' ? '我方' : '对方'}：${t.text}`)
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${session.title.replace(/[/\\?%*:|"<>]/g, '-')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between px-6 pt-5">
        <h1 className="ss-page-title">{active ? '记录详情' : '最近记录'}</h1>
        <div className="flex items-center gap-2">
          {active ? (
            <>
              <Button onClick={() => exportMarkdown(active)}>导出 Markdown</Button>
              <Button variant="ghost" onClick={() => onSelect(null)}>
                返回列表
              </Button>
            </>
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索记录…"
                className="w-[220px]"
              />
              <Button onClick={onReload}>刷新</Button>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {active ? (
          <div className="max-w-4xl space-y-4">
            <div className="flex items-center gap-2">
              <Badge>{active.kind}</Badge>
              <span className="ss-list-count">
                {new Date(active.createdAt).toLocaleString('zh-CN')} · 问答 {active.qa.length} · 转写{' '}
                {active.transcript.length}
              </span>
            </div>

            <Card title={`问答记录（${active.qa.length}）`}>
              {active.qa.length === 0 ? (
                <Empty>本次会话还没有问答</Empty>
              ) : (
                <div className="space-y-4">
                  {active.qa.map((qa) => (
                    <div key={qa.id} className="rounded-lg border border-[rgb(var(--ss-border))] p-3">
                      <div className="mb-1 text-[12px] font-medium">问：{qa.question}</div>
                      <div className="mb-2 ss-list-count">
                        {new Date(qa.createdAt).toLocaleTimeString('zh-CN')} ·{' '}
                        {qa.trigger === 'auto' ? '自动' : qa.trigger === 'manual' ? '手动' : '截图'}
                      </div>
                      <Markdown>{qa.answer}</Markdown>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={`实时转写（${active.transcript.length} 段）`}>
              {active.transcript.length === 0 ? (
                <Empty>没有转写内容</Empty>
              ) : (
                <div className="space-y-1">
                  {active.transcript.map((t) => (
                    <div key={t.id} className="flex gap-2 text-[12px]">
                      <span
                        className={cx(
                          'w-8 shrink-0',
                          t.source === 'mic' ? 'text-[rgb(var(--ss-mic))]' : 'text-[rgb(var(--ss-success))]'
                        )}
                      >
                        {t.source === 'mic' ? '我方' : '对方'}
                      </span>
                      <span className="min-w-0 flex-1">{t.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : list.length === 0 ? (
          <Empty>还没有记录。开启一次悬浮窗会话后，内容会自动保存到本机。</Empty>
        ) : (
          <div className="space-y-1">
            {list.map((session) => (
              <ListRow
                key={session.id}
                onClick={() => onSelect(session)}
                className="border-b border-[rgb(var(--ss-border)/0.6)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{session.title}</div>
                  <div className="ss-list-count truncate">
                    问答 {session.qa.length} · 转写 {session.transcript.length}
                  </div>
                </div>
                <Badge>{session.kind}</Badge>
                <span className="ss-list-count w-[140px] shrink-0">
                  {new Date(session.updatedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </ListRow>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ================================================================== *
 * 高级设置
 * ================================================================== */

type SettingsTab = 'gateway' | 'modes' | 'asr' | 'assist' | 'stealth' | 'hotkeys' | 'about'

export function SettingsPage({
  settings,
  onPatch,
  provider
}: {
  settings: Settings
  onPatch: PatchFn
  provider?: ProviderConfig
}): React.ReactElement {
  const [tab, setTab] = React.useState<SettingsTab>('gateway')

  return (
    <>
      <header className="shrink-0 px-6 pt-5">
        <h1 className="ss-page-title">高级设置</h1>
        <div className="mt-3">
          <Tabs<SettingsTab>
            value={tab}
            onChange={setTab}
            items={[
              { value: 'gateway', label: '模型网关' },
              { value: 'modes', label: '模式' },
              { value: 'asr', label: '语音识别' },
              { value: 'assist', label: '题目翻译' },
              { value: 'stealth', label: '隐身与安全' },
              { value: 'hotkeys', label: '快捷键' },
              { value: 'about', label: '关于' }
            ]}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {tab === 'gateway' && provider && <GatewaySection settings={settings} onPatch={onPatch} provider={provider} />}
        {tab === 'modes' && <ModesSection settings={settings} onPatch={onPatch} />}
        {tab === 'asr' && <AsrSection settings={settings} onPatch={onPatch} />}
        {tab === 'assist' && <AssistSection settings={settings} onPatch={onPatch} />}
        {tab === 'stealth' && <StealthSection settings={settings} onPatch={onPatch} />}
        {tab === 'hotkeys' && <HotkeySection settings={settings} onPatch={onPatch} />}
        {tab === 'about' && <AboutSection />}
      </div>
    </>
  )
}

function GatewaySection({
  settings,
  onPatch,
  provider
}: {
  settings: Settings
  onPatch: PatchFn
  provider: ProviderConfig
}): React.ReactElement {
  const [testing, setTesting] = React.useState(false)
  const [result, setResult] = React.useState('')
  const [models, setModels] = React.useState<string[]>([])

  /**
   * 表单用本地草稿驱动，保存走「按 id 定向更新」。
   *
   * 为什么不能再用 `settings.providers.map(...)` 整份回写：
   * settings 是渲染时的快照，连续输入时后一次会覆盖前一次，表现为「改了保存不上」。
   */
  const [draft, setDraft] = React.useState<ProviderConfig>(provider)
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMessage, setSaveMessage] = React.useState('')

  // 切换网关或外部改动了该网关时才同步草稿，避免打断正在输入的内容
  const providerSignature = JSON.stringify(provider)
  const lastSyncedRef = React.useRef(providerSignature)
  React.useEffect(() => {
    if (lastSyncedRef.current === providerSignature) return
    lastSyncedRef.current = providerSignature
    setDraft(provider)
  }, [providerSignature, provider])

  const pendingRef = React.useRef(0)

  const update = (field: keyof ProviderConfig, value: unknown): void => {
    // 1) 先更新本地草稿：输入框立即响应，不受 IPC 往返延迟影响
    const nextDraft = { ...draft, [field]: value } as ProviderConfig
    setDraft(nextDraft)

    // 2) 再定向保存到本地文件
    const token = ++pendingRef.current
    setSaveState('saving')
    void api.settings
      .patchProvider(provider.id, { [field]: value } as Partial<ProviderConfig>)
      .then(() => {
        // 只有最后一次写入才有资格把状态标成「已保存」
        if (token !== pendingRef.current) return
        lastSyncedRef.current = JSON.stringify(nextDraft)
        setSaveState('saved')
        setSaveMessage(`已保存到本地 · ${new Date().toLocaleTimeString('zh-CN')}`)
      })
      .catch((error: unknown) => {
        if (token !== pendingRef.current) return
        setSaveState('error')
        setSaveMessage(error instanceof Error ? error.message : String(error))
      })
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card
        title="模型网关（OpenAI 兼容）"
        extra={
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                const res = await api.gateway.listModels(draft)
                if (res.ok) {
                  setModels(res.data ?? [])
                  setResult(`获取到 ${res.data?.length ?? 0} 个模型`)
                } else {
                  setResult(`拉取失败：${res.error}`)
                }
              }}
            >
              拉取模型列表
            </Button>
            <Button
              variant="primary"
              disabled={testing}
              onClick={async () => {
                setTesting(true)
                setResult('测试中…')
                const res = await api.gateway.test(draft)
                setTesting(false)
                setResult(res.ok ? `✅ 连接正常（${res.latencyMs}ms）${res.message}` : `❌ ${res.message}`)
              }}
            >
              {testing ? '测试中…' : '测试连接'}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="网关地址（baseUrl）" hint="OpenAI 兼容，例如 https://api.deepseek.com/v1" className="col-span-2">
            <Input
              value={draft.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
              placeholder="https://api.deepseek.com/v1"
            />
          </Field>
          <Field label="API Key">
            <Input type="password" value={draft.apiKey} onChange={(e) => update('apiKey', e.target.value)} placeholder="sk-…" />
          </Field>
          <Field label="模型名称">
            {models.length > 0 ? (
              <Select value={draft.model} onChange={(e) => update('model', e.target.value)}>
                {!models.includes(draft.model) && <option value={draft.model}>{provider.model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={draft.model} onChange={(e) => update('model', e.target.value)} placeholder="deepseek-chat" />
            )}
          </Field>
          <Field label="最大输出 tokens (max_tokens)">
            <Input type="number" value={draft.maxTokens} onChange={(e) => update('maxTokens', Number(e.target.value))} />
          </Field>          <Field
            label="推理强度 (reasoning_effort)"
            hint="与 OpenAI Codex 的 model_reasoning_effort 同义。新模型普遍用它控制思考深度，而非 temperature。"
          >
            <Select
              value={draft.reasoningEffort}
              onChange={(e) => update('reasoningEffort', e.target.value)}
            >
              <option value="auto">跟随模型默认（不发送该参数）</option>
              <option value="none">none — 关闭思考</option>
              <option value="minimal">minimal — 最少</option>
              <option value="low">low — 低</option>
              <option value="medium">medium — 中</option>
              <option value="high">high — 高</option>
              <option value="xhigh">xhigh — 极高</option>
            </Select>
          </Field>
          <div className="col-span-2">
             <Switch
              checked={draft.supportsVision}
              onChange={(v) => update('supportsVision', v)}
              label="该模型支持图片输入"
              hint="截图解题需要多模态模型（如 gpt-4o / qwen-vl-max / glm-4v）。"
            />
          </div>
        </div>

        <details className="mt-4 rounded-lg border border-[rgb(var(--ss-border))] p-3">
          <summary className="cursor-pointer text-[12px] font-medium text-[rgb(var(--ss-muted))]">
            高级：token 参数名、temperature 与自定义请求参数
          </summary>
          <div className="mt-3 space-y-4">
            <Field
              label="最大 token 的参数名"
              hint="新版 OpenAI 模型（o 系列 / GPT-5）拒收 max_tokens，要求 max_completion_tokens。auto 会按模型名推断，并在网关报错时自动纠正重试。"
            >
              <Select value={draft.maxTokensParam} onChange={(e) => update('maxTokensParam', e.target.value)}>
                <option value="auto">auto — 自动判断（推荐）</option>
                <option value="max_tokens">max_tokens — 旧版 / 大多数兼容网关</option>
                <option value="max_completion_tokens">max_completion_tokens — 新版 OpenAI 推理模型</option>
              </Select>
            </Field>

            <Field
              label="temperature（可选，留空则不发送）"
              hint="推理模型（o 系列 / gpt-5 / deepseek-reasoner 等）通常不接受此参数，硬发可能报错。仅在普通对话模型上使用。"
            >
              <Input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={draft.temperature ?? ''}
                placeholder="不发送"
                onChange={(e) => update('temperature', e.target.value === '' ? undefined : Number(e.target.value))}
              />
            </Field>

            <Field
              label="自定义请求参数（JSON，深合并进请求体）"
              hint={
                '适配各家私有字段。例如通义千问 {"enable_thinking": true}；' +
                'Anthropic 兼容 {"thinking": {"type": "enabled", "budget_tokens": 4096}}'
              }
            >
              <Textarea
                rows={3}
                value={draft.extraBody}
                onChange={(e) => update('extraBody', e.target.value)}
                placeholder='{"enable_thinking": true}'
                className="font-mono text-[12px]"
              />
            </Field>
            {draft.extraBody.trim() &&
              (() => {
                const check = validateExtraBodyJs(draft.extraBody)
                return (
                  <div
                    className={cx(
                      'rounded-lg px-3 py-2 text-[12px]',
                      check.ok
                        ? 'border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2))] text-[rgb(var(--ss-muted))]'
                        : 'border border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.1)] text-[rgb(var(--ss-danger))]'
                    )}
                  >
                    {check.ok ? `✓ ${check.message}` : `✗ ${check.message}`}
                  </div>
                )
              })()}
          </div>
        </details>
        <div className="mt-3 flex items-center gap-2 text-[12px]">
          <span
            className={cx(
              saveState === 'error' ? 'text-[rgb(var(--ss-danger))]' : 'text-[rgb(var(--ss-muted))]'
            )}
          >
            {saveState === 'saving'
              ? '正在保存…'
              : saveState === 'error'
                ? `保存失败：${saveMessage}`
                : saveMessage || '修改会自动保存到本地设置文件'}
          </span>
        </div>

        {result && (
          <div className="mt-3 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2))] px-3 py-2 text-[12px]">
            {result}
          </div>
        )}
      </Card>

      <Card title="向量模型（可选）">
        <div className="space-y-4">
          <Switch
            checked={settings.embedding.enabled}
            onChange={(v) => void onPatch({ embedding: { enabled: v } })}
            label="启用向量检索"
            hint="关闭时知识库自动使用关键词检索，仍然可用。"
          />
          {settings.embedding.enabled && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="向量网关地址">
                <Input
                  value={settings.embedding.baseUrl}
                  onChange={(e) => void onPatch({ embedding: { baseUrl: e.target.value } })}
                  placeholder="https://api.openai.com/v1"
                />
              </Field>
              <Field label="向量模型">
                <Input
                  value={settings.embedding.model}
                  onChange={(e) => void onPatch({ embedding: { model: e.target.value } })}
                  placeholder="text-embedding-3-small"
                />
              </Field>
              <Field label="API Key" className="col-span-2">
                <Input
                  type="password"
                  value={settings.embedding.apiKey}
                  onChange={(e) => void onPatch({ embedding: { apiKey: e.target.value } })}
                />
              </Field>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

function AsrSection({ settings, onPatch }: { settings: Settings; onPatch: PatchFn }): React.ReactElement {
  const { asr, asrTuning, audio } = settings
  const [result, setResult] = React.useState('')
  const [systemAudioResult, setSystemAudioResult] = React.useState('')
  return (
    <div className="max-w-3xl space-y-4">
      <Card title="识别通道">
        <div className="grid grid-cols-2 gap-4">
          <Field label="通道类型">
            <Select value={asr.kind} onChange={(e) => void onPatch({ asr: { kind: e.target.value as never } })}>
              <option value="dashscope-realtime">阿里云百炼 实时识别（流式，边说边出字）</option>
              <option value="whisper-server">本地 whisper.cpp 常驻服务（约 1 秒）</option>
              <option value="openai-compat">云端 / 自建（OpenAI 兼容 /audio/transcriptions）</option>
              <option value="local-whisper-cpp">本地 whisper-cli（每次重载模型，慢，约 15 秒）</option>
            </Select>
          </Field>
          <Field label="语言">
            <Select value={asr.language} onChange={(e) => void onPatch({ asr: { language: e.target.value } })}>
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="auto">自动</option>
            </Select>
          </Field>

          {asr.kind === 'dashscope-realtime' ? (
            <>
              <Field label="API Key" className="col-span-2" hint="阿里云百炼（Model Studio）的 API Key，形如 sk-xxx">
                <Input
                  type="password"
                  value={asr.apiKey}
                  onChange={(e) => void onPatch({ asr: { apiKey: e.target.value } })}
                />
              </Field>
              <Field label="模型" hint="paraformer-realtime-v2 支持任意采样率">
                <Input
                  value={asr.realtimeModel}
                  onChange={(e) => void onPatch({ asr: { realtimeModel: e.target.value } })}
                  placeholder="paraformer-realtime-v2"
                />
              </Field>
              <Field label="服务地址" hint="留空使用官方 wss://dashscope.aliyuncs.com/api-ws/v1/inference">
                <Input
                  value={asr.realtimeUrl}
                  onChange={(e) => void onPatch({ asr: { realtimeUrl: e.target.value } })}
                  placeholder="（留空使用官方地址）"
                />
              </Field>
              <div className="col-span-2">
                <Switch
                  checked={asr.semanticPunctuation}
                  onChange={(v) => void onPatch({ asr: { semanticPunctuation: v } })}
                  label="语义断句"
                  hint="开启：语义断句更准，适合会议转写；关闭：VAD 断句，延迟更低，此时「静音断句」阈值才生效。"
                />
              </div>
              {!asr.semanticPunctuation && (
                <Field label="静音断句（毫秒）" hint="范围 200-6000，默认 800（与原版 aliyunMaxSentenceSilenceMs 一致）">
                  <Input
                    type="number"
                    value={String(asr.vadSilenceMs)}
                    onChange={(e) => void onPatch({ asr: { vadSilenceMs: Number(e.target.value) || 800 } })}
                  />
                </Field>
              )}
              <div className="col-span-2">
                <Switch
                  checked={asr.punctuationPrediction}
                  onChange={(v) => void onPatch({ asr: { punctuationPrediction: v } })}
                  label="标点恢复"
                />
              </div>
              <div className="col-span-2">
                <Switch
                  checked={asr.inverseTextNormalization}
                  onChange={(v) => void onPatch({ asr: { inverseTextNormalization: v } })}
                  label="数字规范化（中文数字转阿拉伯数字）"
                />
              </div>
              <div className="col-span-2 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2)/0.5)] px-3 py-2 text-[12px] text-[rgb(var(--ss-muted))]">
                这是<b>流式</b>通道：识别结果边说边出，定稿后才作为问题提交。
                音频会上传到阿里云。模型与价格见阿里云百炼控制台。
              </div>
            </>
          ) : asr.kind === 'whisper-server' ? (
            <>
              <Field label="服务地址" hint="whisper-server 默认监听 127.0.0.1:8178">
                <Input
                  value={asr.serverUrl}
                  onChange={(e) => void onPatch({ asr: { serverUrl: e.target.value } })}
                  placeholder="http://127.0.0.1:8178"
                />
              </Field>
              <Field label="模型文件路径" hint="自动启动服务时用；已手动启动服务则可留空">
                <Input
                  value={asr.modelPath}
                  onChange={(e) => void onPatch({ asr: { modelPath: e.target.value } })}
                  placeholder="/Users/you/models/ggml-small.bin"
                />
              </Field>
              <Field label="whisper-server 路径" hint="留空则用 PATH 里的 whisper-server">
                <Input
                  value={asr.serverBinaryPath}
                  onChange={(e) => void onPatch({ asr: { serverBinaryPath: e.target.value } })}
                  placeholder="/opt/homebrew/bin/whisper-server"
                />
              </Field>
              <div className="col-span-2">
                <Switch
                  checked={asr.autoStartServer}
                  onChange={(v) => void onPatch({ asr: { autoStartServer: v } })}
                  label="应用启动时自动拉起服务"
                  hint="退出应用时会关掉由应用拉起的服务；你手动启动的实例不受影响。模型加载需要几秒，启动期完成可避免第一次说话时等待。"
                />
              </div>
              <div className="col-span-2 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2)/0.5)] px-3 py-2 text-[12px] text-[rgb(var(--ss-muted))]">
                安装：<span className="font-mono">brew install whisper-cpp</span>
                <br />
                模型下载：
                <span className="font-mono">
                  curl -L -o ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
                </span>
                <br />
                small 约 465MB，识别约 6 倍实时（6 秒音频约 1 秒出文字）。
              </div>
            </>
          ) : asr.kind === 'openai-compat' ? (
            <>
              <Field label="识别网关地址" hint="可填 https://api.openai.com/v1 或本地 faster-whisper-server">
                <Input value={asr.baseUrl} onChange={(e) => void onPatch({ asr: { baseUrl: e.target.value } })} placeholder="https://api.openai.com/v1" />
              </Field>
              <Field label="识别模型">
                <Input value={asr.model} onChange={(e) => void onPatch({ asr: { model: e.target.value } })} placeholder="whisper-1" />
              </Field>
              <Field label="API Key" className="col-span-2">
                <Input type="password" value={asr.apiKey} onChange={(e) => void onPatch({ asr: { apiKey: e.target.value } })} />
              </Field>
            </>
          ) : (
            <>
              <Field label="whisper-cli 路径" hint="brew install whisper-cpp 后用 which whisper-cli 查询">
                <Input value={asr.binaryPath} onChange={(e) => void onPatch({ asr: { binaryPath: e.target.value } })} placeholder="/opt/homebrew/bin/whisper-cli" />
              </Field>
              <Field label="模型文件路径" hint="下载 ggml-medium.bin 后填写绝对路径">
                <Input value={asr.modelPath} onChange={(e) => void onPatch({ asr: { modelPath: e.target.value } })} placeholder="/Users/you/models/ggml-medium.bin" />
              </Field>
            </>
          )}

          <div className="col-span-2">
            <Button
              onClick={async () => {
                setResult('测试中…')
                const res = await api.gateway.testAsr(asr)
                setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`)
              }}
            >
              测试语音识别
            </Button>
            {result && <div className="mt-2 text-[12px] text-[rgb(var(--ss-muted))]">{result}</div>}
          </div>
        </div>
      </Card>

      <Card title="采音设置">
        <div className="space-y-3">
          <Switch checked={audio.micEnabled} onChange={(v) => void onPatch({ audio: { micEnabled: v } })} label="麦克风" hint="适合线下/面对面场景，采集你自己的声音。" />
          <Switch
            checked={audio.systemAudioEnabled}
            onChange={(v) => void onPatch({ audio: { systemAudioEnabled: v } })}
            label="电脑音频"
            hint="适合视频会议/面试，直接采集会议软件里对方的声音。需要「屏幕录制」权限。"
          />
          {/*
            为什么要有这个按钮：电脑音频「有帧但音量恒为 0」是这条链路最常见的失效形态，
            界面上完全看不出来。点一下会真的拉起采集组件等它就绪，能当场分辨
            「没授权」还是「采集组件本身有问题」，不必等到开会才发现没声音。
          */}
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              onClick={async () => {
                setSystemAudioResult('检测中…')
                try {
                  const res = await (
                    window.api as unknown as {
                      systemAudio: { checkAccess: () => Promise<{ ok: boolean; error?: string }> }
                    }
                  ).systemAudio.checkAccess()
                  setSystemAudioResult(res.ok ? '✅ 电脑音频采集可用' : `❌ ${describeAudioError(res.error)}`)
                } catch (error) {
                  setSystemAudioResult(`❌ ${error instanceof Error ? error.message : String(error)}`)
                }
              }}
            >
              检测电脑音频
            </Button>
            {systemAudioResult && (
              <div className="min-w-0 flex-1 text-[12px] text-[rgb(var(--ss-muted))]">{systemAudioResult}</div>
            )}
          </div>
        </div>
      </Card>

      <Card title="转写调参">
        <div className="grid grid-cols-3 gap-4">
          <Field label="静音判定 (ms)" hint="停顿多久算说完一句">
            <Input type="number" value={asrTuning.silenceMs} onChange={(e) => void onPatch({ asrTuning: { silenceMs: Number(e.target.value) } })} />
          </Field>
          <Field label="片段上限 (ms)">
            <Input type="number" value={asrTuning.maxSegmentMs} onChange={(e) => void onPatch({ asrTuning: { maxSegmentMs: Number(e.target.value) } })} />
          </Field>
          <Field label="片段下限 (ms)" hint="过滤噪声碎片">
            <Input type="number" value={asrTuning.minSegmentMs} onChange={(e) => void onPatch({ asrTuning: { minSegmentMs: Number(e.target.value) } })} />
          </Field>
          <Field label="热词（逗号分隔）" className="col-span-3" hint="提升专有名词识别率，如公司名、技术栈">
            <Input
              value={asrTuning.hotwords.join(',')}
              onChange={(e) => void onPatch({ asrTuning: { hotwords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
              placeholder="Kubernetes, 中台, 埋点"
            />
          </Field>
          <div className="col-span-3 space-y-3">
            <Switch
              checked={asrTuning.autoAnswer}
              onChange={(v) => void onPatch({ asrTuning: { autoAnswer: v } })}
              label="自动出答案"
              hint="识别到完整问题后自动请求模型；关闭后可手动触发。"
            />
            <Field label="自动出答案的最少字数">
              <Input
                type="number"
                value={asrTuning.autoAnswerMinChars}
                onChange={(e) => void onPatch({ asrTuning: { autoAnswerMinChars: Number(e.target.value) } })}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="转写模式">
        <div className="space-y-4">
          <Switch
            checked={asrTuning.cumulative}
            onChange={(v) => void onPatch({ asrTuning: { cumulative: v } })}
            label="累积转写"
            hint="开启后语音累计成一条，点击气泡才发送给 AI；关闭则识别到完整问题就自动作答。"
          />
          <Field
            label="无人发言自动停止采集（秒）"
            hint="0 = 不自动停止。达到该时长后停止声音录入，会话保留，可随时点「继续采集」恢复。"
          >
            <Input
              type="number"
              min="0"
              value={asrTuning.silenceAutoStopSec}
              onChange={(e) => void onPatch({ asrTuning: { silenceAutoStopSec: Number(e.target.value) } })}
            />
          </Field>
        </div>
      </Card>
    </div>
  )
}


/**
 * 模式（会议/笔试/面试预设）。
 *
 * 对齐原版：一个模式就是「一整套会话行为」——音频来源、答题风格、悬浮窗透明度等。
 * 切换模式会把这些参数整体套用，因此这里每个模式卡片都显示它的关键参数。
 */
function ModesSection({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: PatchFn
}): React.ReactElement {
  const { modes, activeModeId } = settings
  const [busy, setBusy] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [error, setError] = React.useState('')

  const active = modes.find((m) => m.id === activeModeId) ?? modes[0]

  const update = (id: string, patch: Partial<Mode>): void => {
    void onPatch({ modes: modes.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m)) })
  }

  const activate = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      const res = await api.modes.activate(id)
      if (!res.ok) setError(res.error ?? '切换失败')
      else setHint(`已切换到「${res.data?.name ?? ''}」，相关参数已套用`)
    } finally {
      setBusy('')
    }
  }

  const TYPE_LABEL: Record<Mode['type'], string> = { meeting: '会议', quiz: '笔试', interview: '面试' }
  const SPEED_LABEL: Record<Mode['responseSpeed'], string> = { fast: '快速', balanced: '均衡', slow: '深思' }
  const SOURCE_LABEL: Record<Mode['audioSource'], string> = { mic: '麦克风', system: '电脑音频', both: '两者' }

  return (
    <div className="max-w-4xl space-y-4">
      <Card
        title="模式"
        extra={
          <Button
            size="sm"
            onClick={() => {
              const id = `mode-${Date.now().toString(36)}`
              void onPatch({
                modes: [
                  ...modes,
                  {
                    ...active,
                    id,
                    name: '新模式',
                    defaultKey: undefined,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                  }
                ]
              })
            }}
          >
            新建模式
          </Button>
        }
      >
        <div className="ss-list-count">
          一个模式就是一整套会话行为：音频来源、答题风格、悬浮窗透明度等。切换模式会整体套用这些参数。
          悬浮窗里可以用 ‹ › 快速切换到上一个/下一个角色。
        </div>

        <div className="mt-3 space-y-3">
          {modes.map((mode) => {
            const isActive = mode.id === activeModeId
            return (
              <div
                key={mode.id}
                className={cx(
                  'rounded-lg border p-3 transition-colors',
                  isActive
                    ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary)/0.08)]'
                    : 'border-[rgb(var(--ss-border))]'
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={isActive ? 'accent' : 'muted'}>{TYPE_LABEL[mode.type]}</Badge>
                  <Input
                    value={mode.name}
                    onChange={(e) => update(mode.id, { name: e.target.value })}
                    className="w-48"
                  />
                  {mode.defaultKey && <Badge tone="muted">系统预置</Badge>}
                  {isActive ? (
                    <Badge tone="ok">当前使用</Badge>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy === mode.id} onClick={() => void activate(mode.id)}>
                      {busy === mode.id ? '切换中…' : '使用此模式'}
                    </Button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {!mode.defaultKey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const res = await api.modes.remove(mode.id)
                          if (!res.ok) setError(res.error ?? '删除失败')
                        }}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="音频来源">
                    <Select
                      value={mode.audioSource}
                      onChange={(e) => update(mode.id, { audioSource: e.target.value as Mode['audioSource'] })}
                    >
                      <option value="mic">麦克风</option>
                      <option value="system">电脑音频</option>
                      <option value="both">两者</option>
                    </Select>
                  </Field>
                  <Field label="回答长度">
                    <Select
                      value={mode.responseSpeed}
                      onChange={(e) => update(mode.id, { responseSpeed: e.target.value as Mode['responseSpeed'] })}
                    >
                      <option value="fast">快速（约 1024 token）</option>
                      <option value="balanced">均衡（约 2048 token）</option>
                      <option value="slow">深思（约 4096 token）</option>
                    </Select>
                  </Field>
                  <Field label="结论格式">
                    <Select
                      value={mode.answerStyle}
                      onChange={(e) => update(mode.id, { answerStyle: e.target.value as Mode['answerStyle'] })}
                    >
                      <option value="concise">精简</option>
                      <option value="detailed">全面</option>
                    </Select>
                  </Field>
                  <Field label={`悬浮窗透明度：${mode.overlayOpacity}%`}>
                    <input
                      type="range"
                      min="20"
                      max="100"
                      value={mode.overlayOpacity}
                      onChange={(e) => update(mode.id, { overlayOpacity: Number(e.target.value) })}
                      className="w-full"
                    />
                  </Field>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="静音断句（毫秒）" hint="越小越灵敏">
                    <Input
                      type="number"
                      value={mode.aliyunMaxSentenceSilenceMs}
                      onChange={(e) => update(mode.id, { aliyunMaxSentenceSilenceMs: Number(e.target.value) })}
                    />
                  </Field>
                  <div className="flex items-end pb-1">
                    <Switch
                      checked={mode.autoAnswer}
                      onChange={(v) => update(mode.id, { autoAnswer: v })}
                      label="自动出答案"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <Switch
                      checked={mode.excludeSelfVoice}
                      onChange={(v) => update(mode.id, { excludeSelfVoice: v })}
                      label="排除自己的声音"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <Switch
                      checked={mode.autoHideMain}
                      onChange={(v) => update(mode.id, { autoHideMain: v })}
                      label="自动隐藏主窗口"
                    />
                  </div>
                </div>

                {mode.type === 'quiz' && mode.quizConfig && (
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="截屏快捷键">
                      <Input value={mode.quizConfig.shortcut} readOnly className="font-mono text-[12px]" />
                    </Field>
                    <Field label={`截图质量：${mode.quizConfig.jpegQuality}`}>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={mode.quizConfig.jpegQuality}
                        onChange={(e) =>
                          update(mode.id, {
                            quizConfig: { ...mode.quizConfig!, jpegQuality: Number(e.target.value) }
                          })
                        }
                        className="w-full"
                      />
                    </Field>
                    <div className="flex items-end pb-1">
                      <Switch
                        checked={mode.quizConfig.useMediaKey}
                        onChange={(v) => update(mode.id, { quizConfig: { ...mode.quizConfig!, useMediaKey: v } })}
                        label="媒体键触发"
                      />
                    </div>
                  </div>
                )}

                {mode.type === 'quiz' && mode.quizConfig && (
                  <Field
                    label="笔试提示词（可选）"
                    hint="原版：如有 ACM 模式/编程语言要求，请在创建模式时的笔试提示词中添加"
                  >
                    <Textarea
                      rows={2}
                      value={mode.quizConfig.systemPrompt}
                      onChange={(e) => update(mode.id, { quizConfig: { ...mode.quizConfig!, systemPrompt: e.target.value } })}
                    />
                  </Field>
                )}

                <div className="mt-2 text-[11px] text-[rgb(var(--ss-faint))]">
                  {SOURCE_LABEL[mode.audioSource]} · {SPEED_LABEL[mode.responseSpeed]} ·{' '}
                  {mode.speechLanguage} · 音量 {mode.volume}
                </div>
              </div>
            )
          })}
        </div>

        {hint && <div className="mt-3 text-[12px] text-[rgb(var(--ss-muted))]">{hint}</div>}
        {error && <div className="mt-3 text-[12px] text-[rgb(var(--ss-danger))]">{error}</div>}
      </Card>
    </div>
  )
}

/** 题目翻译 + 声纹过滤 */
function AssistSection({ settings, onPatch }: { settings: Settings; onPatch: PatchFn }): React.ReactElement {
  const { translate, voiceprint } = settings
  const [status, setStatus] = React.useState('')
  const [enrolling, setEnrolling] = React.useState(false)

  /* 读取当前是否已录入 */
  React.useEffect(() => {
    void api.voiceprint.status().then((st) => {
      if (st.enrolled) setStatus(`已录入（${st.samples} 段音频）`)
    })
  }, [])

  const TARGETS = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: '英语' },
    { value: 'ja', label: '日语' },
    { value: 'ko', label: '韩语' },
    { value: 'fr', label: '法语' },
    { value: 'de', label: '德语' },
    { value: 'ru', label: '俄语' }
  ]

  return (
    <div className="max-w-3xl space-y-4">
      <Card title="题目翻译">
        <div className="space-y-4">
          <Switch
            checked={translate.enabled}
            onChange={(v) => void onPatch({ translate: { enabled: v } })}
            label="显示题目翻译"
            hint="仅翻译题目用于展示，AI 仍使用原题作答，回答语言不变。"
          />
          {translate.enabled && (
            <Field label="目标语言">
              <Select value={translate.target} onChange={(e) => void onPatch({ translate: { target: e.target.value } })}>
                {TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="ss-list-count">
            翻译会额外消耗一次模型调用；翻译失败不影响作答，只是不显示译文。
          </div>
        </div>
      </Card>

      {/*
        声纹过滤已按用户要求停用（"声纹不用了"）。
        代码与后端能力保留，将来想启用只需去掉这段注释。
        停用前已确认 voiceprint.enabled 为 false，不影响识别主链路。
      */}
      {false && (
      <Card title="声纹过滤">
        <div className="space-y-4">
          <Switch
            checked={voiceprint.enabled}
            onChange={(v) => void onPatch({ voiceprint: { enabled: v } })}
            label="过滤自己的声音"
            hint="开启后识别出是你自己在说话就不作为提问来源，避免 AI 去回答你自己的话。"
          />
          <Switch
            checked={voiceprint.keepInContext}
            onChange={(v) => void onPatch({ voiceprint: { keepInContext: v } })}
            label="保留在上下文中"
            hint="原版行为：自己的发言仍作为上下文，只是不触发作答。"
          />
          <Field label={`相似度阈值：${voiceprint.threshold.toFixed(2)}`} hint="越高越严格；太高会漏判（自己的话被当成问题）">
            <input
              type="range"
              min="0.5"
              max="0.95"
              step="0.01"
              value={voiceprint.threshold}
              onChange={(e) => void onPatch({ voiceprint: { threshold: Number(e.target.value) } })}
              className="w-full"
            />
          </Field>

          <div className="rounded-lg border border-[rgb(var(--ss-border))] p-3">
            <div className="mb-2 text-[12px] font-medium">声纹录入</div>
            <div className="ss-list-count mb-2">
              录入需要你在几秒内正常说话；录入后即可用于过滤。当前为轻量声纹（MFCC 统计），
              对同一麦克风下的区分较好，换设备或环境噪声大时准确率会下降。
            </div>
            <Button
              disabled={enrolling}
              onClick={async () => {
                setEnrolling(true)
                setStatus('正在采集…请用正常语速连续说话约 6 秒')
                const capture = new AudioCapture()
                const chunks: ArrayBuffer[] = []
                let frames = 0
                capture.onFrame((pcm) => {
                  // 每 3 帧（约 0.75 秒）作为一段提交，避免单段过长
                  frames += 1
                  if (frames % 3 === 0) chunks.push(pcm.buffer.slice(0) as ArrayBuffer)
                })
                capture.onError((scope, message) => setStatus(`[${scope}] ${message}`))
                try {
                  await capture.start({ mic: true, system: false, micDeviceId: settings.audio.micDeviceId || undefined })
                  await new Promise((resolve) => setTimeout(resolve, 6000))
                  await capture.stop()
                  if (!chunks.length) {
                    setStatus('没有采集到音频，请检查麦克风权限后重试')
                    return
                  }
                  setStatus(`已采集 ${chunks.length} 段，正在生成声纹…`)
                  const result = await api.voiceprint.enroll(chunks)
                  if (result.ok && result.data) {
                    setStatus(`已录入（用了 ${result.data.samples} 段音频）`)
                  } else {
                    setStatus(result.error ?? '录入失败')
                  }
                } catch (e) {
                  setStatus(`录入失败：${e instanceof Error ? e.message : String(e)}`)
                } finally {
                  setEnrolling(false)
                }
              }}
            >
              {enrolling ? '录入中…' : '开始录入'}
            </Button>
            {status && <div className="mt-2 text-[12px] text-[rgb(var(--ss-muted))]">{status}</div>}
            {status.includes('已录入') && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={async () => {
                  await api.voiceprint.reset()
                  setStatus('已清除声纹')
                }}
              >
                清除声纹
              </Button>
            )}
          </div>
        </div>
      </Card>
      )}
    </div>
  )
}

function StealthSection({ settings, onPatch }: { settings: Settings; onPatch: PatchFn }): React.ReactElement {
  const { stealth, ui } = settings
  const { zoom, setZoom, reset: resetZoom } = useZoom()
  const [guard, setGuard] = React.useState<GuardStatus | null>(null)
  const [guardSupport, setGuardSupport] = React.useState<GuardSupport | null>(null)
  const [guardSide, setGuardSide] = React.useState<GuardSide>('right')
  const [guardMsg, setGuardMsg] = React.useState('')
  const [guardBusy, setGuardBusy] = React.useState(false)

  /* 只在打开这一页时探测一次（getSupport 同步且最坏阻塞 1.5s） */
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const status = await api.guard.status()
      if (cancelled) return
      setGuard(status)
      setGuardSupport(status.support)
      setGuardSide(status.side)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshGuard = async (): Promise<void> => {
    const status = await api.guard.status()
    setGuard(status)
    setGuardSupport(status.support)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card title="防录屏与安全">
        <div className="space-y-4">
          <Switch
            checked={stealth.contentProtection}
            onChange={(v) => void onPatch({ stealth: { contentProtection: v } })}
            label="防录屏保护"
            hint="让本应用窗口从录屏/截屏中隐藏，避免内容被旁人看到。"
          />
          <Switch
            checked={stealth.safeMode}
            onChange={(v) => void onPatch({ stealth: { safeMode: v } })}
            label="安全模式"
            hint="检测到录屏/屏幕共享软件时，自动隐藏悬浮窗并告警。检测基于进程名启发式判断，可能漏报。"
          />
          <Switch
            checked={stealth.releaseFocus}
            onChange={(v) => void onPatch({ stealth: { releaseFocus: v } })}
            label="放弃焦点"
            hint="悬浮窗不抢键盘焦点，减少切换窗口被察觉的风险。开启后悬浮窗内输入框可能无法输入。"
          />
          <Switch
            checked={stealth.clickThrough}
            onChange={(v) => void onPatch({ stealth: { clickThrough: v } })}
            label="鼠标穿透"
            hint="开启后悬浮窗不响应鼠标（需在悬浮窗内关闭）。"
          />
        </div>
      </Card>

      <Card title="外观">
        <div className="space-y-4">
          <Field label={`悬浮窗不透明度：${Math.round(ui.opacity * 100)}%`}>
            <input
              type="range"
              min="0.2"
              max="1"
              step="0.02"
              value={ui.opacity}
              onChange={(e) => void onPatch({ ui: { opacity: Number(e.target.value) } })}
              className="w-full"
            />
          </Field>
          <Field
            label={`界面等比缩放：${Math.round(zoom * 100)}%`}
            hint="文字、图标、间距一起按比例缩放（⌘/Ctrl + = 放大、- 缩小、0 复位）。每个窗口独立记忆。"
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0.5"
                max="2.5"
                step="0.05"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1"
              />
              <Button size="sm" onClick={resetZoom}>
                复位
              </Button>
            </div>
          </Field>
          <Field label="主题">
            <Select
              value={ui.theme}
              onChange={(e) => {
                const theme = e.target.value
                document.documentElement.dataset.theme = theme
                localStorage.setItem('app-theme', theme)
                void onPatch({ ui: { theme: theme as never } })
              }}
            >
              <option value="warm">默认（浅色）</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="悬浮条与光标">
        <div className="space-y-4">
          <Switch
            checked={stealth.autoCollapse}
            onChange={(v) => void onPatch({ stealth: { autoCollapse: v } })}
            label="自动收起标题栏（悬停显隐）"
            hint="开启后，鼠标移开悬浮窗时自动收起标题栏与底部工具条，仅保留内容区；鼠标移入即展开。"
          />
          <Switch
            checked={stealth.hideCursor}
            onChange={(v) => void onPatch({ stealth: { hideCursor: v } })}
            label="隐藏鼠标"
            hint="在共享画面中隐藏真实鼠标。本机仍显示替代光标，所以不会失去鼠标位置感。"
          />
          <Switch
            checked={stealth.rememberSafeMode}
            onChange={(v) => void onPatch({ stealth: { rememberSafeMode: v } })}
            label="记住安全模式"
            hint="每次启动应用时自动开启安全模式。"
          />
          <div className="ss-list-count">
            安全模式开启时会强制开启「不抢焦点」、强制防录屏，并强制隐藏悬浮窗（原版语义）。
          </div>
        </div>
      </Card>

      <Card title="键盘防护与安全输入">
        <div className="space-y-4">
          <div className="ss-list-count">
            用原生事件拦截吞掉指定一侧的 Command 事件，使其他程序（键盘记录器）观察不到你在这台机器上的按键。
          </div>

          {guardSupport && !guardSupport.ok && (
            <div className="rounded-lg border border-[rgb(var(--ss-warning)/0.5)] bg-[rgb(var(--ss-warning)/0.1)] px-3 py-2 text-[12px]">
              {guardSupport.reason ?? '当前系统暂不支持键盘防护'}
            </div>
          )}

          {guardSupport?.ok && (
            <>
              <Field label="保护哪一侧 Command">
                <Select
                  value={guardSide}
                  disabled={guard?.enabled}
                  onChange={(e) => setGuardSide(e.target.value as GuardSide)}
                >
                  <option value="right">右侧 Command（推荐）</option>
                  <option value="left">左侧 Command</option>
                  <option value="both">两侧（会让两侧快捷键全部失效）</option>
                </Select>
              </Field>
              <div className="ss-list-count">
                所选一侧的复制、粘贴等系统快捷键会在**其他应用中一并失效**，因此建议只开一侧。
              </div>

              <div className="flex items-center gap-2">
                {guard?.enabled ? (
                  <Button
                    disabled={guardBusy}
                    onClick={async () => {
                      setGuardBusy(true)
                      try {
                        setGuard(await api.guard.disable())
                        setGuardMsg('键盘防护已关闭')
                      } finally {
                        setGuardBusy(false)
                      }
                    }}
                  >
                    关闭键盘防护
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={guardBusy}
                    onClick={async () => {
                      setGuardBusy(true)
                      try {
                        const result = await api.guard.enable(guardSide)
                        setGuard(result.status)
                        setGuardMsg(result.message)
                      } finally {
                        setGuardBusy(false)
                      }
                    }}
                  >
                    启用键盘防护
                  </Button>
                )}
                <Badge tone={guard?.enabled ? 'ok' : 'muted'}>{guard?.enabled ? '已生效' : '未启用'}</Badge>
                <Badge tone={guardSupport.hasAccessibility ? 'ok' : 'warn'}>
                  辅助功能{guardSupport.hasAccessibility ? '已授权' : '未授权'}
                </Badge>
                {!guardSupport.hasAccessibility && (
                  <Button size="sm" variant="ghost" onClick={() => void api.device.openSystemSettings('accessibility')}>
                    去授权
                  </Button>
                )}
              </div>
            </>
          )}

          <div className="border-t border-[rgb(var(--ss-border))] pt-4">
            <div className="mb-2 text-[13px] font-medium">安全输入</div>
            <div className="ss-list-count mb-3">
              开启后系统会阻止其它程序读取键盘事件；期间第三方中文输入法可能不可用。
              关闭的正确方式是停止本应用的常驻拦截进程（下面的关闭按钮会一并处理）。
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={guardBusy}
                onClick={async () => {
                  setGuardBusy(true)
                  try {
                    const next = !guard?.secureInput
                    const result = await api.guard.setSecureInput(next)
                    setGuard(result.status)
                    setGuardMsg(result.message)
                  } finally {
                    setGuardBusy(false)
                  }
                }}
              >
                {guard?.secureInput ? '关闭安全输入' : '点击开始安全输入'}
              </Button>
              <Badge tone={guard?.secureInput ? 'ok' : 'muted'}>
                {guard?.secureInput ? '安全输入中…' : '未开启'}
              </Badge>
            </div>
          </div>

          {guardMsg && <div className="text-[12px] text-[rgb(var(--ss-muted))]">{guardMsg}</div>}
          {guardBusy && <div className="ss-list-count">处理中…</div>}
          <div className="ss-list-count">
            说明：键盘防护能拦截系统层的事件监听，但挡不住 USB 硬件记录器或内核级驱动。
          </div>
        </div>
      </Card>
    </div>
  )
}

/** 把键盘事件转成 Electron Accelerator */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Meta', 'Alt', 'Shift', 'CapsLock'].includes(key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let name = key
  if (key === ' ') name = 'Space'
  else if (key.length === 1) name = key.toUpperCase()
  else if (key.startsWith('Arrow')) name = key.slice(5)
  parts.push(name)
  return parts.join('+')
}

function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }): React.ReactElement {
  const [recording, setRecording] = React.useState(false)
  return (
    <button
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.currentTarget.blur()
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          onChange('')
          return
        }
        const acc = toAccelerator(e)
        if (acc) {
          e.preventDefault()
          onChange(acc)
          e.currentTarget.blur()
        }
      }}
      className={cx(
        'h-9 w-full rounded-lg border px-3 text-left font-mono text-[12px] transition-colors ss-no-drag',
        recording
          ? 'border-[rgb(var(--ss-accent))] bg-[rgb(var(--ss-2))]'
          : 'border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))]'
      )}
    >
      {recording ? '请按下组合键…（Esc 取消 / 退格清除）' : value || '未设置'}
    </button>
  )
}

function HotkeySection({ settings, onPatch }: { settings: Settings; onPatch: PatchFn }): React.ReactElement {
  const hk = settings.hotkeys
  const items: Array<{ key: keyof typeof hk; label: string; hint: string }> = [
    { key: 'toggleFloating', label: '显示 / 隐藏悬浮窗', hint: '原版默认 ⌘⇧空格' },
    { key: 'answerNow', label: '立即回答当前问题', hint: '无需等待静音判定' },
    { key: 'screenshot', label: '截图识题', hint: '原版默认 ⌘⇧Q；直接截整屏，不弹选区' },
    {
      key: 'toggleClickThrough',
      label: '开启 / 关闭鼠标穿透',
      hint: '留空则使用内置兜底键 ⌘⇧9——穿透开启后窗口不响应鼠标，必须有键能关掉它'
    },
    { key: 'toggleHoverReveal', label: '开启 / 关闭悬停显隐', hint: '鼠标移开时整个悬浮窗淡出' },
    { key: 'clearSession', label: '清空当前会话', hint: '不会删除已保存的记录' }
  ]
  return (
    <div className="max-w-2xl space-y-4">
      <Card title="全局快捷键">
        <div className="space-y-4">
          {items.map((item) => (
            <Field key={item.key} label={item.label} hint={item.hint}>
              <HotkeyRecorder value={hk[item.key]} onChange={(v) => void onPatch({ hotkeys: { [item.key]: v } })} />
            </Field>
          ))}
          <div className="rounded-lg border border-[rgb(var(--ss-warning)/0.4)] bg-[rgb(var(--ss-warning)/0.08)] px-3 py-2 text-[12px]">
            鼠标穿透开启后，悬浮窗不再响应鼠标。此时按「开启 / 关闭鼠标穿透」的快捷键即可解除；
            未配置该快捷键时会自动使用内置的 <span className="font-mono font-semibold">⌘⇧9</span>。
          </div>
          <div className="ss-list-count">
            使用 Electron Accelerator 格式，支持 CommandOrControl / Alt / Shift 组合。修改后立即生效；若被系统或其他软件占用，会在悬浮窗内提示。
          </div>
        </div>
      </Card>
    </div>
  )
}

function AboutSection(): React.ReactElement {
  const [info, setInfo] = React.useState<{ version: string; electron: string; platform: string; dataDir: string } | null>(null)
  const [perm, setPerm] = React.useState<{ microphone: string; screen: string; accessibility: string } | null>(null)

  React.useEffect(() => {
    void api.app.info().then(setInfo)
    void api.device.getPermissions().then(setPerm)
  }, [])

  const permLabel: Record<string, string> = {
    granted: '已授权',
    denied: '已拒绝',
    'not-determined': '未申请',
    unknown: '未知'
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card title="关于">
        <div className="space-y-2 text-[13px]">
          <div>AI 面试助手 · 模型网关可配置</div>
          <div className="ss-list-count">版本 {info?.version ?? '…'} · Electron {info?.electron ?? '…'} · {info?.platform ?? ''}</div>
          <div className="ss-list-count break-all">数据目录：{info?.dataDir ?? '…'}</div>
          <div className="pt-2">
            <Button onClick={() => void api.app.openDataDir()}>打开数据目录</Button>
          </div>
        </div>
      </Card>

      <Card title="系统权限">
        <div className="space-y-2">
          {perm ? (
            (['microphone', 'screen', 'accessibility'] as const).map((kind) => (
              <div key={kind} className="flex items-center gap-3">
                <span className="flex-1 text-[13px]">
                  {kind === 'microphone' ? '麦克风' : kind === 'screen' ? '屏幕录制' : '辅助功能'}
                </span>
                <Badge tone={perm[kind] === 'granted' ? 'ok' : perm[kind] === 'denied' ? 'danger' : 'warn'}>
                  {permLabel[perm[kind]] ?? perm[kind]}
                </Badge>
                <Button size="sm" onClick={() => void api.device.openSystemSettings(kind)}>
                  打开系统设置
                </Button>
              </div>
            ))
          ) : (
            <div className="ss-list-count">读取中…</div>
          )}
        </div>
      </Card>
    </div>
  )
}
