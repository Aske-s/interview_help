/**
 * 知识库自测。
 *
 * 运行：
 *   cd suisi-local && node src/main/knowledge/__selftest__/run.cjs
 *
 * 覆盖：分块边界、7 个 IPC 通道、md/pdf/docx 导入、BM25 命中与排序、
 * 向量检索（本地假网关）、向量/网关故障降级、retrieveContext 容错、
 * 20MB 上限、级联删除、写盘性能对比、跨进程持久化。
 *
 * 不需要新增依赖：TS 转译与 electron stub 见 harness.cjs。
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const fixtures = require('./fixtures.cjs')

const RESULTS = []
function section(title) {
  console.log(`\n=== ${title} ===`)
}
function check(label, ok, detail) {
  const pass = !!ok
  RESULTS.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`)
  return pass
}

/* ------------------------------------------------------------------ *
 * 假向量网关（OpenAI 兼容 /v1/embeddings）
 * ------------------------------------------------------------------ */

const EMBED_DIM = 256

/** 确定性伪向量：按词元哈希到固定维度后做 L2 归一化 */
function pseudoVector(text, tokenize) {
  const vec = new Array(EMBED_DIM).fill(0)
  for (const token of tokenize(text)) {
    let hash = 2166136261
    for (let i = 0; i < token.term.length; i++) {
      hash ^= token.term.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    vec[Math.abs(hash) % EMBED_DIM] += token.boost
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0)) || 1
  return vec.map((value) => value / norm)
}

/* 独立实现一份向量文件读取 + 余弦，用来交叉验证 knowledge 模块的检索结果 */

function readVectorBlock(file) {
  const buf = fs.readFileSync(file)
  const dim = buf.readUInt32LE(0)
  const rows = buf.readUInt32LE(4)
  const ab = new ArrayBuffer(rows * dim * 4)
  Buffer.from(ab).set(buf.subarray(8))
  return { dim, rows, data: new Float32Array(ab) }
}

