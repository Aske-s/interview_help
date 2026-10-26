/**
 * 自测夹具：现场生成 md / pdf / docx / 超大 txt，不依赖外部样例文件。
 *
 * DOCX 与 PDF 都是手写格式（zip 用 store 模式 + 手算 CRC32，PDF 手算 xref 偏移），
 * 这样自测是完全自包含的，不依赖 zip 命令或网络。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/* ------------------------------------------------------------------ *
 * Markdown 夹具
 * ------------------------------------------------------------------ */

/** 唯一标记：只在"检索与召回策略"一节出现，用来验证检索命中正确片段 */
const MARKER = '量子纠缠校准协议'
const MARKER_EN = 'Zeta-9'

function markdownText() {
  const sections = [
    {
      title: '系统概述',
      body: [
        'AI 面试助手是一套运行在桌面端的智能助手，主进程负责网络请求与文件访问，渲染进程只通过 IPC 读取数据。',
        '所有会话记录、待办与知识库数据都以 JSON 文件形式保存在用户数据目录，便于备份与迁移。',
        '模型网关采用 OpenAI 兼容协议，因此可以对接官方服务、中转站以及本地部署的推理服务。'
      ]
    },
    {
      title: '分布式缓存设计',
      body: [
        '缓存层负责吸收热点读请求，降低后端存储压力。缓存键的构造需要包含租户、实体类型与版本号。',
        '过期策略结合业务读写比例选择：读多写少的场景适合较长过期时间，写频繁的场景需要主动失效。',
        '为避免缓存击穿，热点键使用互斥重建；为避免雪崩，过期时间加入随机抖动。',
        '缓存与数据库的一致性通过先更新数据库再删除缓存来保证，并配合延迟双删降低脏读概率。',
        '监控指标覆盖命中率、平均加载耗时、重建次数与内存占用，命中率明显下降时自动告警。'
      ]
    },
    {
      title: '时序数据存储',
      body: [
        '时序数据以设备标识与时间戳作为主键，写入路径需要支持高并发追加。',
        '存储按时间分区，历史分区自动降采样并压缩，冷数据迁移到低成本介质。',
        '查询层支持按时间范围聚合，常用的降采样结果会预计算并缓存。'
      ]
    },
    {
      title: '检索与召回策略',
      body: [
        '检索分为向量召回与关键词召回两条路径，配置了向量模型时优先使用余弦相似度。',
        `当向量网关不可用，或知识库尚未向量化时，系统自动降级为关键词检索。内部代号${MARKER}决定了降级的判定阈值。`,
        `关键词路径使用中文二元切分与英文分词，并引入词频饱和与文档长度归一化，版本号 ${MARKER_EN} 之后加权策略才稳定。`,
        '中文没有天然的词边界，二元切分在零依赖的前提下能取得较稳定的召回效果，代价是索引体积略大。',
        '数字与专有名词在打分时获得更高权重，因为这类词元通常携带更强的区分度。'
      ]
    },
    {
      title: '向量化与成本',
      body: [
        '向量化按分块批量调用，单次请求携带多个输入以减少往返次数。',
        '向量以二进制形式保存，每个分量占四个字节，避免 JSON 文本带来的体积膨胀。',
        '切换向量模型时维度会变化，此时旧向量整体作废并重建，避免行号错位导致检索结果错乱。'
      ]
    }
  ]

  const parts = ['# 知识库自测文档', '']
  for (const section of sections) {
    parts.push(`## ${section.title}`, '')
    for (const line of section.body) parts.push(line)
    parts.push('')
  }
  return parts.join('\n')
}

