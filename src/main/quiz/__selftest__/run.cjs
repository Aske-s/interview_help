/**
 * 截图解题 prompt 与判题解析自测。
 *
 * 运行：
 *   node src/main/quiz/__selftest__/run.cjs
 *
 * 覆盖：ACM/核心代码模式、结论格式、编程语言、测试样例注入、
 * 判题结果容错解析（JSON 围栏 / 前后废话 / 无法解析）。
 */
const fs = require('node:fs')
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
  throw new Error('找不到项目根')
}
const ROOT = findRoot(__dirname)

const ts = require(path.join(ROOT, 'node_modules', 'typescript'))
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  })
  mod._compile(out.outputText, filename)
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@shared/')) request = path.join(ROOT, 'src', request.slice('@'.length))
  return originalResolve.call(this, request, ...rest)
}

const prompt = require(path.join(ROOT, 'src/renderer/src/windows/quiz/quiz-prompt.ts'))

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/** 取出用户消息里的纯文本，便于断言 */
function userText(messages) {
  const parts = messages[1].content
  if (typeof parts === 'string') return parts
  return parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
}

function main() {
  const base = prompt.defaultQuizConfig()

  /* ============ 默认配置 ============ */
  check('默认配置：核心模式 + 全面格式 + 语言自动', base.codeMode === 'core' && base.answerStyle === 'full' && base.language === 'auto', JSON.stringify(base))

  /* ============ 代码格式 ============ */
  const acm = prompt.buildQuizMessages({ config: { ...base, codeMode: 'acm' } })
  check('ACM 模式：要求完整 IO 程序', /ACM/.test(userText(acm)) && /完整程序|输入读取|输出打印/.test(userText(acm)), userText(acm).slice(0, 60))

  const core = prompt.buildQuizMessages({ config: { ...base, codeMode: 'core' } })
  check('核心模式：明确不要 main 与 IO', /核心代码模式/.test(userText(core)) && /不要包含输入输出/.test(userText(core)))

  /* ============ 结论格式 ============ */
  const concise = prompt.buildQuizMessages({ config: { ...base, answerStyle: 'concise' } })
  check('精简格式：只要代码与复杂度', /精简/.test(userText(concise)) && /只给代码与复杂度/.test(userText(concise)))

  const full = prompt.buildQuizMessages({ config: { ...base, answerStyle: 'full' } })
  check('全面格式：思路+代码+复杂度', /全面/.test(userText(full)) && /时间与空间复杂度/.test(userText(full)))

  /* ============ 编程语言 ============ */
  const py = prompt.buildQuizMessages({ config: { ...base, language: 'python' } })
  check('指定语言：写入 prompt', /必须使用 Python/.test(userText(py)), userText(py).slice(-80))

  const auto = prompt.buildQuizMessages({ config: { ...base, language: 'auto' } })
  check('自动语言：按截图自适应', /自适应/.test(userText(auto)))

  const cpp = prompt.buildQuizMessages({ config: { ...base, language: 'cpp' } })
  check('语言映射：cpp → C++', /必须使用 C\+\+/.test(userText(cpp)), userText(cpp).slice(-60))

  /* ============ 测试样例注入 ============ */
  const cases = [
    { id: 'c1', input: '3\n1 2 3', expected: '6' },
    { id: 'c2', input: '1\n5', expected: '5' }
  ]
  const withCases = prompt.buildQuizMessages({ config: base, testCases: cases })
  const text = userText(withCases)
  check('样例注入：包含输入与期望输出', text.includes('1 2 3') && text.includes('期望输出') && text.includes('6'))
  check('样例注入：编号清晰', /样例 1/.test(text) && /样例 2/.test(text))

  /* ============ 补充说明 ============ */
  const noted = prompt.buildQuizMessages({ config: base, note: '输入保证升序' })
  check('补充说明：附加到 prompt', /补充说明：输入保证升序/.test(userText(noted)))

  /* ============ 消息结构 ============ */
  check('消息结构：system + user 两条', withCases.length === 2 && withCases[0].role === 'system' && withCases[1].role === 'user')
  check('消息结构：user 为多模态数组（可追加图片）', Array.isArray(withCases[1].content) && withCases[1].content[0].type === 'text')

  /* ============ 判题结果解析 ============ */
  const clean = prompt.parseVerifyResult('{"passed":true,"summary":"全部通过","results":[{"case":1,"ok":true}]}')
  check('判题解析：纯 JSON', clean.passed === true && clean.results.length === 1, clean.summary)

  const fenced = prompt.parseVerifyResult('```json\n{"passed":false,"summary":"样例2不通过","results":[]}\n```')
  check('判题解析：带 ```json 围栏', fenced.passed === false && fenced.summary === '样例2不通过')

  const chatty = prompt.parseVerifyResult('好的，我来检查一下：\n{"passed":true,"summary":"通过","results":[{"case":1,"ok":true,"expected":"6","actual":"6"}]}\n希望有帮助！')
  check('判题解析：前后带废话', chatty.passed === true && chatty.results[0].actual === '6')

  const broken = prompt.parseVerifyResult('抱歉，我无法判断。')
  check('判题解析：无法解析时给出兜底', broken.passed === false && broken.raw !== undefined, broken.summary)

  const partial = prompt.parseVerifyResult('{"summary":"缺少 passed 字段"}')
  check('判题解析：缺字段时按未通过处理且不崩', partial.passed === false && partial.summary === '缺少 passed 字段')

  /* ============ 判题 prompt ============ */
  const verifyMsgs = prompt.buildVerifyMessages('print(sum(x))', [{ id: 'c', input: '1 2', expected: '3' }])
  check('判题 prompt：包含代码与样例', verifyMsgs[1].content.includes('print(sum(x))') && verifyMsgs[1].content.includes('1 2'))
  check('判题 prompt：要求只输出 JSON', /只输出 JSON/.test(verifyMsgs[0].content))

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
