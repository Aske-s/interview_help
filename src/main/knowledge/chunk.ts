/**
 * 文本分块：目标 400-800 字一块，优先在段落 / 句子边界切开，块间保留重叠。
 *
 * 之所以要重叠：检索时一句话可能跨块，重叠能保证边界处的语义不被切断。
 */

/** 单块目标长度（字） */
export const CHUNK_SIZE = 600
/** 相邻块的overlap（字） */
export const CHUNK_OVERLAP = 80
/** 边界回退的下限：窗口前 65% 内不切，避免切出过短块 */
const BOUNDARY_FLOOR_RATIO = 0.65
/** 剩余文本短于该值时并入当前块，避免出现只有几个字的尾块 */
const MIN_TAIL = 120

/** 统一换行、压缩连续空行，让段落边界可预测 */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 边界候选按优先级排列：段落 > 换行 > 句末标点。
 * advance 表示切点应落在标记之后的字符数。
 */
const BOUNDARIES: Array<[string, number]> = [
  ['\n\n', 2],
  ['\n', 1],
  ['。', 1],
  ['！', 1],
  ['？', 1],
  ['；', 1],
  ['! ', 2],
  ['? ', 2],
  ['. ', 2]
]

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = normalize(text)
  if (!clean) return []
  if (clean.length <= size) return [clean]

  const floor = Math.floor(size * BOUNDARY_FLOOR_RATIO)
  const out: string[] = []
  let cursor = 0

  while (cursor < clean.length) {
    let end = Math.min(cursor + size, clean.length)

    if (end < clean.length) {
      const window = clean.slice(cursor, end)
      // 按优先级找第一个"足够靠后"的边界；都找不到就硬切
      for (const [mark, advance] of BOUNDARIES) {
        const idx = window.lastIndexOf(mark)
        if (idx >= floor) {
          end = cursor + idx + advance
          break
        }
      }
      // 剩下的尾巴太短就并进当前块，避免碎片
      if (clean.length - end < MIN_TAIL) end = clean.length
    }

    const piece = clean.slice(cursor, end).trim()
    if (piece) out.push(piece)
    if (end >= clean.length) break

    // 回退 overlap 形成重叠；cursor 至少前进 1，防止死循环
    cursor = Math.max(end - overlap, cursor + 1)
  }

  return out
}