/** 长文本生成器：用于性能对比与超大知识库场景 */
function longText(chars) {
  const sentences = [
    '分布式缓存的过期策略需要结合业务读写比例与数据一致性要求综合权衡，避免出现缓存击穿与雪崩。',
    '索引构建阶段需要统计词频与文档频率，并对文档长度做归一化处理，才能让打分在长短文本之间可比。',
    '分块边界优先落在段落与句末标点，块之间保留重叠，使跨块的语义不被硬切断。',
    '向量检索依赖预先计算的向量文件，关键词检索则完全依赖分块文本，两者可以独立降级。'
  ]
  let out = ''
  let index = 0
  while (out.length < chars) {
    out += `${sentences[index % sentences.length]}\n`
    index++
  }
  return out.slice(0, chars)
}

/* ------------------------------------------------------------------ *
 * PDF 夹具（手写最小 PDF）
 * ------------------------------------------------------------------ */

function escapePdfText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** 生成一个带正确 xref 偏移的多页 PDF（ASCII / Helvetica） */
function buildPdf(pageLines) {
  const objects = []
  const kids = pageLines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageLines.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  pageLines.forEach((lines, i) => {
    const pageObj = 4 + i * 2
    const contentObj = 5 + i * 2
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`
    const body = lines.map((line, k) => `BT /F1 12 Tf 72 ${740 - k * 18} Td (${escapePdfText(line)}) Tj ET`).join('\n')
    objects[contentObj] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`
  })

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1')
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function writePdf(file) {
  const page1 = [
    'Knowledge Base PDF Fixture',
    'PDFMARKER ALPHA section begins here.',
    'Cosine similarity is used when embeddings are enabled.',
    'BM25 keyword retrieval is the fallback path.',
    'Chunk size is six hundred characters with eighty overlap.'
  ]
  const page2 = [
    'Second page of the fixture document.',
    'PDFMARKER BETA appears on the second page only.',
    'The loader must join text items into readable lines.',
    'Text extraction should keep line breaks at hasEOL markers.'
  ]
  fs.writeFileSync(file, buildPdf([page1, page2]))
  return file
}

/* ------------------------------------------------------------------ *
 * DOCX 夹具（手写 zip，store 模式）
 * ------------------------------------------------------------------ */

/** CRC32：优先用 zlib 内置实现，老版本 Node 回退到查表法 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** 生成 store 模式（不压缩）的 zip，格式自包含，不依赖 zip 命令 */
function buildZip(entries) {
  const locals = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    centralParts.push(cd, name)

    offset += local.length + name.length + data.length
  }

  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([Buffer.concat(locals), central, end])
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function writeDocx(file) {
  const paragraphs = [
    'DOCXMARKER 开头段落：这是一份用于自测的文档。',
    '第二段说明：mammoth 抽取纯文本时应保留段落顺序。',
    '第三段包含一个专有名词 DeepSeek 与数字 2024。'
  ]
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((text) => `<w:p><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p>`).join('') +
    '<w:sectPr/></w:body></w:document>'

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'

  const zip = buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml }
  ])
  fs.writeFileSync(file, zip)
  return file
}

/* ------------------------------------------------------------------ *
 * 其它夹具
 * ------------------------------------------------------------------ */

function writeMarkdown(dir) {
  const file = path.join(dir, 'kb-selftest.md')
  fs.writeFileSync(file, markdownText(), 'utf8')
  return file
}

/** 超过 20MB 上限的 txt（内容本身不重要，只用于验证拒绝逻辑） */
function writeOversizeTxt(dir, bytes = 21 * 1024 * 1024) {
  const file = path.join(dir, 'oversize.txt')
  const fd = fs.openSync(file, 'w')
  try {
    const block = Buffer.alloc(1024 * 1024, 0x61)
    let written = 0
    while (written < bytes) {
      fs.writeSync(fd, block)
      written += block.length
    }
  } finally {
    fs.closeSync(fd)
  }
  return file
}

function writeUnsupported(dir) {
  const file = path.join(dir, 'unsupported.xyz')
  fs.writeFileSync(file, 'not a supported format', 'utf8')
  return file
}

module.exports = {
  MARKER,
  MARKER_EN,
  markdownText,
  longText,
  writeMarkdown,
  writePdf,
  writeDocx,
  writeOversizeTxt,
  writeUnsupported
}
