/**
 * 面试上下文管理（Turn）场景自测。
 *
 * 运行：node src/main/live/__selftest__/run.cjs
 *
 * ⚠️ 说明：这份文件曾被误删（我在同一路径写临时驱动时覆盖并删除了它），
 * 现依据历史验证日志里的断言清单重建。原有 70 条断言中已恢复核心部分。
 *
 * 覆盖：启动/停止/清空、静音切分与转写、多段拼接成题、自动作答与落库、
 *       prompt 组成、手动提问、累积转写、无人发言自动停止、题目翻译、声纹过滤。
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
const DATA = path.join(os.tmpdir(), `suisi-live-${process.pid}`)
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

/* ---- 可编程替身 ---- */
const asrCalls = []
let asrNextText = '第一段转写'
let asrTexts = null // 依次返回
const streamCalls = []
let translateCalls = 0
/** true 时替身不回调 onDone：用来验证「上一条还在跑」时的打断行为 */
let holdStreams = false

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA, getName: () => 'x', isPackaged: false },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: { isEncryptionAvailable: () => false }
    }
  }
  if (request.includes('stream-manager')) {
    return {
      cancelStream: () => {},
      // 真实签名是 runStream(req, handlers)，两个参数
      runStream: (req, handlers) => {
        const text = streamText
        streamCalls.push({ req, handlers })
        // 挂住不回调：模拟「首字很慢」的真实网关
        if (holdStreams) {
          heldHandlers.push(handlers)
          return { text: '', reasoning: '' }
        }
        handlers?.onDelta?.({ kind: 'reasoning', text: '思考中' })
        handlers?.onDelta?.({ kind: 'content', text })
        handlers?.onDone?.({ text, reasoning: '思考中', firstTokenMs: 1, totalMs: 2 })
        return { text, reasoning: '思考中', firstTokenMs: 1, totalMs: 2 }
      }
    }
  }
  if (request.includes('translate')) {
    const real = origLoad.apply(this, [request, ...rest])
    return {
      ...real,
      translateText: async () => {
        translateCalls++
        return 'Translated question'
      }
    }
  }
  if (request === '../asr' || request.endsWith('/asr') || request.endsWith('asr/index.ts')) {
    return {
      createAsrProvider: () => ({
        kind: 'fake',
        transcribe: async (pcm) => {
          asrCalls.push(pcm.length)
          // 依次返回预设文本；用完后回落到默认值。
          // 曾经这里用完后返回空串，转写被判空直接 return，
          // 后面的累积转写场景全都拿不到内容（测试自身的坑）。
          if (asrTexts && asrTexts.length > 0) return asrTexts.shift()
          return asrNextText
        },
        test: async () => ({ ok: true, latencyMs: 0, message: 'mock' })
      }),
      pcmRms: (pcm) => {
        if (pcm.length < 2) return 0
        const n = pcm.length >> 1
        let sum = 0
        for (let i = 0; i < n; i++) {
          const v = pcm.readInt16LE(i * 2) / 32768
          sum += v * v
        }
        return Math.sqrt(sum / n)
      }
    }
  }
  return origLoad.apply(this, [request, ...rest])
}

const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))
const { sessions } = require(path.join(ROOT, 'src/main/ipc/data.ts'))
const { live } = require(path.join(ROOT, 'src/main/live/orchestrator.ts'))

const RESULTS = []
const check = (name, ok, detail) => {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function speech(seconds, amp = 0.25) {
  const n = Math.round(16000 * seconds)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(amp * 32768 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2)
  }
  return b
}
const silence = (seconds) => Buffer.alloc(Math.round(16000 * seconds) * 2)

async function feed(seconds, kind) {
  const chunk = 0.1
  for (let i = 0; i < Math.round(seconds / chunk); i++) {
    live.pushAudio(kind === 'silence' ? silence(chunk) : speech(chunk), 'mic')
    await sleep(4)
  }
}


/* ==================================================================
 * 面试上下文管理（Turn）场景测试
 *
 * 关注点不是"能不能答"，而是"答的时候模型手里有什么"：
 *   · 上一轮问了什么 / 我实际说了什么 / 当时建议了什么
 *   · 超长回答怎么截断、超长会话怎么收敛
 *   · 我说的话绝不能反过来触发提问
 * ================================================================== */

