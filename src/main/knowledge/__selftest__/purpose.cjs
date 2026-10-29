/**
 * 知识库「用途」自测：简历 / 题库 / 通用。
 *
 * 运行：node src/main/knowledge/__selftest__/purpose.cjs
 *
 * 背景：简历、题库是"稳定背景"，回答时几乎总会用到，必须**整份注入**；
 * 而通用资料量大，只能按问题检索。两者注入方式不同，所以要分开验证。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到项目根目录')
}
const ROOT = findRoot(__dirname)
const DATA = path.join(os.tmpdir(), `suisi-kb-purpose-${process.pid}`)
/** 捕获 IPC handler，用来验证「创建知识库带用途」这条入口 */
const ipcHandlers = new Map()
fs.mkdirSync(DATA, { recursive: true })

const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@shared/')) request = path.join(ROOT, 'src', request.slice('@'.length))
  return origResolve.call(this, request, ...rest)
}
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA, getName: () => 'x', isPackaged: false },
      ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: { isEncryptionAvailable: () => false }
    }
  }
  return origLoad.apply(this, [request, ...rest])
}

/* ---- 可控的模型替身：记录提示词、返回预设内容 ---- */
let llmCalls = []
let llmReply = '基本信息：8 年 / 后端 / 本科\n技术栈：Go, MySQL, Redis\n项目经历：支付系统｜重构｜我的职责：主导｜技术点：幂等｜亮点：资损 0\n可讲的强项：高并发设计'
let llmFail = false
const origLoad2 = Module._load
Module._load = function (request, ...rest) {
  if (request.endsWith('gateway/llm') || request === '../gateway/llm') {
    const real = origLoad2.apply(this, [request, ...rest])
    return {
      ...real,
      chatComplete: async (opts) => {
        llmCalls.push(opts)
        if (llmFail) throw new Error('mock 网关不可用')
        return { text: llmReply, reasoning: '', firstTokenMs: 1, totalMs: 2 }
      },
      embed: async () => [[]]
    }
  }
  return origLoad2.apply(this, [request, ...rest])
}
// activeProvider 需要有 baseUrl 才会真的调用
const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))
settingsStore.patch({
  providers: [
    {
      id: 'p-test',
      name: 'test',
      baseUrl: 'http://stub.invalid/v1',
      apiKey: 'k',
      model: 'stub-model',
      supportsVision: false
    }
  ],
  activeProviderId: 'p-test'
})