function cosineAt(block, row, query) {
  const offset = row * block.dim
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < block.dim; i++) {
    const x = block.data[offset + i]
    const y = query[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0
}

function startFakeEmbeddingServer(tokenize) {
  const state = { requests: 0, inputs: 0 }
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !String(req.url).endsWith('/embeddings')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      state.requests++
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        parsed = {}
      }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      state.inputs += inputs.length
      const data = inputs.map((text, index) => ({
        index,
        embedding: pseudoVector(String(text ?? ''), tokenize)
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data, model: parsed.model }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const harnessPath = path.join(__dirname, 'harness.cjs')
  const { load, invoke, dataDir, DATA_DIR } = require(harnessPath)

  // 每次自测从干净目录开始，保证结果可复现
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const fixtureDir = path.join(DATA_DIR, 'fixtures')
  fs.mkdirSync(fixtureDir, { recursive: true })

  const { knowledge, IPC, handlers, settings, store } = load()
  const setEmbedding = (cfg) => settings.settingsStore.patch({ embedding: cfg })
  const OFF = { enabled: false, baseUrl: '', apiKey: '', model: '' }
  const chunkFilePath = (kbId) => path.join(dataDir(), 'kb-chunks', `${kbId}.json`)
  const vectorFilePath = (kbId) => path.join(dataDir(), 'kb-vectors', `${kbId}.bin`)

  const createKb = async (name) => {
    const list = await invoke(IPC.KbCreate, name)
    return list.find((kb) => kb.name === name).id
  }

  setEmbedding(OFF)

  /* ---------------- 1. 分块 ---------------- */
  section('1. 分块策略')
  const mdText = fixtures.markdownText()
  const pieces = knowledge.chunkText(mdText)
  const lengths = pieces.map((piece) => piece.length)
  check('md 分块数 > 0', pieces.length > 0, `${pieces.length} 块 / 原文 ${mdText.length} 字`)
  check(
    '单块长度落在 400-800 区间',
    lengths.every((len) => len >= 350 && len <= 800),
    `min=${Math.min(...lengths)} max=${Math.max(...lengths)}`
  )
  check('相邻块存在重叠（约 80 字）', pieces[0].includes(pieces[1].slice(0, 30)), '第 2 块头部出现在第 1 块尾部')
  const boundaryEnded = pieces.filter((piece) => /[。！？；\n]$/.test(piece)).length
  check('多数块切在段落/句末边界', boundaryEnded >= Math.floor(pieces.length / 2), `${boundaryEnded}/${pieces.length} 块以边界字符结尾`)
  check('空文本返回空数组', knowledge.chunkText('   \n\n  ').length === 0)
  check('短文本单块返回', knowledge.chunkText('很短的一句话。').length === 1)

  /* ---------------- 2. IPC 通道 ---------------- */
  section('2. IPC 通道注册')
  const required = [
    IPC.KbList,
    IPC.KbCreate,
    IPC.KbDelete,
    IPC.KbAddDocument,
    IPC.KbRemoveDocument,
    IPC.KbListDocuments,
    IPC.KbSearch
  ]
  const expectedNames = [
    'kb:list',
    'kb:create',
    'kb:delete',
    'kb:add-document',
    'kb:remove-document',
    'kb:list-documents',
    'kb:search'
  ]
  check('7 个 Kb 通道全部注册', required.every((channel) => handlers.has(channel)), `已注册 ${handlers.size} 个 handler`)
  check('通道名与 shared/ipc.ts 完全一致', required.join(',') === expectedNames.join(','), required.join(', '))
  check('KbList 可调用', Array.isArray(await invoke(IPC.KbList)))

  /* ---------------- 3. 导入 md（向量关闭） ---------------- */
  section('3. 导入 md（向量关闭）')
  const kbId = await createKb('自测知识库')
  const mdPath = fixtures.writeMarkdown(fixtureDir)
  const mdDoc = await invoke(IPC.KbAddDocument, kbId, { path: mdPath })
  check('导入成功（Result.ok）', mdDoc.ok && !!mdDoc.data, mdDoc.error ?? '')
  check('chars > 0', mdDoc.data.chars > 0, `${mdDoc.data.chars} 字`)
  check('chunks > 0', mdDoc.data.chunks > 0, `${mdDoc.data.chunks} 块`)
  check('文档列表可见', (await invoke(IPC.KbListDocuments, kbId)).length === 1)
  check('分块文件已落盘', fs.existsSync(chunkFilePath(kbId)), path.relative(DATA_DIR, chunkFilePath(kbId)))
  const onDiskChunks = JSON.parse(fs.readFileSync(chunkFilePath(kbId), 'utf8'))
  check('落盘分块数与文档记录一致', onDiskChunks.length === mdDoc.data.chunks)
  check('落盘分块无 embedding 字段（向量走独立二进制）', onDiskChunks.every((c) => !('embedding' in c)))
  const kbAfterAdd = (await invoke(IPC.KbList)).find((kb) => kb.id === kbId)
  check('导入后知识库 updatedAt 被刷新', kbAfterAdd.updatedAt >= kbAfterAdd.createdAt)

  /* ---------------- 4. 关键词检索与 BM25 排序 ---------------- */
  section('4. 关键词检索（BM25）')
  const hits = await invoke(IPC.KbSearch, [kbId], fixtures.MARKER, 5)
  check('检索有结果', hits.length > 0, `${hits.length} 条`)
  check('top1 命中标记所在片段', hits[0].text.includes(fixtures.MARKER), `score=${hits[0].score.toFixed(3)}`)
  check('返回结构符合 RetrievedChunk', typeof hits[0].docId === 'string' && typeof hits[0].docName === 'string' && typeof hits[0].score === 'number')
  // 用纯拉丁生僻串：中文 2-gram 很容易与正文偶然共享（例如"存在""的词"），
  // 那样命中其实是 BM25 的正确行为，不能当作"无关查询"
  const missHits = await invoke(IPC.KbSearch, [kbId], 'qzxwvunonce', 5)
  check('无关查询返回空数组', missHits.length === 0, `${missHits.length} 条`)

  const rankKb = await createKb('排序知识库')
  const cacheText = fixtures.longText(2400).replace(/分布式缓存/g, '分布式缓存')
  await invoke(IPC.KbAddDocument, rankKb, {
    name: 'A-缓存.md',
    text: `${cacheText}\n缓存 缓存 命中率 缓存击穿 缓存雪崩 缓存失效 缓存穿透 缓存预热`
  })
  await invoke(IPC.KbAddDocument, rankKb, {
    name: 'B-时序.md',
    text: '时序数据的写入路径需要支持高并发追加。时序数据按时间分区，时序数据会降采样压缩。时序数据库查询支持聚合。'
  })
  await invoke(IPC.KbAddDocument, rankKb, {
    name: 'C-量子.md',
    text: `本节只讨论${fixtures.MARKER}这一件事。${fixtures.MARKER}决定检索降级的判定阈值。`
  })
  const rankHits = await invoke(IPC.KbSearch, [rankKb], fixtures.MARKER, 3)
  check('稀有词查询把正确文档排在第一', rankHits[0]?.docName === 'C-量子.md', `top1=${rankHits[0]?.docName}`)
  const cacheHits = await invoke(IPC.KbSearch, [rankKb], '缓存', 3)
  check('高频词查询把高词频文档排在第一', cacheHits[0]?.docName === 'A-缓存.md', `top1=${cacheHits[0]?.docName}`)
  check('topK 生效', (await invoke(IPC.KbSearch, [rankKb], '时序数据', 1)).length === 1)
  check('多知识库联合检索', (await invoke(IPC.KbSearch, [kbId, rankKb], fixtures.MARKER, 5)).length > 0)

  /* ---------------- 5. retrieveContext 容错 ---------------- */
  section('5. retrieveContext 容错（绝不抛异常）')
  const faultCases = [
    ['不存在的知识库', ['no-such-kb-id'], '任意问题'],
    ['空查询', [kbId], '   '],
    ['空知识库数组', [], '问题'],
    ['null 参数', null, null],
    ['数字参数', 12345, 678],
    ['undefined 参数', undefined, undefined],
    ['对象参数', { bad: true }, { bad: true }],
    ['超长 topK', [kbId], fixtures.MARKER, 99999]
  ]
  for (const [label, ids, query] of faultCases) {
    let outcome = null
    let threw = false
    try {
      outcome = await knowledge.retrieveContext(ids, query, 4)
    } catch (error) {
      threw = true
      outcome = error
    }
    check(`不抛异常且返回数组：${label}`, !threw && Array.isArray(outcome), threw ? String(outcome) : `长度 ${outcome.length}`)
  }

  /* ---------------- 6. PDF ---------------- */
  section('6. PDF 抽取与导入')
  setEmbedding(OFF)
  const pdfPath = fixtures.writePdf(path.join(fixtureDir, 'fixture.pdf'))
  const pdfText = await knowledge.extractText(pdfPath)
  check('抽取出文本', pdfText.length > 0, `${pdfText.length} 字`)
  check('文本包含第 1 页标记', pdfText.includes('PDFMARKER ALPHA'))
  check('文本包含第 2 页标记（多页遍历）', pdfText.includes('PDFMARKER BETA'))
  check('行尾补换行（hasEOL 生效）', pdfText.includes('\n'))
  const pdfDoc = await invoke(IPC.KbAddDocument, kbId, { path: pdfPath })
  check('PDF 导入成功且分块 > 0', pdfDoc.ok && pdfDoc.data.chunks > 0, pdfDoc.error ?? `${pdfDoc.data?.chunks} 块`)
  const pdfHits = await invoke(IPC.KbSearch, [kbId], 'PDFMARKER BETA', 5)
  check('PDF 内容可被检索命中', pdfHits.some((hit) => hit.text.includes('PDFMARKER')), `top1 含标记：${pdfHits[0]?.text.includes('PDFMARKER')}`)

  /* ---------------- 7. DOCX ---------------- */
  section('7. DOCX 抽取（mammoth）')
  const docxPath = fixtures.writeDocx(path.join(fixtureDir, 'fixture.docx'))
  const docxText = await knowledge.extractText(docxPath)
  check('抽取出文本', docxText.length > 0, `${docxText.length} 字`)
  check('包含标记词', docxText.includes('DOCXMARKER'))
  const docxDoc = await invoke(IPC.KbAddDocument, kbId, { path: docxPath })
  check('DOCX 导入成功', docxDoc.ok && docxDoc.data.chunks > 0, docxDoc.error ?? `${docxDoc.data?.chunks} 块`)

  /* ---------------- 8. 上限与格式 ---------------- */
  section('8. 文件上限与格式校验')
  const oversize = fixtures.writeOversizeTxt(fixtureDir, 21 * 1024 * 1024)
  const oversizeRes = await invoke(IPC.KbAddDocument, kbId, { path: oversize })
  check('超过 20MB 返回 Result.error', !oversizeRes.ok && /20MB/.test(oversizeRes.error ?? ''), oversizeRes.error ?? '')
  const unsupported = fixtures.writeUnsupported(fixtureDir)
  const unsupportedRes = await invoke(IPC.KbAddDocument, kbId, { path: unsupported })
  check('不支持的格式返回 Result.error', !unsupportedRes.ok, unsupportedRes.error ?? '')
  const missingRes = await invoke(IPC.KbAddDocument, kbId, { path: path.join(fixtureDir, '不存在.pdf') })
  check('文件不存在返回 Result.error', !missingRes.ok, missingRes.error ?? '')
  const emptyRes = await invoke(IPC.KbAddDocument, kbId, {})
  check('既无 text 也无 path 返回 Result.error', !emptyRes.ok, emptyRes.error ?? '')
  const ghostKbRes = await invoke(IPC.KbAddDocument, 'no-such-kb', { text: '内容' })
  check('知识库不存在返回 Result.error', !ghostKbRes.ok, ghostKbRes.error ?? '')

  /* ---------------- 9. 向量检索 ---------------- */
  section('9. 向量检索（本地假网关）')
  const fake = await startFakeEmbeddingServer(knowledge.tokenize)
  setEmbedding({ enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test-key', model: 'fake-embed' })
  const vecKb = await createKb('向量知识库')
  const vecDoc = await invoke(IPC.KbAddDocument, vecKb, { path: mdPath })
  check('向量化导入成功', vecDoc.ok && vecDoc.data.chunks > 0, vecDoc.error ?? `${vecDoc.data?.chunks} 块`)
  check('向量接口被调用', fake.state.requests > 0, `${fake.state.requests} 次请求 / ${fake.state.inputs} 条输入`)
  check('批量提交（一次请求含多块）', fake.state.inputs >= vecDoc.data.chunks, `${fake.state.inputs} 条输入 >= ${vecDoc.data.chunks} 块`)
  check('向量文件已落盘', fs.existsSync(vectorFilePath(vecKb)), path.relative(DATA_DIR, vectorFilePath(vecKb)))
  const vecSize = fs.statSync(vectorFilePath(vecKb)).size
  const expectedSize = 8 + vecDoc.data.chunks * EMBED_DIM * 4
  check('向量文件大小 = 头 8B + 行数×维度×4B', vecSize === expectedSize, `实际 ${vecSize} / 期望 ${expectedSize}`)
  const vecChunks = JSON.parse(fs.readFileSync(chunkFilePath(vecKb), 'utf8'))
  check('分块记录了 vec 行号', vecChunks.every((chunk, index) => chunk.vec === index))
  // 再追加一篇，统一校验行号与检索顺序
  const secondDoc = await invoke(IPC.KbAddDocument, vecKb, {
    name: '追加.md',
    text: `追加的第二篇文档，同样提到${fixtures.MARKER}，用于验证追加后行号不冲突。`
  })
  check('向量库追加第二篇文档成功', secondDoc.ok, secondDoc.error ?? '')
  const mergedChunks = JSON.parse(fs.readFileSync(chunkFilePath(vecKb), 'utf8'))
  const vectorized = mergedChunks.filter((chunk) => typeof chunk.vec === 'number')
  check('追加后 vec 行号连续无重复', new Set(vectorized.map((chunk) => chunk.vec)).size === vectorized.length)
  const vecBlock = readVectorBlock(vectorFilePath(vecKb))
  check('追加后向量行数 = 有向量的分块数', vecBlock.rows === vectorized.length, `${vecBlock.rows} 行 / ${vectorized.length} 块`)

  // 写盘体积对比：同样的向量，JSON 文本 vs 二进制
  const binBytes = fs.statSync(vectorFilePath(vecKb)).size
  const jsonBytes = Buffer.byteLength(
    JSON.stringify(Array.from({ length: vecBlock.rows }, () => new Array(vecBlock.dim).fill(0.123456789)))
  )
  check(
    '向量二进制明显比 JSON 省空间',
    binBytes < jsonBytes,
    `二进制 ${binBytes}B vs JSON≈${jsonBytes}B（同 ${vecBlock.rows}×${vecBlock.dim} 维）`
  )

  const beforeVecCalls = fake.state.requests
  const vecHits = await invoke(IPC.KbSearch, [vecKb], fixtures.MARKER, 5)
  check('向量检索触发并返回结果', fake.state.requests > beforeVecCalls && vecHits.length > 0, `${vecHits.length} 条`)
  check('余弦分数在 0-1 之间', vecHits.every((hit) => hit.score >= -0.0001 && hit.score <= 1.0001))

  // 交叉验证：用独立读取的向量文件 + 独立余弦实现复算，检索顺序必须完全一致。
  // 这条断言直接盯住 vec 行偏移与排序逻辑，不依赖伪向量的语义质量。
  const queryVec = pseudoVector(fixtures.MARKER, knowledge.tokenize)
  const manualOrder = vectorized
    .map((chunk) => ({ docId: chunk.docId, text: chunk.text, score: cosineAt(vecBlock, chunk.vec, queryVec) }))
    .sort((a, b) => b.score - a.score)
  check(
    '检索顺序 = 独立复算的余弦降序（验证 vec 行偏移）',
    vecHits.length === manualOrder.length &&
      vecHits.every((hit, i) => hit.docId === manualOrder[i].docId && Math.abs(hit.score - manualOrder[i].score) < 1e-6),
    `top1 手工=${manualOrder[0]?.score.toFixed(4)} / 检索=${vecHits[0]?.score.toFixed(4)}`
  )

  // 语义排序质量：两篇词汇互斥的短文档，伪向量也能清晰区分
  const vecRankKb = await createKb('向量排序知识库')
  await invoke(IPC.KbAddDocument, vecRankKb, {
    name: '向量-量子.md',
    text: `${fixtures.MARKER}决定降级判定阈值。${fixtures.MARKER}再次出现在本段。`
  })
  await invoke(IPC.KbAddDocument, vecRankKb, {
    name: '向量-缓存.md',
    text: '分布式缓存的击穿与雪崩规避，缓存预热与过期时间抖动。'
  })
  const quantumHits = await invoke(IPC.KbSearch, [vecRankKb], fixtures.MARKER, 3)
  check(
    '向量检索把相关文档排第一',
    quantumHits[0]?.docName === '向量-量子.md',
    `top1=${quantumHits[0]?.docName} score=${quantumHits[0]?.score.toFixed(4)}`
  )
  const cacheVecHits = await invoke(IPC.KbSearch, [vecRankKb], '缓存', 3)
  check(
    '向量检索对另一主题同样正确',
    cacheVecHits[0]?.docName === '向量-缓存.md',
    `top1=${cacheVecHits[0]?.docName} score=${cacheVecHits[0]?.score.toFixed(4)}`
  )

  /* ---------------- 10. 向量故障降级 ---------------- */
  section('10. 向量网关故障 → 关键词降级')
  setEmbedding({ enabled: true, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'dead' })
  const degraded = await invoke(IPC.KbSearch, [kbId], fixtures.MARKER, 5)
  check('网关不可用时仍能返回关键词结果', degraded.length > 0 && degraded[0].text.includes(fixtures.MARKER), `${degraded.length} 条`)
  const degradedCtx = await knowledge.retrieveContext([kbId], fixtures.MARKER, 3)
  check('retrieveContext 在向量故障时仍返回上下文', degradedCtx.length > 0)
  setEmbedding({ enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: '' })
  const noModel = await invoke(IPC.KbSearch, [kbId], fixtures.MARKER, 3)
  check('向量模型未配置时不报错', noModel.length > 0)
  setEmbedding(OFF)
  const offHits = await invoke(IPC.KbSearch, [kbId], fixtures.MARKER, 3)
  check('向量关闭时关键词检索正常', offHits.length > 0 && offHits[0].text.includes(fixtures.MARKER))

  /* ---------------- 11. 级联删除 ---------------- */
  section('11. 级联删除')
  setEmbedding({ enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'fake-embed' })
  const cascadeKb = await createKb('待删除知识库')
  const cascadeDoc = await invoke(IPC.KbAddDocument, cascadeKb, { name: '待删.md', text: fixtures.markdownText() })
  check('待删除知识库有文档', cascadeDoc.ok && (await invoke(IPC.KbListDocuments, cascadeKb)).length === 1)
  check('删除前分块文件存在', fs.existsSync(chunkFilePath(cascadeKb)))
  check('删除前向量文件存在', fs.existsSync(vectorFilePath(cascadeKb)))
  await invoke(IPC.KbDelete, cascadeKb)
  check('知识库已删除', (await invoke(IPC.KbList)).every((kb) => kb.id !== cascadeKb))
  check('文档元数据已级联删除', (await invoke(IPC.KbListDocuments, cascadeKb)).length === 0)
  check('分块文件已级联删除', !fs.existsSync(chunkFilePath(cascadeKb)))
  check('向量文件已级联删除', !fs.existsSync(vectorFilePath(cascadeKb)))
  check('删除后检索返回空', (await invoke(IPC.KbSearch, [cascadeKb], '任意查询')).length === 0)
  const rawDocs = JSON.parse(fs.readFileSync(path.join(dataDir(), 'kb-documents.json'), 'utf8'))
  check('kb-documents.json 无残留记录', rawDocs.every((doc) => doc.kbId !== cascadeKb))
  const rawKbs = JSON.parse(fs.readFileSync(path.join(dataDir(), 'kb.json'), 'utf8'))
  check('kb.json 无残留记录', rawKbs.every((kb) => kb.id !== cascadeKb))
  check('其它知识库未受影响', (await invoke(IPC.KbListDocuments, kbId)).length === 3, `剩余 ${(await invoke(IPC.KbListDocuments, kbId)).length} 篇`)

  // 单文档删除
  const beforeRemove = (await invoke(IPC.KbListDocuments, kbId)).length
  const victim = (await invoke(IPC.KbListDocuments, kbId)).find((doc) => doc.name.endsWith('.docx'))
  await invoke(IPC.KbRemoveDocument, victim.id)
  check('删除单个文档生效', (await invoke(IPC.KbListDocuments, kbId)).length === beforeRemove - 1)
  const afterRemoveChunks = JSON.parse(fs.readFileSync(chunkFilePath(kbId), 'utf8'))
  check('该文档的分块已一并删除', afterRemoveChunks.every((chunk) => chunk.docId !== victim.id))

  /* ---------------- 12. 性能 ---------------- */
  section('12. 性能：批量写 vs 逐块全量写')
  setEmbedding(OFF)
  const perfKb = await createKb('性能知识库')
  const perfText = fixtures.longText(200000)
  const t0 = Date.now()
  const perfDoc = await invoke(IPC.KbAddDocument, perfKb, { name: 'perf.md', text: perfText })
  const t1 = Date.now()
  check('大文档导入成功', perfDoc.ok, `${perfDoc.data.chunks} 块 / ${perfDoc.data.chars} 字`)

  // 旧的持久化方式：每写一块就整体重写整个集合（JsonCollection.upsert 内部会 flush）
  const legacyFile = path.join(DATA_DIR, 'legacy-chunks.json')
  const legacy = new store.JsonCollection(legacyFile)
  const t2 = Date.now()
  for (let i = 0; i < perfDoc.data.chunks; i++) {
    legacy.upsert({ id: `c${i}`, kbId: perfKb, docId: 'd', docName: 'perf.md', text: 'x'.repeat(600) })
  }
  const t3 = Date.now()
  const batchMs = t1 - t0
  const perChunkMs = t3 - t2
  check(
    '批量写显著快于逐块全量写',
    batchMs * 3 < perChunkMs,
    `新实现 ${batchMs}ms（1 次写盘）/ 旧方式 ${perChunkMs}ms（${perfDoc.data.chunks} 次写盘），快 ${(perChunkMs / Math.max(batchMs, 1)).toFixed(1)}×`
  )
  const chunkBytes = fs.statSync(chunkFilePath(perfKb)).size
  const sourceBytes = Buffer.byteLength(perfText)
  check(
    '分块文件体积符合预期（正文 + 重叠 + 元数据，不含向量）',
    chunkBytes < sourceBytes * 2,
    `${(chunkBytes / 1024).toFixed(0)}KB / 原文 ${(sourceBytes / 1024).toFixed(0)}KB = ${(chunkBytes / sourceBytes).toFixed(2)}×`
  )
  const searchStart = Date.now()
  for (let i = 0; i < 20; i++) await invoke(IPC.KbSearch, [perfKb], '缓存击穿与雪崩的规避', 5)
  const searchAvg = (Date.now() - searchStart) / 20
  check('检索延迟可接受（首次含索引构建）', searchAvg < 500, `平均 ${searchAvg.toFixed(1)}ms/次（${perfDoc.data.chunks} 块）`)
  const cachedStart = Date.now()
  for (let i = 0; i < 20; i++) await invoke(IPC.KbSearch, [perfKb], '缓存击穿与雪崩的规避', 5)
  check('索引缓存生效（重复查询更快）', (Date.now() - cachedStart) / 20 <= searchAvg, `重复查询平均 ${((Date.now() - cachedStart) / 20).toFixed(1)}ms`)

  /* ---------------- 13. 真实 PDF ---------------- */
  section('13. 真实 PDF（可选，验证 CMap / 复杂字体）')
  // 需要自备样例：KB_REAL_PDF=/path/to/sample.pdf（不入库，避免带个人文件路径）
  const realPdf = process.env.KB_REAL_PDF || ''
  if (fs.existsSync(realPdf)) {
    const started = Date.now()
    const text = await knowledge.extractText(realPdf)
    check('英文真实 PDF 抽取成功', text.length > 1000, `${text.length} 字 / ${Date.now() - started}ms`)
  } else {
    console.log('SKIP  未找到真实英文 PDF')
  }
  const cjkPdf = process.env.KB_REAL_CJK_PDF || ''
  if (fs.existsSync(cjkPdf)) {
    const text = await knowledge.extractText(cjkPdf)
    const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
    check('中文真实 PDF 抽取出足量汉字（CMap 生效）', cjkCount > 100, `${cjkCount} 个汉字 / 共 ${text.length} 字`)
  } else {
    console.log('SKIP  未找到真实中文 PDF')
  }

  /* ---------------- 14. 跨进程持久化 ---------------- */
  section('14. 跨进程持久化')
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, 'verify-persist.cjs')], {
      encoding: 'utf8',
      env: { ...process.env, KB_SELFTEST_DATA: DATA_DIR, KB_PERSIST_KB: kbId, KB_PERSIST_VEC_KB: vecKb }
    })
    process.stdout.write(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => `      ${line}`)
        .join('\n') + '\n'
    )
    check('新进程读到落盘数据并能检索命中', output.includes('PERSIST_OK'))
  } catch (error) {
    check('新进程读到落盘数据并能检索命中', false, String(error.message).slice(0, 200))
  }

  /* ---------------- 汇总 ---------------- */
  const failed = RESULTS.filter((item) => !item.pass)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  if (failed.length) {
    for (const item of failed) console.log(`  FAIL  ${item.label}${item.detail ? `  —  ${item.detail}` : ''}`)
  }

  fake.server.close()
  // 显式退出：避免 http server / 缓存句柄让进程挂住
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error('\n自测脚本本身崩溃：', error)
  process.exit(2)
})