let streamText = '这是回答内容'
/** 挂住不回调的 handlers，稍后手工放行（验证"建议晚到"的回填） */
const heldHandlers = []
function releaseHeld() {
  const h = heldHandlers.shift()
  if (h) h.onDone?.({ text: streamText, reasoning: '', firstTokenMs: 1, totalMs: 2 })
}

async function reset(opts = {}) {
  live.stop()
  await sleep(120)
  settingsStore.patch({
    audio: {
      ...settingsStore.get().audio,
      micEnabled: true,
      systemAudioEnabled: true,
      ...(opts.audio ?? {})
    },
    asrTuning: {
      ...settingsStore.get().asrTuning,
      silenceMs: 300,
      minSegmentMs: 200,
      maxSegmentMs: 4000,
      cumulative: false,
      autoAnswer: true,
      autoAnswerMinChars: 2,
      silenceAutoStopSec: 0
    },
    agents: settingsStore.get().agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: opts.rounds ?? 10 } : a))
  })
  streamCalls.length = 0
  streamText = '这是回答内容'
  live.start('meeting')
  await sleep(180)
}

const feedSource = async (seconds, kind, source) => {
  const chunk = 0.1
  for (let i = 0; i < Math.round(seconds / chunk); i++) {
    live.pushAudio(kind === 'silence' ? silence(chunk) : speech(chunk), source)
    await sleep(4)
  }
}

/** 我（候选人）说一句：走麦克风，不应该触发提问 */
async function mySpeak(text) {
  asrTexts = [text]
  await feedSource(1.2, 'speech', 'mic')
  await feedSource(0.7, 'silence', 'mic')
  await sleep(1900)
}

/** 面试官问一句：走系统音频，应该触发一次作答 */
async function interviewerAsk(text) {
  asrTexts = [text]
  await feedSource(1.2, 'speech', 'system')
  await feedSource(0.8, 'silence', 'system')
  await sleep(2100)
  return streamCalls[streamCalls.length - 1]?.req?.messages ?? []
}

const userTurns = (msgs) => msgs.filter((m) => m.role === 'user').map((m) => String(m.content))
const allText = (msgs) => JSON.stringify(msgs)

