/**
 * 真实 Electron 主进程端到端探针。
 *
 * 与 run.cjs 的区别：这里不 stub electron，pdfjs / mammoth 跑在真实的 Electron 运行时
 * （Node 版本、ESM 动态 import、资源解析规则都与生产一致）。
 *
 * 运行（会短暂启动 Electron，不需要窗口）：
 *   cd suisi-local && npx electron src/main/knowledge/__selftest__/electron-pdf.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')

// 把 userData 指到临时目录，避免污染真实应用数据
const USER_DATA = path.join(os.tmpdir(), 'suisi-kb-electron-probe')
app.setPath('userData', USER_DATA)
app.disableHardwareAcceleration()
// 本探针只验证 Node 侧逻辑（pdfjs/mammoth），不需要任何 GPU/合成能力；
// 在受限沙箱里 Chromium 的 GPU 进程会启动失败并让整个进程 FATAL，这里统一关掉。
for (const flag of ['no-sandbox', 'disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'in-process-gpu']) {
  app.commandLine.appendSwitch(flag)
}

process.env.KB_REAL_ELECTRON = '1'
process.env.KB_SELFTEST_DATA = USER_DATA

app.whenReady().then(async () => {
  console.log(`electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`)
  let ok = false
  try {
    const { knowledge, invoke, IPC } = require('./harness.cjs').load()

    const pdf = process.env.KB_REAL_PDF || ''
    if (!fs.existsSync(pdf)) {
      console.log('ELECTRON_SKIP 未找到真实 PDF')
      app.exit(0)
      return
    }

    const started = Date.now()
    const text = await knowledge.extractText(pdf)
    console.log(`[PDF 抽取] ${path.basename(pdf)} -> ${text.length} 字 / ${Date.now() - started}ms`)
    console.log(`[PDF 片段] ${JSON.stringify(text.slice(0, 60))}`)

    const list = await invoke(IPC.KbCreate, 'electron 探针知识库')
    const kbId = list.find((kb) => kb.name === 'electron 探针知识库').id
    const added = await invoke(IPC.KbAddDocument, kbId, { path: pdf })
    console.log(`[导入] ok=${added.ok} chunks=${added.data ? added.data.chunks : 0}`)

    const query = process.env.KB_PROBE_QUERY || 'graph-based agent memory taxonomy'
    const hits = await invoke(IPC.KbSearch, [kbId], query, 3)
    console.log(`[关键词检索] ${hits.length} 条, top1=${JSON.stringify((hits[0] ? hits[0].text : '').slice(0, 50))}`)

    const ctx = await knowledge.retrieveContext([kbId], query, 2)
    console.log(`[retrieveContext] ${ctx.length} 条`)

    ok = text.length > 1000 && added.ok && added.data.chunks > 0 && hits.length > 0 && ctx.length > 0
  } catch (error) {
    console.log('[异常]', error && error.message ? error.message : error)
  }
  console.log(ok ? 'ELECTRON_OK' : 'ELECTRON_FAIL')
  app.exit(ok ? 0 : 1)
})
