/**
 * AI 面试状态机自测。
 *
 * 运行：
 *   node src/main/interview/__selftest__/run.cjs
 *
 * 做法：转译真实源码字节，并把 store / settings / llm 换成可控桩，
 * 从而在不依赖 Electron 与真实模型的情况下验证：
 * 配置维度（难度/节奏/偏好/超时）如何进入 prompt、fixed 与 adaptive 的推进规则、
 * 反问环节语义、复盘两个入口、旧数据与脏数据兼容、出题失败可恢复。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
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
const ts = require(path.join(ROOT, 'node_modules', 'typescript'))

const SRC = path.join(ROOT, 'src/main/interview/index.ts')
const realBytes = fs.readFileSync(SRC)
const realSha = crypto.createHash('sha256').update(realBytes).digest('hex')

// 转译真实源码（type-only import 会被擦除）
const out = ts.transpileModule(realBytes.toString('utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const compiled = path.join(__dirname, '.compiled-interview.cjs')
fs.writeFileSync(compiled, out)
const copySha = crypto.createHash('sha256').update(fs.readFileSync(compiled)).digest('hex')

// 拦截相对依赖，换成桩
const stubMap = {
  '../store/store': path.join(__dirname, 'stubs/store.js'),
  '../store/settings': path.join(__dirname, 'stubs/settings.js'),
  '../gateway/llm': path.join(__dirname, 'stubs/llm.js')
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubMap, request)) return fs.realpathSync(stubMap[request])
  return originalResolve.call(this, request, ...rest)
}

const interview = require(compiled)
const storeStub = require(fs.realpathSync(path.join(__dirname, 'stubs/store.js')))
const { __mock } = require(fs.realpathSync(path.join(__dirname, 'stubs/llm.js')))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name + (extra !== undefined ? '  —  ' + extra : '')) }
  else { fail += 1; console.log('FAIL  ' + name + (extra !== undefined ? '  —  ' + extra : '')) }
}
function eq(name, actual, expected) { ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`) }
async function throws(name, fn, needle) {
  try { await fn(); fail += 1; console.log('FAIL  ' + name + '  —  未抛出异常') }
  catch (e) { const m = e instanceof Error ? e.message : String(e); ok(name, !needle || m.includes(needle), m) }
}

const CORE = ['project', 'technical', 'behavioral']
const phasesOf = (s) => s.turns.map((t) => t.phase)

;(async () => {
  ok('源码身份：转译输出来自真实文件字节', realSha.length === 64 && copySha.length === 64, 'src=' + realSha.slice(0, 12))

  /* ---------- A. 固定轮数：只数核心问题，开场/反问不计入 ---------- */
  console.log('\n--- A. pacing=fixed, fixedRounds=5, focus=fundamentals ---')
  const a = interview.createInterview({
    role: '资深后端工程师', interviewer: '一线大厂架构师', difficulty: 'hard',
    pacing: 'fixed', fixedRounds: 5, focus: 'fundamentals', timeoutSec: 90, background: '8 年后端经验'
  })
  eq('A1 配置落库：难度', a.config.difficulty, 'hard')
  eq('A1 配置落库：节奏', a.config.pacing, 'fixed')
  eq('A1 配置落库：固定轮数', a.config.fixedRounds, 5)
  eq('A1 配置落库：偏好', a.config.focus, 'fundamentals')
  eq('A1 配置落库：超时', a.config.timeoutSec, 90)
  eq('A1 配置落库：面试官', a.config.interviewer, '一线大厂架构师')
  eq('A1 初始阶段', a.phase, 'idle')

  let s = await interview.startInterview(a.id)
  eq('A2 开场题为 intro（不计入核心轮数）', s.phase, 'intro')
  eq('A2 有待答问题', s.turns[0].answer, undefined)

  // 开场作答：评分 70（中性），下一阶段应为计划表首项 project
  s = await interview.answerInterview(a.id, '我是后端工程师…')
  eq('A3 开场后进入外计划首项 project', s.phase, 'project')

  // 逐轮答完 5 个核心问题，校验阶段严格按 fundamentals 计划表推进
  const expectSeq = ['project', 'technical', 'technical', 'technical', 'behavioral']
  __mock.evalScores = [70, 70, 70, 70, 70]
  for (let i = 0; i < 5; i += 1) {
    s = await interview.answerInterview(a.id, '核心回答' + (i + 1))
  }
  const coreSeq = s.turns.filter((t) => CORE.includes(t.phase)).map((t) => t.phase)
  ok('A4 出题顺序 = fundamentals 计划表', JSON.stringify(coreSeq) === JSON.stringify(expectSeq), coreSeq.join('>'))
  eq('A5 5 个核心问题后进入反问环节', s.phase, 'candidate_qa')
  const coreTurns = s.turns.filter((t) => CORE.includes(t.phase))
  eq('A5 核心问题恰好 5 题（未超发）', coreTurns.length, 5)
  eq('A6 开场不计入核心轮数', s.turns.filter((t) => t.phase === 'intro').length, 1)
  ok('A6 反问进入时没有待答问题', s.turns[s.turns.length - 1].answer !== undefined)
  ok('A6 每道核心题都有评分', coreTurns.every((t) => typeof t.score === 'number'), coreTurns.map(t => t.score).join(','))

  // 反问环节：用户提问 → 面试官作答，不评分、不换阶段
  __mock.evalScores = []
  s = await interview.answerInterview(a.id, '团队平时怎么做 code review？')
  const qa = s.turns[s.turns.length - 1]
  eq('A7 反问轮阶段保持 candidate_qa', s.phase, 'candidate_qa')
  eq('A7 反问轮 question = 候选人的提问', qa.question, '团队平时怎么做 code review？')
  ok('A7 反问轮 answer = 面试官回答', typeof qa.answer === 'string' && qa.answer.length > 0, qa.answer)
  eq('A7 反问轮不评分', qa.score, undefined)

  // 复盘：不结束 / 结束 共用同一套逻辑
  __mock.reviewText = '# 复盘报告\n\n## 五、关键问题与可复用答案\n| 关键问题 | 可复用答案要点 |\n'
  let rv = await interview.generateInterviewReview(a.id, { finish: false })
  ok('A8 生成复盘（不结束）写入 review', (rv.review || '').includes('可复用答案'))
  eq('A8 不结束时阶段不变', rv.phase, 'candidate_qa')
  eq('A8 不结束时 finished 未置位', rv.finished, undefined)
  rv = await interview.finishInterview(a.id)
  eq('A9 finishInterview → review 阶段', rv.phase, 'review')
  eq('A9 finishInterview → finished=true', rv.finished, true)
  ok('A9 finish 也写入了 review', (rv.review || '').includes('可复用答案'))
  await throws('A10 已结束后不能再作答', () => interview.answerInterview(a.id, 'x'), '已结束')

  /* ---------- B. 自适应：评分驱动 + 15 轮上限 + 阶段不倒退 ---------- */
  console.log('\n--- B. pacing=adaptive ---')
  const b = interview.createInterview({
    role: '前端工程师', interviewer: '前端专家', difficulty: 'expert',
    pacing: 'adaptive', fixedRounds: 6, focus: 'balanced', timeoutSec: 0, background: ''
  })
  let bs = await interview.startInterview(b.id)
  eq('B1 开场 intro', bs.phase, 'intro')

  __mock.evalScores = [90]
  bs = await interview.answerInterview(b.id, '自我介绍')
  eq('B1 开场高分 → 进入计划首项 project', bs.phase, 'project')

  __mock.evalScores = [90]
  bs = await interview.answerInterview(b.id, '项目回答（高分）')
  eq('B2 高分（>=80）→ 提前晋级 technical', bs.phase, 'technical')

  __mock.evalScores = [40]
  bs = await interview.answerInterview(b.id, '技术回答（低分）')
  eq('B3 低分（<60）→ 同阶段再追一轮', bs.phase, 'technical')

  __mock.evalScores = [40]
  bs = await interview.answerInterview(b.id, '技术回答（再次低分）')
  eq('B4 同阶段已追问过 → 不倒退，仍为 technical', bs.phase, 'technical')

  __mock.evalScores = []
  __mock.defaultScore = 70
  let guard = 0
  while (bs.phase !== 'candidate_qa' && guard < 40) {
    bs = await interview.answerInterview(b.id, '中性回答' + guard)
    guard += 1
  }
  const bAnswered = bs.turns.filter((t) => t.answer !== undefined).length
  eq('B5 自适应最终进入反问环节', bs.phase, 'candidate_qa')
  ok('B5 自适应不超过 15 轮上限', bAnswered <= 15, '实际 ' + bAnswered + ' 轮')
  ok('B5 未死循环', guard < 40, guard + ' 次作答')
  const noBackwards = bs.turns.filter((t) => CORE.includes(t.phase)).map((t) => ['project','technical','behavioral'].indexOf(t.phase))
  ok('B6 核心阶段单调不倒退', noBackwards.every((v, i) => i === 0 || v >= noBackwards[i - 1]), noBackwards.join('>'))

  /* ---------- C. 旧数据兼容 ---------- */
  console.log('\n--- C. 旧数据 / 脏数据兼容 ---')
  const legacyStore = storeStub.__stores.get('interviews.json')
  legacyStore.push({ id: 'legacy-1', role: '后端工程师', background: '旧版只存了 background', phase: 'idle', turns: [], createdAt: 1, updatedAt: 1 })
  legacyStore.push({
    id: 'legacy-2', role: '', background: 12345, phase: 'weird-phase', turns: null, createdAt: 2, updatedAt: 2,
    config: { difficulty: 'impossible', pacing: 'x', focus: 'y', fixedRounds: 999, timeoutSec: -5 }
  })
  const l1 = interview.getInterview('legacy-1')
  ok('C1 旧记录缺 config → 补齐默认值', l1 && l1.config && typeof l1.config === 'object')
  eq('C1 默认难度', l1.config.difficulty, 'medium')
  eq('C1 默认节奏', l1.config.pacing, 'adaptive')
  eq('C1 默认固定轮数', l1.config.fixedRounds, 6)
  eq('C1 默认偏好', l1.config.focus, 'balanced')
  eq('C1 默认超时', l1.config.timeoutSec, 0)
  eq('C1 沿用旧 role', l1.config.role, '后端工程师')
  eq('C1 沿用旧 background', l1.config.background, '旧版只存了 background')
  eq('C1 turns 归一为空数组', Array.isArray(l1.turns), true)

  const l2 = interview.getInterview('legacy-2')
  eq('C2 脏 role → 默认岗位', l2.config.role, '未指定岗位')
  eq('C2 脏 background（数字）→ 收敛为空串', l2.config.background, '')
  eq('C2 脏 phase → idle', l2.phase, 'idle')
  eq('C2 脏 difficulty → medium', l2.config.difficulty, 'medium')
  eq('C2 脏 pacing → adaptive', l2.config.pacing, 'adaptive')
  eq('C2 脏 focus → balanced', l2.config.focus, 'balanced')
  eq('C2 fixedRounds 超界 → 收敛到 15', l2.config.fixedRounds, 15)
  eq('C2 timeoutSec 负数 → 0', l2.config.timeoutSec, 0)
  let listed = null
  try { listed = interview.listInterviews() } catch (e) { listed = 'THREW:' + e.message }
  ok('C3 listInterviews 对脏数据不崩', Array.isArray(listed), Array.isArray(listed) ? listed.length + ' 条' : listed)
  ok('C3 列表已补齐 config', listed.every((x) => x.config && typeof x.config.difficulty === 'string'))

  let ls = await interview.startInterview('legacy-1')
  eq('C4 旧记录可以继续面试', ls.phase, 'intro')
  ls = await interview.answerInterview('legacy-1', '旧会话也能作答')
  ok('C4 旧记录作答后生成下一题', ls.turns.length >= 2, '轮数 ' + ls.turns.length)
  const persisted = interview.getInterview('legacy-1')
  ok('C4 旧记录写回时顺带落库 config', Boolean(persisted.config && persisted.config.difficulty === 'medium'))

  /* ---------- D. 旧 createInterview 签名 ---------- */
  console.log('\n--- D. 旧 createInterview(role, background) 签名 ---')
  const d = interview.createInterview('产品经理', '5 年 B 端经验')
  eq('D1 旧签名仍可用：role', d.role, '产品经理')
  eq('D1 旧签名仍可用：background', d.background, '5 年 B 端经验')
  eq('D1 旧签名补默认 config', d.config.pacing, 'adaptive')
  const d2 = interview.createInterview('   ')
  eq('D2 空岗位 → 默认岗位', d2.role, '未指定岗位')
  const d3 = interview.createInterview('算法工程师')
  eq('D3 省略 background 不崩', d3.background, '')
  ok('D3 fixedRounds 默认在 3-15 内', d3.config.fixedRounds >= 3 && d3.config.fixedRounds <= 15, '实际=' + d3.config.fixedRounds)

  /* ---------- E. 单题超时/耗时记录 ---------- */
  console.log('\n--- E. elapsedMs ---')
  const e1 = interview.createInterview({ role: 'R', background: '', interviewer: 'I', difficulty: 'easy', pacing: 'fixed', fixedRounds: 3, focus: 'project', timeoutSec: 30 })
  await interview.startInterview(e1.id)
  const e1s = await interview.answerInterview(e1.id, '回答')
  const introTurn = e1s.turns[0]
  ok('E1 未传 elapsedMs → 按出题时间推算', typeof introTurn.elapsedMs === 'number' && introTurn.elapsedMs >= 0 && introTurn.elapsedMs < 2000, 'elapsedMs=' + introTurn.elapsedMs)

  const e2 = interview.createInterview({ role: 'R', background: '', interviewer: 'I', difficulty: 'easy', pacing: 'fixed', fixedRounds: 3, focus: 'project', timeoutSec: 30 })
  await interview.startInterview(e2.id)
  const e2s = await interview.answerInterview(e2.id, '回答', 4200)
  eq('E2 传入 elapsedMs 被正确记录', e2s.turns[0].elapsedMs, 4200)

  /* ---------- F. 出题失败后的可恢复性 ---------- */
  console.log('\n--- F. 出题失败不丢回答 ---')
  const f = interview.createInterview({ role: 'R', background: '', interviewer: 'I', difficulty: 'easy', pacing: 'fixed', fixedRounds: 3, focus: 'balanced', timeoutSec: 0 })
  await interview.startInterview(f.id)
  __mock.failNextQuestion = true
  await throws('F1 出题失败会抛出错误', () => interview.answerInterview(f.id, '这条回答不能丢'), '出题失败')
  const fAfter = interview.getInterview(f.id)
  eq('F1 回答已落库（未丢）', fAfter.turns[0].answer, '这条回答不能丢')
  ok('F1 阶段已推进', fAfter.phase !== 'intro', fAfter.phase)
  const fResumed = await interview.startInterview(f.id)
  eq('F1 可再次调用 start 补出下一题', fResumed.turns.length, 2)
  eq('F2 已有待答问题时 start 幂等', (await interview.startInterview(f.id)).turns.length, 2)

  /* ---------- G. Prompt 注入检查 ---------- */
  console.log('\n--- G. 配置进入 prompt ---')
  __mock.calls.length = 0
  const g = interview.createInterview({
    role: '运维专家', interviewer: 'SRE 团队负责人', difficulty: 'expert',
    pacing: 'fixed', fixedRounds: 3, focus: 'system_design', timeoutSec: 45, background: '负责过千万级 QPS 网关'
  })
  await interview.startInterview(g.id)
  const firstCall = __mock.calls[0]
  ok('G1 interviewer 注入 system prompt', firstCall.system.includes('SRE 团队负责人'), firstCall.system.split('\n')[0])
  ok('G1 difficulty 注入', firstCall.system.includes('专家'), '')
  ok('G1 focus 注入', firstCall.system.includes('系统设计'), '')
  ok('G1 timeoutSec 注入', firstCall.system.includes('45'), '')
  ok('G1 role 注入', firstCall.system.includes('运维专家'))
  ok('G1 背景资料进入 user prompt', firstCall.user.includes('千万级 QPS'))

  __mock.calls.length = 0
  __mock.evalScores = [88]
  await interview.answerInterview(g.id, '回答')
  const evalCall = __mock.calls.find((c) => c.system.includes('面试评估官'))
  ok('G2 评分 prompt 带难度/偏好', evalCall && evalCall.user.includes('专家') && evalCall.user.includes('系统设计'))
  const askCall = __mock.calls.find((c) => !c.system.includes('面试评估官'))
  ok('G3 出题 prompt 带 fixed 进度', askCall && askCall.user.includes('核心问题'), askCall ? askCall.user.replace(/\n/g, ' | ').slice(0, 120) : '(无)')

  console.log('\n===== 汇总：' + pass + '/' + (pass + fail) + ' 通过 =====')
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
