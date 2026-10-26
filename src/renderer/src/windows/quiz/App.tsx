import React from 'react'
import { Badge, Button, Card, Empty, Field, Input, Markdown, Select, Textarea, ThinkBlock, cx } from '@renderer/ui'
import { stitchImages, type RasterImage } from '@shared/stitch'
import {
  buildQuizMessages,
  buildVerifyMessages,
  defaultQuizConfig,
  LANGUAGE_OPTIONS,
  parseVerifyResult,
  type VerifyResult
} from './quiz-prompt'
import type { ChatDelta, QuizAttachment, QuizConfig, QuizJob, QuizTestCase } from '@shared/types'
import type { QuizWindowApi } from '@shared/ipc'

/**
 * 笔试 / 截图解题窗口。
 *
 * 采集方式：选区截图 / 整屏 / 批量 / 长截图（自动识别重叠后纵向拼接）/ 读剪贴板。
 * 对齐原版语义：答题模式（ACM/核心）、结论格式（全面/精简）、编程语言、
 * 测试样例与判题自检、「排队中——前一题解题完成后自动开始」。
 */

const api = window.api as unknown as QuizWindowApi
const STORAGE_KEY = 'quiz-config'

function loadConfig(): QuizConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaultQuizConfig(), ...(JSON.parse(raw) as Partial<QuizConfig>) }
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return defaultQuizConfig()
}

/* ------------------------------------------------------------------ *
 * 画布工具：dataURL ↔ RGBA 缓冲（拼接算法在 @shared/stitch）
 * ------------------------------------------------------------------ */

async function dataUrlToRaster(dataUrl: string): Promise<RasterImage> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { width: data.width, height: data.height, data: data.data }
}

