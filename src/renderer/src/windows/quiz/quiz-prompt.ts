import type { ChatMessage, QuizConfig, QuizTestCase } from '@shared/types'

/**
 * 截图解题的 prompt 构造与样例校验。
 *
 * 对齐原版语义：
 *  - 代码格式：ACM（完整 IO 程序）／核心（仅函数核心代码）
 *  - 结论格式：精简（只给代码和复杂度）／全面（思路+代码+复杂度）
 *  - 编程语言：自动＝按截图自适应判题语言
 */

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动（按截图自适应）' },
  { value: 'cpp', label: 'C++' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'csharp', label: 'C#' },
  { value: 'c', label: 'C' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'swift', label: 'Swift' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Shell' }
]

export function defaultQuizConfig(): QuizConfig {
  return { codeMode: 'core', answerStyle: 'full', language: 'auto', maxBatchScreens: 5 }
}

const LANGUAGE_LABEL: Record<string, string> = {
  cpp: 'C++',
  java: 'Java',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  go: 'Go',
  rust: 'Rust',
  csharp: 'C#',
  c: 'C',
  kotlin: 'Kotlin',
  swift: 'Swift',
  sql: 'SQL',
  bash: 'Shell'
}

/** 构造解题请求的消息 */
export function buildQuizMessages(opts: {
  config: QuizConfig
  /** 用户补充的文字说明 */
  note?: string
  /** 附带的标准输入样例（用于让模型理解题意） */
  testCases?: QuizTestCase[]
}): ChatMessage[] {
  const { config, note, testCases } = opts
  const rules: string[] = []

  rules.push('请识别图片中的题目并作答。')

  // 代码格式
  if (config.codeMode === 'acm') {
    rules.push(
      '代码格式：ACM 模式 —— 给出可直接提交的完整程序，包含输入读取与输出打印（main 函数/入口完整）。'
    )
  } else {
    rules.push('代码格式：核心代码模式 —— 只给出核心函数/方法实现，不要包含输入输出处理与 main 函数。')
  }

  // 结论格式
  if (config.answerStyle === 'concise') {
    rules.push('结论格式：精简 —— 只给代码与复杂度，不要额外解释。')
  } else {
    rules.push('结论格式：全面 —— 先简述思路，再给代码，最后给出时间与空间复杂度。')
  }

  // 语言
  if (config.language === 'auto') {
    rules.push('编程语言：按截图中的判题语言自适应；若图中未指定，用 Python。代码块需标注语言。')
  } else {
    rules.push(`编程语言：必须使用 ${LANGUAGE_LABEL[config.language] ?? config.language}。代码块需标注语言。`)
  }

  rules.push('不要复述题目全文，不要输出与解题无关的客套话。若图片模糊导致题面无法确认，只指出缺失的关键信息。')

  if (testCases?.length) {
    const cases = testCases
      .map((c, i) => `样例 ${i + 1}：\n输入：\n${c.input}\n期望输出：\n${c.expected}`)
      .join('\n\n')
    rules.push(`用户提供的测试样例（请确保代码能通过这些样例）：\n\n${cases}`)
  }

  const content = rules.join('\n\n')
  const text = note?.trim() ? `${content}\n\n补充说明：${note.trim()}` : content

  return [
    {
      role: 'system',
      content: '你是一名算法竞赛选手，擅长看图理解题意并给出正确、可直接使用的解法。'
    },
    { role: 'user', content: [{ type: 'text', text }] }
  ]
}

/** 样例校验的 prompt：让模型按样例自检代码 */
export function buildVerifyMessages(code: string, testCases: QuizTestCase[]): ChatMessage[] {
  const cases = testCases
    .map((c, i) => `样例 ${i + 1}\n输入：\n${c.input}\n期望输出：\n${c.expected}`)
    .join('\n\n')

  return [
    {
      role: 'system',
      content:
        '你是严格的判题器。只输出 JSON，不要输出任何其他内容。' +
        '格式：{"passed": true|false, "results": [{"case": 1, "ok": true|false, "expected": "...", "actual": "...", "reason": "..."}], "summary": "一句话结论"}'
    },
    {
      role: 'user',
      content: `请逐行执行下面这段代码，核对每一组样例的标准输入与期望输出，判断是否全部通过。\n\n代码：\n\`\`\`\n${code}\n\`\`\`\n\n${cases}`
    }
  ]
}

export interface VerifyCaseResult {
  case?: number
  ok?: boolean
  expected?: string
  actual?: string
  reason?: string
}

export interface VerifyResult {
  passed: boolean
  summary: string
  results: VerifyCaseResult[]
  /** 模型输出无法解析时的原文，便于排查 */
  raw?: string
}

/** 容错解析判题结果：模型可能返回 ```json 围栏或前后带文字 */
export function parseVerifyResult(text: string): VerifyResult {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  const attempt = (candidate: string): VerifyResult | null => {
    try {
      const parsed = JSON.parse(candidate) as VerifyResult
      if (typeof parsed !== 'object' || parsed === null) return null
      return {
        passed: Boolean(parsed.passed),
        summary: typeof parsed.summary === 'string' ? parsed.summary : parsed.passed ? '样例检查通过' : '样例检查未通过',
        results: Array.isArray(parsed.results) ? parsed.results : []
      }
    } catch {
      return null
    }
  }

  const direct = attempt(cleaned)
  if (direct) return direct

  const start = cleaned.search(/[[{]/)
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    const nested = attempt(cleaned.slice(start, end + 1))
    if (nested) return nested
  }

  return { passed: false, summary: '无法解析判题结果', results: [], raw: text.slice(0, 300) }
}