const { knowledgeStore } = require(path.join(ROOT, 'src/main/knowledge/store.ts'))
const { contextByPurpose, distillResume, invalidateResumeProfile, RESUME_PROFILE_MAX_CHARS } =
  require(path.join(ROOT, 'src/main/knowledge/index.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

let seq = 0
function makeKb({ name, purpose, updatedAt, docs: docTexts }) {
  const id = `kb-${++seq}`
  const now = updatedAt ?? Date.now() + seq
  knowledgeStore.kbs.upsert({
    id,
    name,
    purpose,
    createdAt: now - 1,
    updatedAt: now
  })
  docTexts.forEach((text, i) => {
    const docId = `${id}-doc-${i}`
    knowledgeStore.docs.upsert({ id: docId, kbId: id, name: `${name}-${i}`, chars: text.length, chunks: 1, createdAt: now })
    knowledgeStore.chunks.appendMany(id, [
      { id: `${docId}-c0`, kbId: id, docId, docName: `${name}-${i}`, text }
    ])
  })
  return id
}

async function main() {
  // 1. 没有对应用途的库 → 空串
  check('没有该用途的库：返回空串', contextByPurpose('resume', 3000) === '')

  // 2. 只取指定用途
  makeKb({ name: '我的简历', purpose: 'resume', docs: ['8 年后端经验，主导过支付系统重构。'] })
  makeKb({ name: '面试题库', purpose: 'quiz', docs: ['手写 LRU 缓存：哈希表 + 双向链表。'] })
  makeKb({ name: '公司资料', purpose: 'general', docs: ['这段属于通用资料，不该被整份注入。'] })
  const resume = contextByPurpose('resume', 3000)
  check('简历：取到了内容', resume.includes('8 年后端经验'))
  check('简历：只包含简历用途的库', !resume.includes('手写 LRU') && !resume.includes('通用资料'))
  check('简历：带上了库名便于模型区分来源', resume.includes('《我的简历》'))

  const quiz = contextByPurpose('quiz', 3000)
  check('题库：只包含题库用途的库', quiz.includes('手写 LRU') && !quiz.includes('8 年后端经验'))

  const general = contextByPurpose('general', 3000)
  check('通用：只包含通用用途的库', general.includes('通用资料') && !general.includes('8 年后端经验'))

  // 3. 多份同用途：按更新时间从新到旧
  makeKb({ name: '补充简历', purpose: 'resume', updatedAt: Date.now() + 999, docs: ['补充：熟悉 Kubernetes。'] })
  const multi = contextByPurpose('resume', 5000)
  check(
    '多份简历：更新的排在前面',
    multi.indexOf('补充：熟悉') >= 0 && multi.indexOf('补充：熟悉') < multi.indexOf('8 年后端经验'),
    `位置 补充=${multi.indexOf('补充：熟悉')} 原=${multi.indexOf('8 年后端经验')}`
  )

  // 4. 同一知识库内多文档：保持导入顺序
  makeKb({ name: '顺序库', purpose: 'quiz', docs: ['第一段内容。', '第二段内容。', '第三段内容。'] })
  const ordered = contextByPurpose('quiz', 9999)
  const i1 = ordered.indexOf('第一段内容')
  const i2 = ordered.indexOf('第二段内容')
  const i3 = ordered.indexOf('第三段内容')
  check('多文档：保持导入顺序', i1 >= 0 && i1 < i2 && i2 < i3, `${i1}/${i2}/${i3}`)

  // 5. 预算截断
  const big = 'A'.repeat(4000)
  makeKb({ name: '超长库', purpose: 'quiz', updatedAt: Date.now() + 99999, docs: [big] })
  const capped = contextByPurpose('quiz', 500)
  check('预算：总体不超上限（含少量包装文本）', capped.length <= 500 + 60, `${capped.length} 字符`)
  check('预算：截断处有提示', capped.includes('已截断'), capped.slice(-24))

  // 6. 空知识库（有库但没文档）不应产生空块
  knowledgeStore.kbs.upsert({ id: 'kb-empty', name: '空库', purpose: 'resume', createdAt: 1, updatedAt: Date.now() + 100000 })
  const withEmpty = contextByPurpose('resume', 5000)
  check('空库：不产生空标题块', !withEmpty.includes('《空库》'))

  // 7. 用途缺省 = 通用（老数据兼容）
  knowledgeStore.kbs.upsert({ id: 'kb-legacy', name: '老库', createdAt: 1, updatedAt: 1 })
  knowledgeStore.docs.upsert({ id: 'legacy-doc', kbId: 'kb-legacy', name: 'd', chars: 4, chunks: 1, createdAt: 1 })
  knowledgeStore.chunks.appendMany('kb-legacy', [
    { id: 'legacy-c0', kbId: 'kb-legacy', docId: 'legacy-doc', docName: 'd', text: '老数据没有 purpose 字段。' }
  ])
  check('老数据：缺省用途视为通用', contextByPurpose('general', 5000).includes('老数据没有 purpose'))
  check('老数据：不会被当成简历', !contextByPurpose('resume', 5000).includes('老数据没有 purpose'))

  /* ---------- 简历速查卡：上传后提炼一次，之后只用速查卡 ---------- */
  const resumeKbId = makeKb({
    name: '我的简历V2',
    purpose: 'resume',
    updatedAt: Date.now() + 500000,
    docs: ['张三，8 年后端，主导支付系统重构，熟悉 Go / MySQL / Redis。'.repeat(20)]
  })

  llmCalls = []
  const distill1 = await distillResume(resumeKbId)
  check('提炼：成功', distill1.ok === true, JSON.stringify(distill1))
  check('提炼：只调了一次模型', llmCalls.length === 1, `${llmCalls.length} 次`)
  check(
    '提炼：提示词里带了简历原文',
    JSON.stringify(llmCalls[0]?.messages ?? []).includes('主导支付系统重构'),
    JSON.stringify(llmCalls[0]?.messages ?? []).slice(0, 80)
  )
  check(
    '提炼：提示词要求不编造 + 字数上限',
    JSON.stringify(llmCalls[0]?.messages ?? []).includes('绝对不要补充') &&
      JSON.stringify(llmCalls[0]?.messages ?? []).includes(String(RESUME_PROFILE_MAX_CHARS)),
    ''
  )

  const storedKb = knowledgeStore.kbs.all().find((k) => k.id === resumeKbId)
  check('提炼：速查卡已存到知识库上', Boolean(storedKb?.profile) && storedKb.profile.includes('8 年'), `${storedKb?.profile?.length ?? 0} 字`)
  check('提炼：记录了生成时间与模型', typeof storedKb?.profileAt === 'number' && storedKb?.profileModel === 'stub-model')

  // 注入时优先用速查卡，而不是原文
  const injected = contextByPurpose('resume', 3000)
  check('注入：用的是速查卡（带标记）', injected.includes('（速查卡）'))
  check('注入：速查卡内容进去了', injected.includes('技术栈：Go') && injected.includes('可讲的强项'))
  check(
    '注入：没有被简历原文撑爆（速查卡明显更短）',
    injected.includes('（速查卡）') && !injected.includes('张三，8 年后端，主导支付系统重构，熟悉 Go / MySQL / Redis。'.repeat(5)),
    `${injected.length} 字`
  )

  // 模型返回超长时兜底截断
  llmReply = 'A'.repeat(RESUME_PROFILE_MAX_CHARS + 800)
  await distillResume(resumeKbId)
  const capped2 = knowledgeStore.kbs.all().find((k) => k.id === resumeKbId)
  check(
    '提炼：模型写超了会被兜底截断',
    (capped2?.profile?.length ?? 0) <= RESUME_PROFILE_MAX_CHARS + 2,
    `${capped2?.profile?.length ?? 0} 字`
  )
  llmReply = '基本信息：8 年 / 后端 / 本科'

  // 失败时不破坏已有速查卡，且不阻塞主流程
  llmFail = true
  const before = knowledgeStore.kbs.all().find((k) => k.id === resumeKbId)?.profile
  const distillFail = await distillResume(resumeKbId)
  check('提炼失败：返回 ok=false 并带原因', distillFail.ok === false && Boolean(distillFail.error), String(distillFail.error))
  const after = knowledgeStore.kbs.all().find((k) => k.id === resumeKbId)?.profile
  check('提炼失败：原有速查卡不被清掉', after === before)
  llmFail = false

  // 内容变动 → 作废速查卡，回退用原文
  invalidateResumeProfile(resumeKbId)
  const invalidated = knowledgeStore.kbs.all().find((k) => k.id === resumeKbId)
  check('作废：profile 被清空', !invalidated?.profile)
  check('作废后：回退成原文注入（还能用）', contextByPurpose('resume', 60000).includes('张三，8 年后端'))

  // 非简历用途不提炼
  const quizKbId = makeKb({ name: '题库X', purpose: 'quiz', docs: ['某道题'] })
  const notResume = await distillResume(quizKbId)
  check('非简历用途：拒绝提炼并说明原因', notResume.ok === false && /简历/.test(String(notResume.error)), String(notResume.error))

  /* ---------- IPC 入口：创建时带用途 / 事后可改 ---------- */
  require(path.join(ROOT, 'src/main/ipc/knowledge.ts')).registerKnowledgeIpc()
  const createHandler = ipcHandlers.get('kb:create')
  const setPurposeHandler = ipcHandlers.get('kb:set-purpose')
  check('IPC：kb:create 已注册', typeof createHandler === 'function')
  check('IPC：kb:set-purpose 已注册', typeof setPurposeHandler === 'function')

  const createdList = await createHandler({}, '新建简历库', undefined, 'resume')
  const created = createdList[0]
  check('IPC 创建：接受用途参数并落库', created?.purpose === 'resume', JSON.stringify(created?.purpose))
  check('IPC 创建：新库排在返回列表最前（界面据此自动切过去）', created?.name === '新建简历库', String(created?.name))

  const changed = await setPurposeHandler({}, created.id, 'quiz')
  check('IPC 改用途：生效', changed.find((k) => k.id === created.id)?.purpose === 'quiz')
  check('IPC 改用途：不影响创建时间', Boolean(changed.find((k) => k.id === created.id)?.createdAt))

  const createdDefault = await createHandler({}, '没写用途的库')
  check('IPC 创建：缺省用途=general', createdDefault[0]?.purpose === 'general', String(createdDefault[0]?.purpose))

  fs.rmSync(DATA, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e)
  process.exit(1)
})
