/**
 * 跨进程持久化验证。
 *
 * 由 run.cjs 以子进程方式调用：全新进程、同一数据目录，
 * 确认 knowledge 模块能从磁盘恢复知识库 / 文档 / 分块 / 向量，并且检索依然命中。
 */
const fs = require('node:fs')
const path = require('node:path')
const { load, invoke, dataDir } = require('./harness.cjs')

async function main() {
  const kbId = process.env.KB_PERSIST_KB
  const vecKb = process.env.KB_PERSIST_VEC_KB
  const { knowledge, IPC, settings } = load()

  // 关键词路径：不依赖任何网关
  settings.settingsStore.patch({ embedding: { enabled: false, baseUrl: '', apiKey: '', model: '' } })

  const kbs = await invoke(IPC.KbList)
  const docs = await invoke(IPC.KbListDocuments, kbId)
  const chunkFile = path.join(dataDir(), 'kb-chunks', `${kbId}.json`)
  const chunks = JSON.parse(fs.readFileSync(chunkFile, 'utf8'))
  const hits = await invoke(IPC.KbSearch, [kbId], '量子纠缠校准协议', 3)

  console.log(`恢复：知识库 ${kbs.length} 个 / 文档 ${docs.length} 篇 / 分块 ${chunks.length} 块`)
  console.log(`关键词检索命中 ${hits.length} 条，top1 含标记=${Boolean(hits[0]?.text?.includes('量子纠缠校准协议'))}`)

  let vectorsOk = true
  if (vecKb) {
    const block = knowledge.knowledgeStore.vectors.load(vecKb)
    vectorsOk = Boolean(block && block.dim > 0 && block.rows > 0)
    console.log(`向量二进制恢复：${block ? `${block.rows} 行 × ${block.dim} 维` : '未找到'}（读取成功=${vectorsOk}）`)
  }

  const ok = kbs.length > 0 && docs.length > 0 && chunks.length > 0 && hits.length > 0 && hits[0].text.includes('量子纠缠校准协议') && vectorsOk
  console.log(ok ? 'PERSIST_OK' : 'PERSIST_FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.log('PERSIST_FAIL', error && error.message ? error.message : error)
  process.exit(1)
})
