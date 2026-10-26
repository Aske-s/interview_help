import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'

/**
 * 文档文本抽取：纯文本直接读，PDF 走 pdfjs-dist，DOCX 走 mammoth。
 *
 * pdfjs 与 mammoth 都按需动态加载：应用启动时不必付出解析成本，
 * 也避免把这两个体积较大的库塞进主进程的启动路径。
 */

/** 单文件上限 20MB，超过直接拒绝，避免把主进程内存打满 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 按 UTF-8 直接读取的纯文本类扩展名 */
const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.ts',
  '.js',
  '.py',
  '.java',
  '.go',
  '.sql'
])

/** pdfjs 的最小类型面：只描述我们用到的部分，避免绑定其 .d.mts 的导出形状 */
interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}
interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>
}
interface PdfDocument {
  numPages: number
  getPage(num: number): Promise<PdfPage>
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}
interface PdfModule {
  getDocument(src: Record<string, unknown>): PdfLoadingTask
}

function withTrailingSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

/**
 * 定位 pdfjs 自带的字体 / CMap 资源目录。
 *
 * 这两份资源很关键：CMap 决定中文等 CJK 字体的字形映射（缺了就抽出乱码），
 * 标准字体数据决定未内嵌 Helvetica 等标准字体的兜底。拿不到时返回 null，
 * 让抽取退化为 pdfjs 默认行为，而不是让整个导入失败。
 */
function pdfAssetDir(sub: string): string | null {
  try {
    const req = createRequire(__filename)
    return join(dirname(req.resolve('pdfjs-dist/package.json')), sub)
  } catch {
    return null
  }
}

async function extractPdf(filePath: string): Promise<string> {
  // legacy 构建才能在 Node / Electron 主进程里跑（非 legacy 构建依赖浏览器环境）
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule
  const data = new Uint8Array(readFileSync(filePath))

  const fontDir = pdfAssetDir('standard_fonts')
  const cMapDir = pdfAssetDir('cmaps')

  const task = pdfjs.getDocument({
    data,
    // 主进程里没有页面上下文，显式关掉 worker 侧的网络取数
    useWorkerFetch: false,
    // 只抽文本不渲染，关掉字体加载
    disableFontFace: true,
    useSystemFonts: false,
    // 部分 PDF 会刷大量字体警告，压到只报错
    verbosity: 0,
    ...(fontDir ? { standardFontDataUrl: withTrailingSlash(fontDir) } : {}),
    ...(cMapDir ? { cMapUrl: withTrailingSlash(cMapDir), cMapPacked: true } : {})
  })

  try {
    const doc = await task.promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        const str = item.str
        if (!str) continue
        pageText += str
        // hasEOL 标记该项位于行尾，补换行避免相邻行被粘成一句话
        if (item.hasEOL) pageText += '\n'
      }
      if (pageText.trim()) pages.push(pageText)
    }
    return pages.join('\n\n')
  } finally {
    // pdfjs v6 的 PDFDocumentProxy 没有 destroy()，必须销毁 loadingTask，
    // 否则每次导入都会泄漏一个 worker / transport
    await task.destroy().catch(() => undefined)
  }
}

async function extractDocx(filePath: string): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText(opts: { path: string }): Promise<{ value: string }>
  }
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value
}

/** 抽取文档纯文本；不支持的格式 / 超限 / 文件不存在都会抛错，由调用方转成 Result.error */
export async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  // statSync 顺带校验文件存在，文件不存在时会抛出 ENOENT
  const size = statSync(filePath).size
  if (size > MAX_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限（当前 ${(size / 1024 / 1024).toFixed(1)}MB）`)
  }
  if (size === 0) return ''

  if (TEXT_EXTS.has(ext)) return readFileSync(filePath, 'utf8')
  if (ext === '.pdf') return extractPdf(filePath)
  if (ext === '.docx') return extractDocx(filePath)

  throw new Error(`暂不支持的格式：${ext || '(无扩展名)'}`)
}