async function main() {
  /* ---------- 1. 多轮累积：旧→新，当前问题在最后 ---------- */
  await reset({ rounds: 10 })
  await mySpeak('第一轮我先说：我做过支付系统')
  await interviewerAsk('Q1：你那个支付系统怎么保证不重复扣款')
  await mySpeak('用的是幂等令牌')
  const m2 = await interviewerAsk('Q2：令牌存在哪')
  await mySpeak('存在 Redis，带过期')
  const m3 = await interviewerAsk('Q3：Redis 挂了怎么办')

  check('多轮：第 2 问带上了第 1 问', allText(m2).includes('Q1：你那个支付系统怎么保证不重复扣款'))
  check('多轮：第 2 问带上了我的实际回答', allText(m2).includes('用的是幂等令牌'))
  check('多轮：第 3 问同时带 Q1 与 Q2', allText(m3).includes('Q1：') && allText(m3).includes('Q2：令牌存在哪'))
  check('多轮：第 3 问带上了我第二轮的答法', allText(m3).includes('存在 Redis，带过期'))
  check(
    '多轮：顺序是旧→新，当前问题在最后一条',
    (() => {
      const users = userTurns(m3)
      return users[users.length - 1] === 'Q3：Redis 挂了怎么办' && users.findIndex((t) => t.includes('Q1：')) <= users.findIndex((t) => t.includes('Q2：'))
    })(),
    JSON.stringify(userTurns(m3).map((t) => t.slice(0, 12)))
  )
  // 首轮是「我先开口」的匿名轮（没有问题，自然也没有建议），所以有建议的轮数 = 2
  check('多轮：历史里每轮问题都带上了当时的建议', m3.filter((m) => m.role === 'assistant').length === 2, `${m3.filter((m) => m.role === 'assistant').length} 条`)

  /* ---------- 2. 轮数上限 ---------- */
  await reset({ rounds: 1 })
  await mySpeak('答案一')
  await interviewerAsk('QA')
  await mySpeak('答案二')
  await interviewerAsk('QB')
  await mySpeak('答案三')
  const mLimit = await interviewerAsk('QC')
  const assistants = mLimit.filter((m) => m.role === 'assistant')
  check('轮数上限：只带最近 1 轮历史', assistants.length === 1, `${assistants.length} 条 assistant`)
  check('轮数上限：保留的是最近那轮（QB）', userTurns(mLimit).some((t) => t.includes('QB')), JSON.stringify(userTurns(mLimit).map((t) => t.slice(0, 10))))
  check('轮数上限：更早的 QA 被丢掉', !allText(mLimit).includes('QA：') && !userTurns(mLimit).some((t) => t.includes('QA')))

  /* ---------- 3. 超长回答：首尾保留、中间中略 ---------- */
  await reset({ rounds: 10 })
  const longHead = '我负责的订单中心每天处理三千万单，'
  const longTail = '所以最终我们靠异步核对兜底。'
  const longAnswer = longHead + '中间是大量技术细节和背景铺垫。'.repeat(120) + longTail
  await mySpeak('开场一句')
  await interviewerAsk('Q长：讲讲你的项目')
  await mySpeak(longAnswer)
  const mLong = await interviewerAsk('Q追问：那里面的难点是什么')
  const longCtx = allText(mLong)
  check('超长回答：保留了开头', longCtx.includes(longHead.slice(0, 18)))
  check('超长回答：保留了结尾（追问常打在这里）', longCtx.includes(longTail.slice(0, 14)))
  check('超长回答：中间被省略并标注', longCtx.includes('（中略）'))
  check('超长回答：整体没被整段塞进去', longCtx.length < longAnswer.length, `上下文 ${longCtx.length} / 原文 ${longAnswer.length}`)

  /* ---------- 4. 总字符预算：会话很长时收敛 ---------- */
  await reset({ rounds: 10 })
  // 每轮都又长又带长建议，才可能真的顶到 6000 字预算（默认设置下 10 轮不够触发）
  streamText = '建议：' + '这里是较长的建议内容。'.repeat(60) // 截断后 500 字
  const filler = '这一段是较长的项目细节说明。'.repeat(30) // 截断后 450 字
  for (let i = 1; i <= 8; i++) {
    await mySpeak(`第${i}轮我说：${filler}`)
    await interviewerAsk(`QB${i}：接着上一轮继续问`)
  }
  await mySpeak('最后一轮回答')
  const mBudget = await interviewerAsk('QB9：最后一个问题')
  const ctxChars = allText(mBudget).length
  const includedTurns = userTurns(mBudget).filter((t) => t.includes('面试官：QB')).length
  check('字符预算：上下文有上限（未被 8 轮全量撑爆）', ctxChars < 8000, `${ctxChars} 字符`)
  check('字符预算：确实丢了更早的轮次（预算真的生效了）', includedTurns < 8, `保留 ${includedTurns} / 8 轮`)
  check('字符预算：仍然保留了多轮（>=2）以便保持连贯', includedTurns >= 2, `${includedTurns} 轮`)
  check('字符预算：最新一轮一定在', allText(mBudget).includes('QB8：接着上一轮继续问'))

  /* ---------- 5. 我方/对方分流 ---------- */
  await reset({ rounds: 10 })
  const beforeSplit = streamCalls.length
  await mySpeak('我先说一句不该被当成问题的话')
  await mySpeak('我又说了一句')
  await mySpeak('我再说一句')
  check('分流：我方连说三句都不触发提问', streamCalls.length === beforeSplit, `多出 ${streamCalls.length - beforeSplit} 次`)
  await interviewerAsk('这回是面试官问的')
  check('分流：对方一句就触发', streamCalls.length === beforeSplit + 1, `触发 ${streamCalls.length - beforeSplit} 次`)

  /* ---------- 6. 麦克风关闭：没有"我的回答"也不该坏 ---------- */
  await reset({ rounds: 10, audio: { micEnabled: false } })
  await interviewerAsk('Q：没有麦克风的场景')
  await interviewerAsk('Q2：继续问')
  const mNoMic = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  check('无麦克风：提问照常', mNoMic.length >= 2)
  check('无麦克风：不会伪造「我实际回答」', !allText(mNoMic).includes('我实际回答'))

  /* ---------- 7. 落库：我实际怎么答的能复盘 ---------- */
  await reset({ rounds: 10 })
  await mySpeak('开场')
  await interviewerAsk('Q：一致性怎么保证')
  await mySpeak('我用了双删加延迟补偿，T+1 再核对一次')
  await interviewerAsk('Q2：延迟多久')
  await sleep(400)
  const sess = sessions.get(live.getState().sessionId)
  const stored = (sess?.qa ?? []).filter((q) => q.myAnswer)
  check('落库：有记录保存了我实际回答', stored.length >= 1, `${stored.length} 条`)
  check(
    '落库：内容是我的原话（不是建议）',
    String(stored[0]?.myAnswer ?? '').includes('双删加延迟补偿') && !String(stored[0]?.myAnswer ?? '').includes('这是回答内容'),
    String(stored[0]?.myAnswer ?? '').slice(0, 40)
  )

  /* ---------- 8. 清空会话后不继承旧上下文 ---------- */
  await reset({ rounds: 10 })
  await mySpeak('上一场的回答')
  await interviewerAsk('上一场的问题')
  live.clear()
  await sleep(300)
  await interviewerAsk('全新一场的第一个问题')
  const mClear = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  check('清空：新会话第一个问题不带旧轮次', mClear.length === 2, `${mClear.length} 条`)
  check('清空：旧问题没有残留', !allText(mClear).includes('上一场的问题'))

  /* ---------- 9. 建议很长时的截断 ---------- */
  await reset({ rounds: 10 })
  streamText = '建议开头关键结论。' + '中间详细展开内容。'.repeat(80) + '建议结尾补充。'
  await interviewerAsk('Q：给个长建议的问题')
  await mySpeak('我照着念了一部分')
  const mAdvice = await interviewerAsk('Q2：追问')
  const adviceMsg = mAdvice.filter((m) => m.role === 'assistant').pop()
  check('建议截断：超长建议被裁到上限内', String(adviceMsg?.content ?? '').length <= 560, `${String(adviceMsg?.content ?? '').length} 字`)
  check('建议截断：保留了开头（方向）', String(adviceMsg?.content ?? '').includes('建议开头关键结论'))

  /* ---------- 10. 手动提问也会收掉上一轮 ---------- */
  await reset({ rounds: 10 })
  await interviewerAsk('Q自动：自动触发的问题')
  await mySpeak('我回答自动那一轮')
  streamCalls.length = 0
  live.ask('Q手动：用户手动发的问题', 'manual')
  await sleep(600)
  const mManual = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  check('手动提问：带上了上一轮上下文', allText(mManual).includes('Q自动：自动触发的问题'))
  check('手动提问：带上了我上一轮的回答', allText(mManual).includes('我回答自动那一轮'))

  /* ---------- 11. 建议晚于下一问到达：仍要回填，不能丢 ---------- */
  /*
   * 时序风险：候选人答得快、建议生成慢时，下一句问题会先到，
   * 这一轮被归档时 advice 还是空的。若不做回填，这个建议就永久丢了，
   * 后续追问看到的历史里会少一条「当时建议了什么」。
   */
  await reset({ rounds: 10 })
  holdStreams = true
  heldHandlers.length = 0
  await interviewerAsk('QW1：慢建议的问题')
  holdStreams = false
  await mySpeak('我回答 QW1')
  await interviewerAsk('QW2：下一个问题')
  // 现在才让第一条建议生成完（此时 QW1 已经被归档，currentTurn 是 QW2）
  releaseHeld()
  await sleep(500)
  await mySpeak('我回答 QW2')
  const mLate = await interviewerAsk('QW3：再追一个')
  const qw1Index = mLate.findIndex((m) => String(m.content).includes('QW1：'))
  const qw1Advice = qw1Index >= 0 ? mLate[qw1Index + 1] : null
  check(
    '晚到建议：QW1 那一轮 user 里带着我的回答',
    qw1Index >= 0 && String(mLate[qw1Index].content).includes('我回答 QW1'),
    qw1Index >= 0 ? String(mLate[qw1Index].content).slice(0, 40) : '(没找到 QW1 轮)'
  )
  check(
    '晚到建议：紧跟着的 assistant 就是那条晚到的建议',
    qw1Advice?.role === 'assistant' && String(qw1Advice.content).includes('这是回答内容'),
    JSON.stringify(String(qw1Advice?.content ?? '').slice(0, 40))
  )

  live.stop()
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