function rasterToDataUrl(raster: RasterImage): string {
  const canvas = document.createElement('canvas')
  canvas.width = raster.width
  canvas.height = raster.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  // 用 createImageData 而不是 new ImageData(...)：避免 Uint8ClampedArray 缓冲类型不匹配
  const imageData = ctx.createImageData(raster.width, raster.height)
  imageData.data.set(raster.data)
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

export default function App(): React.ReactElement {
  const [config, setConfig] = React.useState<QuizConfig>(loadConfig)
  const [attachments, setAttachments] = React.useState<QuizAttachment[]>([])
  const [note, setNote] = React.useState('')
  const [jobs, setJobs] = React.useState<QuizJob[]>([])
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [longMode, setLongMode] = React.useState(false)
  const [batchMode, setBatchMode] = React.useState(false)
  const [stitching, setStitching] = React.useState(false)

  const [testCases, setTestCases] = React.useState<QuizTestCase[]>([])
  const [verify, setVerify] = React.useState<VerifyResult | null>(null)
  const [verifying, setVerifying] = React.useState(false)

  const answerRef = React.useRef<HTMLDivElement>(null)
  /** 供流式回调读取最新任务队列，避免闭包读到旧值 */
  const jobsRef = React.useRef<QuizJob[]>([])
  jobsRef.current = jobs
  const configRef = React.useRef(config)
  configRef.current = config
  const casesRef = React.useRef(testCases)
  casesRef.current = testCases

  const patchConfig = (next: Partial<QuizConfig>): void => {
    const merged = { ...config, ...next }
    setConfig(merged)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    } catch {
      /* 忽略 */
    }
  }

  const activeJob = jobs.find((j) => j.id === activeJobId) ?? null
  const running = jobs.some((j) => j.status === 'running')
  const queuedCount = jobs.filter((j) => j.status === 'queued').length

  /* ---------------- 流式事件 ---------------- */

  React.useEffect(() => {
    const appendToRunning = (field: 'answer' | 'reasoning', text: string): void => {
      setJobs((prev) => {
        const index = prev.findIndex((j) => j.status === 'running')
        if (index < 0) return prev
        const next = [...prev]
        next[index] = { ...next[index], [field]: next[index][field] + text }
        return next
      })
    }

    const offs = [
      api.capture.onDone((dataUrl) => addAttachment(dataUrl)),
      api.capture.onAnswerDelta((_reqId, delta: ChatDelta) => {
        appendToRunning(delta.kind === 'content' ? 'answer' : 'reasoning', delta.text)
      }),
      api.capture.onAnswerDone((reqId, text: string, error?: string) => {
        if (error) {
          setError(error)
          // 失败也要把排队中的任务标出来，否则界面会一直显示「排队中」
          setJobs((prev) =>
            prev.map((j) => (j.id === reqId || j.status === 'running' ? { ...j, status: 'failed' as const, error } : j))
          )
          return
        }
        setJobs((prev) => {
          const index = prev.findIndex((j) => j.id === reqId)
          const target = index >= 0 ? prev[index] : prev.find((j) => j.status === 'running')
          if (!target) return prev
          const targetIndex = index >= 0 ? index : prev.findIndex((j) => j.id === target.id)
          const next = [...prev]
          const finished = { ...next[targetIndex] }
          // 流式过程中已累积的正文优先，回调里的 text 作为兜底
          if (text && !finished.answer) finished.answer = text
          finished.status = finished.answer ? 'done' : 'failed'
          if (!finished.answer) finished.error = '题面识别失败，请重试或切换常规模式'
          finished.totalMs = Date.now() - finished.createdAt
          next[targetIndex] = finished
          setActiveJobId(finished.id)
          window.setTimeout(() => void runQueue(), 0)
          return next
        })
      })
    ]
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight })
  }, [activeJob?.answer, activeJob?.reasoning])

  /* ---------------- 任务队列（串行） ---------------- */

  const submitJob = (shots: QuizAttachment[]): void => {
    if (!shots.length) return
    const job: QuizJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      attachments: shots,
      prompt: note,
      status: 'queued',
      answer: '',
      reasoning: '',
      createdAt: Date.now()
    }
    setJobs((prev) => [...prev, job])
    setActiveJobId(job.id)
    setAttachments([])
    setNote('')
    setBatchMode(false)
    setLongMode(false)
    window.setTimeout(() => void runQueue(), 0)
  }

  /** 串行推进：没有正在运行的任务时，取第一个排队任务开始 */
  const runQueue = async (): Promise<void> => {
    const current = jobsRef.current
    if (current.some((j) => j.status === 'running')) return
    const next = current.find((j) => j.status === 'queued')
    if (!next) return

    setJobs((prev) => prev.map((j) => (j.id === next.id ? { ...j, status: 'running' } : j)))
    setActiveJobId(next.id)

    const messages = buildQuizMessages({ config: configRef.current, note: next.prompt, testCases: casesRef.current })
    const textPart = (messages[1].content as Array<{ type: 'text'; text: string }>)[0]
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [textPart]
    for (const shot of next.attachments) {
      parts.push({ type: 'image_url', image_url: { url: shot.dataUrl } })
    }

    const result = await api.chat.streamStart(next.id, [messages[0], { role: 'user', content: parts }]).catch(() => ({
      ok: false as const,
      error: '请求失败'
    }))
    if (!result.ok) {
      setJobs((prev) =>
        prev.map((j) => (j.id === next.id ? { ...j, status: 'failed', error: result.error ?? '请求失败' } : j))
      )
      window.setTimeout(() => void runQueue(), 0)
    }
  }

  /* ---------------- 采集 ---------------- */

  const addAttachment = (dataUrl: string, frames = 1): void => {
    setAttachments((prev) => {
      if (prev.length >= config.maxBatchScreens) {
        setError(`批量截图最多 ${config.maxBatchScreens} 张，请先发送当前批次`)
        return prev
      }
      return [...prev, { id: `att-${Date.now()}-${prev.length}`, dataUrl, index: prev.length + 1, frames }]
    })
  }

  const grabRegion = async (): Promise<void> => {
    setError('')
    const result = await api.capture.start('region')
    if (!result.ok) setError(result.error ?? '截图读取失败')
  }

  const grabOne = async (): Promise<string | null> => {
    const result = await api.capture.grabScreen()
    if (!result.ok || !result.data) {
      setError(result.error ?? '截图读取失败')
      return null
    }
    return result.data
  }

  const finishLongShot = async (): Promise<void> => {
    if (attachments.length < 2) {
      setError('长截图至少需要 2 屏，请滚动页面后再截一次')
      return
    }
    setStitching(true)
    setError('')
    try {
      const rasters: RasterImage[] = []
      for (const shot of attachments) rasters.push(await dataUrlToRaster(shot.dataUrl))
      const result = stitchImages(rasters)
      const dataUrl = rasterToDataUrl(result.image)
      if (!result.allMatched && result.notes.length) setError(result.notes.join('；'))
      else setAttachments([{ id: `att-stitched-${Date.now()}`, dataUrl, index: 1, frames: rasters.length }])
    } catch (e) {
      setError(`拼接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStitching(false)
    }
  }

  const pasteImage = async (): Promise<void> => {
    const dataUrl = await api.capture.readClipboardImage()
    if (!dataUrl) {
      setError('剪贴板里没有图片')
      return
    }
    addAttachment(dataUrl)
  }

  /* ---------------- 测试样例 ---------------- */

  const verifyWithCases = async (): Promise<void> => {
    if (!activeJob?.answer) {
      setError('还没有解答可以用来校验')
      return
    }
    const usable = testCases.filter((c) => c.input.trim() || c.expected.trim())
    if (!usable.length) {
      setError('请至少填写一组测试样例')
      return
    }
    setVerifying(true)
    setVerify(null)
    try {
      const result = await api.chat.complete(buildVerifyMessages(activeJob.answer, usable), { json: true })
      if (!result.ok || !result.data) {
        setError(result.error ?? '样例检查失败')
        return
      }
      setVerify(parseVerifyResult(result.data.text))
    } finally {
      setVerifying(false)
    }
  }

  const exportMarkdown = (): void => {
    if (!activeJob) return
    const lines = [
      '# 笔试解题记录',
      '',
      `- 时间：${new Date(activeJob.createdAt).toLocaleString('zh-CN')}`,
      `- 代码格式：${config.codeMode === 'acm' ? 'ACM（完整 IO）' : '核心（仅函数）'}`,
      `- 结论格式：${config.answerStyle === 'full' ? '全面' : '精简'}`,
      `- 语言：${LANGUAGE_OPTIONS.find((l) => l.value === config.language)?.label ?? config.language}`,
      `- 截图：${activeJob.attachments.length} 屏`,
      '',
      '## 解答',
      '',
      activeJob.answer
    ]
    if (verify) {
      lines.push('', '## 样例检查', '', `结论：${verify.passed ? '通过' : '未通过'} —— ${verify.summary}`)
    }
    // 用系统保存对话框，让用户自己选位置
    void api.app
      .saveFile({
        title: '保存解题记录',
        defaultName: `笔试解题-${new Date(activeJob.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`,
        content: lines.join('\n'),
        extensions: ['md']
      })
      .then((saved) => {
        if (saved) setError('')
      })
      .catch((e: unknown) => setError(`导出失败：${e instanceof Error ? e.message : String(e)}`))
  }

  return (
    <div className="ss-app-shell flex h-full flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">笔试 / 截图解题</span>
        {running && <Badge tone="accent">解题中…</Badge>}
        {queuedCount > 0 && <Badge tone="warn">排队中 {queuedCount}</Badge>}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={() => void grabRegion()}>选区截图</Button>
          <Button
            onClick={async () => {
              setError('')
              const result = await api.capture.start('fullscreen')
              if (!result.ok) setError(result.error ?? '截图读取失败')
            }}
          >
            整屏解题
          </Button>
          <Button onClick={() => void pasteImage()}>读剪贴板</Button>
          <Button
            variant={batchMode ? 'primary' : 'secondary'}
            onClick={() => {
              setBatchMode((v) => !v)
              setLongMode(false)
              setAttachments([])
            }}
          >
            批量截图
          </Button>
          <Button
            variant={longMode ? 'primary' : 'secondary'}
            onClick={() => {
              setLongMode((v) => !v)
              setBatchMode(false)
              setAttachments([])
            }}
          >
            长截图
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.12)] px-3 py-2 text-xs">
          {error}
        </div>
      )}

      {(batchMode || longMode) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2))] px-3 py-2">
          <Badge tone="accent">{longMode ? '长截图' : '批量截图'}</Badge>
          <span className="text-[12px] text-[rgb(var(--ss-muted))]">
            {longMode
              ? '逐屏捕获；滚动页面后再截下一屏，完成后自动识别重叠并拼接。'
              : `最多 ${config.maxBatchScreens} 张，添加完一起提交。`}
          </span>
          <span className="ss-list-count ml-auto">已有 {attachments.length} 屏</span>
          <Button size="sm" disabled={running} onClick={() => void grabOne().then((d) => d && addAttachment(d))}>
            截取下一屏
          </Button>
          {longMode && attachments.length >= 2 && (
            <Button size="sm" variant="primary" disabled={stitching} onClick={() => void finishLongShot()}>
              {stitching ? '拼接中…' : '拼接'}
            </Button>
          )}
          {!longMode && attachments.length > 0 && (
            <Button size="sm" variant="primary" disabled={running} onClick={() => submitJob(attachments)}>
              发送批量截图
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBatchMode(false)
              setLongMode(false)
              setAttachments([])
            }}
          >
            退出
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[380px_1fr] gap-3">
        <div className="min-h-0 space-y-3 overflow-auto">
          <Card title={attachments.length > 1 ? `题目截图（${attachments.length} 屏）` : '题目截图'}>
            {attachments.length === 0 ? (
              <Empty>点上方按钮截图，或读剪贴板图片</Empty>
            ) : (
              <div className="space-y-2">
                {attachments.map((shot) => (
                  <div key={shot.id}>
                    <img src={shot.dataUrl} alt={`第 ${shot.index} 屏`} className="w-full rounded-lg border border-[rgb(var(--ss-border))]" />
                    <div className="mt-1 flex items-center gap-2">
                      <span className="ss-list-count">
                        第 {shot.index} 屏{shot.frames ? `（拼接自 ${shot.frames} 屏）` : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() =>
                          setAttachments((prev) =>
                            prev.filter((a) => a.id !== shot.id).map((a, i) => ({ ...a, index: i + 1 }))
                          )
                        }
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                ))}
                <Button variant="primary" className="w-full" disabled={running} onClick={() => submitJob(attachments)}>
                  {running ? '排队中——前一题解题完成后自动开始' : `提交解题（${attachments.length} 屏）`}
                </Button>
              </div>
            )}
          </Card>

          <Card title="作答设置">
            <div className="space-y-3">
              <Field label="代码格式" hint="ACM＝可直接提交的完整 IO 程序；核心＝只给函数实现">
                <Select value={config.codeMode} onChange={(e) => patchConfig({ codeMode: e.target.value as QuizConfig['codeMode'] })}>
                  <option value="core">核心代码模式（仅函数）</option>
                  <option value="acm">ACM 模式（完整 IO 程序）</option>
                </Select>
              </Field>
              <Field label="结论格式">
                <Select value={config.answerStyle} onChange={(e) => patchConfig({ answerStyle: e.target.value as QuizConfig['answerStyle'] })}>
                  <option value="full">全面版（思路 + 代码 + 复杂度）</option>
                  <option value="concise">精简版（只给代码和复杂度）</option>
                </Select>
              </Field>
              <Field label="编程语言">
                <Select value={config.language} onChange={(e) => patchConfig({ language: e.target.value })}>
                  {LANGUAGE_OPTIONS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="补充说明（可选）" hint="截图看不清时用文字补一句关键信息">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：输入保证升序，n ≤ 1e5" />
              </Field>
            </div>
          </Card>

          <Card
            title={`测试样例（${testCases.length}）`}
            extra={
              <Button size="sm" onClick={() => setTestCases((prev) => [...prev, { id: `case-${Date.now()}`, input: '', expected: '' }])}>
                加样例
              </Button>
            }
          >
            {testCases.length === 0 ? (
              <div className="ss-list-count">填写标准输入与期望输出后，可让模型自检代码是否通过。</div>
            ) : (
              <div className="space-y-3">
                {testCases.map((tc, index) => (
                  <div key={tc.id} className="space-y-1.5 rounded-lg border border-[rgb(var(--ss-border))] p-2">
                    <div className="flex items-center gap-2">
                      <span className="ss-list-count">样例 {index + 1}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setTestCases((prev) => prev.filter((c) => c.id !== tc.id))}
                      >
                        删除
                      </Button>
                    </div>
                    <Input
                      value={tc.input}
                      onChange={(e) => setTestCases((prev) => prev.map((c) => (c.id === tc.id ? { ...c, input: e.target.value } : c)))}
                      placeholder="标准输入"
                      className="font-mono text-[12px]"
                    />
                    <Input
                      value={tc.expected}
                      onChange={(e) => setTestCases((prev) => prev.map((c) => (c.id === tc.id ? { ...c, expected: e.target.value } : c)))}
                      placeholder="期望输出"
                      className="font-mono text-[12px]"
                    />
                  </div>
                ))}
                <Button className="w-full" disabled={verifying || !activeJob?.answer} onClick={() => void verifyWithCases()}>
                  {verifying ? '检查中…' : '用样例检查代码'}
                </Button>
                {!activeJob?.answer && <div className="ss-list-count">先得到一次解答，才能用样例校验。</div>}
              </div>
            )}
          </Card>
        </div>

        <Card
          title={activeJob ? (activeJob.status === 'running' ? '解题中…' : activeJob.status === 'failed' ? '解题失败' : '解答') : '解答'}
          className="flex min-h-0 flex-col"
          extra={
            activeJob && (
              <div className="flex items-center gap-2">
                {activeJob.totalMs ? <span className="ss-list-count">耗时 {Math.round(activeJob.totalMs / 1000)}s</span> : null}
                <Button size="sm" onClick={exportMarkdown}>
                  导出
                </Button>
              </div>
            )
          }
        >
          {jobs.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {jobs.map((job, index) => (
                <button
                  key={job.id}
                  onClick={() => setActiveJobId(job.id)}
                  className={cx(
                    'rounded-full border px-2.5 py-1 text-[11px]',
                    job.id === activeJobId
                      ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))]'
                      : 'border-[rgb(var(--ss-border))] text-[rgb(var(--ss-muted))]'
                  )}
                >
                  第 {index + 1} 题
                  {job.status === 'queued'
                    ? '（排队）'
                    : job.status === 'running'
                      ? '（进行中）'
                      : job.status === 'failed'
                        ? '（失败）'
                        : ''}
                </button>
              ))}
            </div>
          )}

          <div ref={answerRef} className="min-h-0 flex-1 overflow-auto">
            {!activeJob ? (
              <Empty>截图后自动生成解答</Empty>
            ) : (
              <>
                {activeJob.status === 'queued' && (
                  <div className="mb-2 rounded-lg border border-[rgb(var(--ss-warning)/0.5)] bg-[rgb(var(--ss-warning)/0.1)] px-3 py-2 text-[12px]">
                    排队中——前一题解题完成后自动开始，请勿重复截图
                  </div>
                )}
                {activeJob.error && (
                  <div className="mb-2 rounded-lg border border-[rgb(var(--ss-danger)/0.5)] bg-[rgb(var(--ss-danger)/0.12)] px-3 py-2 text-[12px]">
                    {activeJob.error}
                  </div>
                )}
                {activeJob.reasoning && <ThinkBlock text={activeJob.reasoning} streaming={activeJob.status === 'running'} />}
                {activeJob.answer ? (
                  <Markdown>{activeJob.answer}</Markdown>
                ) : (
                  <Empty>{activeJob.status === 'running' ? '正在读题…' : '等待解答'}</Empty>
                )}

                {verify && (
                  <div className="mt-3 rounded-lg border border-[rgb(var(--ss-border))] p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge tone={verify.passed ? 'ok' : 'danger'}>{verify.passed ? '判题通过' : '未通过'}</Badge>
                      <span className="text-[12px]">{verify.summary}</span>
                    </div>
                    {verify.results.length > 0 && (
                      <div className="space-y-1.5">
                        {verify.results.map((r, i) => (
                          <div key={i} className="rounded border border-[rgb(var(--ss-border))] p-2 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span>样例 {r.case ?? i + 1}</span>
                              <Badge tone={r.ok ? 'ok' : 'danger'}>{r.ok ? '通过' : '不通过'}</Badge>
                            </div>
                            {r.reason && <div className="mt-1 text-[rgb(var(--ss-muted))]">{r.reason}</div>}
                            {(r.expected !== undefined || r.actual !== undefined) && (
                              <div className="mt-1 font-mono text-[11px] text-[rgb(var(--ss-faint))]">
                                期望 {r.expected ?? '—'} / 实际 {r.actual ?? '—'}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {verify.raw && <div className="mt-2 text-[11px] text-[rgb(var(--ss-faint))]">原始输出：{verify.raw}</div>}
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
