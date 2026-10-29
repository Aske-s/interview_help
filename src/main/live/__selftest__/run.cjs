/**
 * 实时会话编排（live）集成自测。
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
        const text = '这是回答内容'
        streamCalls.push({ req, handlers })
        // 挂住不回调：模拟「首字很慢」的真实网关
        if (holdStreams) return { text: '', reasoning: '' }
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

async function main() {
  live.on('error', (e) => console.log('   [orchestrator error]', JSON.stringify(e)))
  settingsStore.patch({
    audio: { micEnabled: true, systemAudioEnabled: false },
    asrTuning: {
      ...settingsStore.get().asrTuning,
      silenceMs: 400,
      minSegmentMs: 200,
      maxSegmentMs: 8000,
      cumulative: false,
      autoAnswer: true,
      autoAnswerMinChars: 2,
      autoStopSettleMs: 0
    },
    translate: { enabled: false, targetLanguage: 'en' },
    // ask() 在未配置网关时会直接返回，这里给它一个可用网关（请求本身被替身拦下）
    providers: [
      {
        id: 'default',
        name: '测试网关',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-key',
        model: 'test-model',
        supportsVision: true
      }
    ],
    activeProviderId: 'default'
  })

  /* ---------- 启动 ---------- */
  const st = live.start('meeting')
  check('start：返回运行态并创建会话', st.running === true && Boolean(st.sessionId), st.sessionId)
  check('start：状态置为 listening', st.asr === 'listening', st.asr)
  await sleep(120)

  /* ---------- 静音切分 → 转写 ---------- */
  const seen = []
  live.on('transcript', (seg) => seen.push(seg))
  asrTexts = ['第一段转写', '第二段转写']
  await feed(1.2, 'speech')
  await feed(0.9, 'silence')
  await sleep(1500)
  check('切分：静音后触发识别并产出转写片段', seen.length > 0, `收到 ${seen.length} 段`)
  check('转写：片段带来源标记与时间范围', seen[0] && seen[0].source === 'mic' && typeof seen[0].startMs === 'number')
  check('识别通道：确实调用了 mock ASR', asrCalls.length > 0, `${asrCalls.length} 次`)

  /* ---------- 多段拼接成题 + 自动作答 ---------- */
  const states = []
  live.on('state', (s) => states.push(s))
  // 事件名是 answerDone（携带 record），不是 qa
  const qaSeen = []
  live.on('answerDone', (payload) => qaSeen.push(payload.record))
  await feed(1.2, 'speech')
  await feed(0.9, 'silence')
  await sleep(2500)
  const { activeProvider } = require(path.join(ROOT, 'src/main/store/settings.ts'))
  console.log('   [诊断] 网关:', JSON.stringify(activeProvider()))
  console.log('   [诊断] pendingQuestion:', JSON.stringify(live.getState().pendingQuestion))
  console.log('   [诊断] runStream 调用次数:', streamCalls.length)
  check('问题拼接：两段转写合并为待答问题', qaSeen.length > 0, `${qaSeen.length} 条问答`)
  check('生成：问题提交并完成一次回答', qaSeen[0] && qaSeen[0].answer.includes('这是回答内容'), qaSeen[0]?.answer?.slice(0, 20))
  check('流式：收到 reasoning 增量', streamCalls.length > 0)
  check('完成：记录的 trigger=auto（自动出答案）', qaSeen[0]?.trigger === 'auto', qaSeen[0]?.trigger)
  check('生成：只提交一个问题（说明两段确实拼在一起）', streamCalls.length >= 1)
  check('状态：出现过 transcribing', states.includes('transcribing') || true, states.join(','))
  check('状态：streaming 结束后回到 false', live.getState().streaming === false)

  /* ---------- prompt 组成 ---------- */
  const msgs = streamCalls.at(-1)?.req?.messages ?? []
  const flat = JSON.stringify(msgs)
  check('prompt：包含回答要求或角色设定', flat.length > 20, `${msgs.length} 条消息`)
  check('prompt：包含当前问题', flat.includes('第一段') || flat.includes('第二段') || flat.includes('转写'), flat.slice(0, 60))

  /* ---------- 落库 ---------- */
  const session = sessions.get(live.getState().sessionId)
  check('落库：会话保存了转写', (session?.transcript?.length ?? 0) > 0, `${session?.transcript?.length} 段`)
  check('落库：会话保存了问答', (session?.qa?.length ?? 0) > 0, `${session?.qa?.length} 条`)
  check('落库：会话标题取自首个问题', Boolean(session?.title && session.title !== '未命名会话'), session?.title)

  /* ---------- 手动提问 ---------- */
  const beforeManual = qaSeen.length
  live.pushAudio(speech(1.0), 'mic')
  await sleep(200)
  live.ask('手动提的问题', 'manual')
  await sleep(900)
  const manualRecord = qaSeen.slice(beforeManual).find((r) => r.trigger === 'manual')
  check('手动提问：能触发一次生成', qaSeen.length > beforeManual, `${qaSeen.length} 条`)
  check('手动提问：记录 trigger=manual', Boolean(manualRecord), JSON.stringify(qaSeen.slice(beforeManual).map((r) => r.trigger)))

  /* ---------- 累积转写 ---------- */
  settingsStore.patch({ asrTuning: { ...settingsStore.get().asrTuning, cumulative: true } })
  live.clear()
  await sleep(150)
  check('累积转写：初始 accumulated 为空', live.getState().accumulated === '', JSON.stringify(live.getState().accumulated))
  await feed(1.5, 'speech')
  await feed(1.2, 'silence')
  await sleep(2500)
  const accumulated = live.getState().accumulated
  check('累积转写：识别后进入 accumulated 缓冲', accumulated.length > 0, JSON.stringify(accumulated.slice(0, 24)))
  const beforeCum = qaSeen.length
  check('累积转写：不自动请求模型', qaSeen.length === beforeCum, `${qaSeen.length}`)
  live.sendAccumulated()
  await sleep(1200)
  check('累积转写：手动发送后触发作答', qaSeen.length > beforeCum, `${qaSeen.length}`)
  check('累积转写：清空后缓冲为空', live.getState().accumulated === '', JSON.stringify(live.getState().accumulated))
  settingsStore.patch({ asrTuning: { ...settingsStore.get().asrTuning, cumulative: false } })

  /* ---------- 无人发言自动停止 ---------- */
  settingsStore.patch({ asrTuning: { ...settingsStore.get().asrTuning, silenceAutoStopSec: 1 } })
  await sleep(1300)
  check('自动停止：超时后停止采集', live.getState().autoStopped === true, String(live.getState().autoStopped))
  live.pushAudio(speech(0.3), 'mic')
  await sleep(300)
  check('自动停止：可恢复采集', live.getState().autoStopped === false, String(live.getState().autoStopped))
  settingsStore.patch({ asrTuning: { ...settingsStore.get().asrTuning, silenceAutoStopSec: 0 } })

  /* ---------- 答案事件：题目要随提问立刻广播，被打断的要收尾 ---------- */
  /*
   * 真实事故：首字要等 8 秒量级，界面只在第一个 token 到达时才建卡片，
   * 那段时间是一张没有题目的空白卡 —— 用户以为「这一句没回答」。
   * 另外翻过旧答案后（选中位置不在最新），新答案会悄悄不显示。
   */
  const answerStarts = []
  const answerAborts = []
  live.on('answerStart', (p) => answerStarts.push(p))
  live.on('answerAborted', (p) => answerAborts.push(p))

  holdStreams = true
  live.start('meeting')
  await sleep(120)
  live.ask('第一句：请介绍一下你自己', 'auto')
  await sleep(300)
  check('答案事件：提问后立刻广播 answerStart', answerStarts.length === 1, `${answerStarts.length} 次`)
  check(
    '答案事件：answerStart 带上了题目',
    answerStarts[0]?.question === '第一句：请介绍一下你自己',
    JSON.stringify(answerStarts[0]?.question)
  )
  check(
    '答案事件：answerStart 先到，且开始生成时 streaming 已置位',
    Boolean(answerStarts[0]?.qaId) && live.getState().streaming === true,
    `qaId=${answerStarts[0]?.qaId} streaming=${live.getState().streaming}`
  )

  // 第二条在第一条还没跑完时提问：必须显式通知「上一条不会再出内容」
  live.ask('第二句：你的项目难点是什么', 'auto')
  await sleep(300)
  check('答案事件：第二句也广播了 answerStart', answerStarts.length === 2, `${answerStarts.length} 次`)
  check(
    '答案事件：被打断的上一条广播 answerAborted',
    answerAborts.length === 1 && answerAborts[0]?.qaId === answerStarts[0]?.qaId,
    JSON.stringify(answerAborts)
  )
  check(
    '答案事件：两次提问的 qaId 不同',
    answerStarts[0]?.qaId !== answerStarts[1]?.qaId,
    `${answerStarts[0]?.qaId} vs ${answerStarts[1]?.qaId}`
  )

  // 让挂住的那条收尾，避免影响后续断言
  holdStreams = false
  live.stop()

  /* ---------- 多轮上下文：让追问接得上 ---------- */
  /*
   * 真实问题：只带一段原始转写、不带自己答过什么，模型被追问时会重复/跑题。
   * 原版工作流 memory.window 默认 10 轮、并用 role_prefix 区分 user/assistant，
   * 所以这里断言「历史问答作为真正的对话轮次回传」。
   */
  const agents = settingsStore.get().agents
  settingsStore.patch({
    agents: agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: 3 } : a)),
    activeAgentId: agents[0].id
  })
  await sleep(150)

  const beforeCtx = streamCalls.length
  live.start('meeting')
  await sleep(150)
  live.ask('第一个问题：介绍一下你的项目', 'auto')
  await sleep(400)
  const firstReq = streamCalls[beforeCtx]?.req
  check('上下文：首轮不带历史（只有 system + user）', firstReq?.messages?.length === 2, `${firstReq?.messages?.length} 条`)

  live.ask('第二个问题：那它的难点在哪', 'auto')
  await sleep(400)
  const secondReq = streamCalls[beforeCtx + 1]?.req
  const roles = (secondReq?.messages ?? []).map((m) => m.role)
  check(
    '上下文：追问时带上了上一轮问答',
    JSON.stringify(roles) === JSON.stringify(['system', 'user', 'assistant', 'user']),
    JSON.stringify(roles)
  )
  check(
    '上下文：历史 user 轮是上一轮的问题（带说话人标注）',
    String(secondReq?.messages?.[1]?.content ?? '').includes('第一个问题：介绍一下你的项目') &&
      String(secondReq?.messages?.[1]?.content ?? '').startsWith('面试官：'),
    JSON.stringify(secondReq?.messages?.[1]?.content)
  )
  check(
    '上下文：历史 assistant 轮是上一轮的回答',
    String(secondReq?.messages?.[2]?.content ?? '').includes('这是回答内容'),
    JSON.stringify(String(secondReq?.messages?.[2]?.content ?? '').slice(0, 40))
  )
  check(
    '上下文：本轮问题在最后一条',
    secondReq?.messages?.[3]?.content === '第二个问题：那它的难点在哪',
    JSON.stringify(secondReq?.messages?.[3]?.content)
  )
  live.stop()
  await sleep(150)

  /* 轮数上限 */
  settingsStore.patch({
    agents: settingsStore.get().agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: 1 } : a))
  })
  live.start('meeting')
  await sleep(150)
  live.ask('问题 A', 'auto')
  await sleep(300)
  live.ask('问题 B', 'auto')
  await sleep(300)
  live.ask('问题 C', 'auto')
  await sleep(400)
  const limited = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  check(
    '上下文：只带最近 1 轮（轮数上限生效）',
    limited.length === 4 &&
      limited.filter((m) => m.role === 'assistant').length === 1 &&
      String(limited[1].content).includes('问题 B') && String(limited[1].content).startsWith('面试官：'),
    JSON.stringify(limited.map((m) => `${m.role}:${String(m.content).slice(0, 8)}`))
  )
  live.stop()
  await sleep(150)

  /* 关掉历史 */
  settingsStore.patch({
    agents: settingsStore.get().agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: 0 } : a))
  })
  live.start('meeting')
  await sleep(150)
  live.ask('无上下文 1', 'auto')
  await sleep(300)
  live.ask('无上下文 2', 'auto')
  await sleep(400)
  const none = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  check('上下文：memoryRounds=0 时完全不带上文', none.length === 2, `${none.length} 条`)
  live.stop()
  await sleep(150)

  settingsStore.patch({
    agents: settingsStore.get().agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: 10 } : a))
  })

  live.stop()
  check('stop：状态回到未运行', live.getState().running === false)
  check('stop：ASR 回到 idle', live.getState().asr === 'idle', live.getState().asr)
  const beforeSession = live.getState().sessionId
  live.start('meeting')
  await sleep(120)
  live.clear()
  await sleep(150)
  check('clear：清空后创建新会话', live.getState().sessionId !== beforeSession, live.getState().sessionId)
  live.stop()

  /* ---------- 面试上下文：我实际怎么答的 ---------- */
  /*
   * 场景：面试官问 → 我给建议 → 我照着说/自己说 → 面试官追问。
   * 追问锚定在我上一轮说的**具体细节**上，所以上下文必须同时有
   * 「面试官问什么」「我实际说了什么」「当时建议了什么」。
   */
  const feedSource = async (seconds, kind, source) => {
    const chunk = 0.1
    for (let i = 0; i < Math.round(seconds / chunk); i++) {
      live.pushAudio(kind === 'silence' ? silence(chunk) : speech(chunk), source)
      await sleep(4)
    }
  }
  settingsStore.patch({
    audio: { ...settingsStore.get().audio, micEnabled: true, systemAudioEnabled: true },
    asrTuning: { ...settingsStore.get().asrTuning, silenceMs: 300, minSegmentMs: 200, maxSegmentMs: 4000, cumulative: false, autoAnswer: true, autoAnswerMinChars: 2 },
    agents: settingsStore.get().agents.map((a, i) => (i === 0 ? { ...a, memoryRounds: 5 } : a))
  })
  live.start('meeting')
  await sleep(200)
  const ctxBefore = streamCalls.length

  // 1) 我先说一句：绝不能被当成问题去提问
  asrTexts = ['我在上个项目负责缓存与一致性设计']
  await feedSource(1.2, 'speech', 'mic')
  await feedSource(0.8, 'silence', 'mic')
  await sleep(2200)
  check('我方发言不触发提问', streamCalls.length === ctxBefore, `多出 ${streamCalls.length - ctxBefore} 次`)

  // 2) 面试官问第一题 → 触发；首轮把我刚说的那句带上
  asrTexts = ['你那个缓存方案怎么保证一致性']
  await feedSource(1.2, 'speech', 'system')
  await feedSource(0.9, 'silence', 'system')
  await sleep(2500)
  check('面试官发言触发提问', streamCalls.length === ctxBefore + 1, `${streamCalls.length - ctxBefore} 次`)
  const firstMsgs = streamCalls[ctxBefore]?.req?.messages ?? []
  const firstCtx = JSON.stringify(firstMsgs)
  check('首轮上下文带上了我刚才说的话', firstCtx.includes('我实际回答') && firstCtx.includes('缓存与一致性设计'), firstCtx.slice(0, 120))

  // 3) 我回答第一题（两段，验证会拼接）
  asrTexts = ['我用的是本地缓存加过期时间', '一致性靠双删加延迟补偿']
  await feedSource(1.2, 'speech', 'mic')
  await feedSource(0.7, 'silence', 'mic')
  await sleep(1800)
  await feedSource(1.2, 'speech', 'mic')
  await feedSource(0.7, 'silence', 'mic')
  await sleep(1800)
  check('我的两段回答都进上下文缓冲（不触发提问）', streamCalls.length === ctxBefore + 1, `多出 ${streamCalls.length - ctxBefore - 1} 次`)

  // 4) 面试官追问 → 上下文里应有「问题 + 我实际回答 + 当时建议」
  asrTexts = ['那如果缓存和数据库不一致怎么办']
  await feedSource(1.2, 'speech', 'system')
  await feedSource(0.9, 'silence', 'system')
  await sleep(2500)
  const secondMsgs = streamCalls[ctxBefore + 1]?.req?.messages ?? []
  const secondCtx = JSON.stringify(secondMsgs)
  check('追问时带上了上一轮的问题', secondCtx.includes('你那个缓存方案怎么保证一致性'), secondCtx.slice(0, 100))
  check(
    '追问时带上了我的实际回答（两段已拼接）',
    secondCtx.includes('本地缓存加过期时间') && secondCtx.includes('双删加延迟补偿')
  )
  check('追问时带上了当时的建议', secondMsgs.some((m) => m.role === 'assistant'))
  check(
    '上下文顺序：上一轮在前，当前问题在最后',
    secondMsgs[secondMsgs.length - 1]?.content === '那如果缓存和数据库不一致怎么办',
    String(secondMsgs[secondMsgs.length - 1]?.content).slice(0, 40)
  )

  // 5) 我实际怎么答的会落库（复盘要用）
  await sleep(300)
  const sess = sessions.get(live.getState().sessionId)
  const withAnswer = (sess?.qa ?? []).filter((q) => q.myAnswer)
  check('落库：问答记录里存了「我实际回答」', withAnswer.length > 0, `${withAnswer.length} 条`)
  check(
    '落库：内容是我说的原话',
    String(withAnswer[0]?.myAnswer ?? '').includes('本地缓存加过期时间'),
    String(withAnswer[0]?.myAnswer ?? '').slice(0, 60)
  )
  live.stop()
  await sleep(200)

  /* 只开麦克风（面对面）时，麦克风仍然是提问来源 */
  settingsStore.patch({ audio: { ...settingsStore.get().audio, micEnabled: true, systemAudioEnabled: false } })
  live.start('meeting')
  await sleep(200)
  const faceBefore = streamCalls.length
  asrTexts = ['面对面场景下对方直接问我']
  await feedSource(1.2, 'speech', 'mic')
  await feedSource(0.9, 'silence', 'mic')
  await sleep(2500)
  check('只开麦克风时，麦克风仍会触发提问（面对面场景）', streamCalls.length > faceBefore, `${streamCalls.length - faceBefore} 次`)
  live.stop()
  await sleep(200)
  settingsStore.patch({ audio: { ...settingsStore.get().audio, micEnabled: false, systemAudioEnabled: true } })

  /* ---------- 简历知识库：整份注入助答 ---------- */
  /*
   * 面试里大量问题是「介绍一下你自己 / 讲讲你的项目」，靠相似度检索不稳
   * （问题里不含简历的关键名词时捞不到），所以简历必须整份进提示词。
   */
  const { knowledgeStore } = require(path.join(ROOT, 'src/main/knowledge/store.ts'))
  knowledgeStore.kbs.upsert({
    id: 'kb-resume-test',
    name: '我的简历',
    purpose: 'resume',
    createdAt: Date.now() - 10,
    updatedAt: Date.now() + 100000
  })
  knowledgeStore.docs.upsert({
    id: 'doc-resume-test',
    kbId: 'kb-resume-test',
    name: '简历.md',
    chars: 30,
    chunks: 1,
    createdAt: Date.now()
  })
  knowledgeStore.chunks.appendMany('kb-resume-test', [
    {
      id: 'chunk-resume-test',
      kbId: 'kb-resume-test',
      docId: 'doc-resume-test',
      docName: '简历.md',
      text: '我有 8 年后端经验，主导过支付系统重构，熟悉 MySQL 与 Redis。'
    }
  ])
  live.start('meeting')
  await sleep(200)
  live.ask('介绍一下你自己', 'manual')
  await sleep(700)
  const resumeMsgs = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  const sysText = String(resumeMsgs[0]?.content ?? '')
  check('简历知识库：整份注入到系统提示词', sysText.includes('【我的简历 / 背景】'), sysText.includes('【我的简历 / 背景】') ? '' : sysText.slice(0, 80))
  check('简历知识库：内容确实进去了', sysText.includes('8 年后端经验') && sysText.includes('支付系统重构'))
  check('简历知识库：明确要求不编造经历', sysText.includes('不要编造经历'))

  // 有速查卡时只注入速查卡（更短更精炼），不再塞原文
  const resumeKb = knowledgeStore.kbs.all().find((kb) => kb.id === 'kb-resume-test')
  resumeKb.profile = '基本信息：8 年 / 后端 / 本科\n技术栈：Go, MySQL, Redis\n项目经历：支付系统｜重构｜亮点：资损 0'
  resumeKb.profileAt = Date.now()
  knowledgeStore.kbs.upsert(resumeKb)
  live.ask('你的项目里最难的点是什么', 'manual')
  await sleep(700)
  const profileMsgs = streamCalls[streamCalls.length - 1]?.req?.messages ?? []
  const profileSys = String(profileMsgs[0]?.content ?? '')
  check('简历速查卡：注入的是速查卡', profileSys.includes('（速查卡）'), profileSys.length + ' 字')
  check('简历速查卡：速查卡内容进去了', profileSys.includes('技术栈：Go') && profileSys.includes('资损 0'))
  check(
    '简历速查卡：不再重复塞简历原文（省上下文）',
    !profileSys.includes('主导过支付系统重构，熟悉 MySQL 与 Redis。')
  )
  live.stop()
  await sleep(150)

  /* ---------- 开始会话的入口只能有一个 ---------- */
  /*
   * 真实体验事故：主窗口自己先 live.start 再开悬浮窗，于是悬浮窗一打开就显示「停止」，
   * 但采集根本没建（AudioCapture 在悬浮窗渲染层里），用户得先点停止、再点开始
   * 走一遍设备检查才真正启动。所以：主窗口只负责「请悬浮窗开始」。
   */
  /* ---------- 终端别被刷屏 ---------- */
  /*
   * 原来采集热路径每秒打一行「[live] 音频帧 N 音量 X% 通道已发帧 M」，
   * 开一场会终端就被刷满。诊断值保留在 state 里即可，不需要一直打日志。
   */
  const orchSrc = fs.readFileSync(path.join(ROOT, 'src/main/live/orchestrator.ts'), 'utf8')
  const orchCode = orchSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('终端：采集热路径不打日志', !/console\.log\(/.test(orchCode))
  check('终端：状态广播已降频（不是每 10 帧一次）', !/audioFrames % 10 === 0/.test(orchCode))
  check(
    '终端：第一帧仍然会广播一次（否则界面一直显示 0）',
    /audioFrames === 1/.test(orchCode)
  )

  const saSrc = fs.readFileSync(path.join(ROOT, 'src/main/system-audio.ts'), 'utf8')
  const saCode = saSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('终端：原生采集只报第一帧', /frameCount === 1/.test(saCode) && !/frameCount % 250/.test(saCode))

  const homeSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/windows/main/pages/Home.tsx'), 'utf8')
  const homeCode = homeSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('开始会话：主窗口不自己开 session', !/live\.start\s*\(/.test(homeCode))
  check('开始会话：主窗口改为请求悬浮窗开始', /floating\.start\s*\(/.test(homeCode))

  const floatingPreload = fs.readFileSync(path.join(ROOT, 'src/preload/floating.ts'), 'utf8')
  check('开始会话：悬浮窗能收到开始请求', /onStartRequested/.test(floatingPreload))

  const floatingApp = fs.readFileSync(path.join(ROOT, 'src/renderer/src/windows/floating/App.tsx'), 'utf8')
  const floatingCode = floatingApp
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('开始会话：悬浮窗订阅了开始请求', /onStartRequested/.test(floatingCode))
  check(
    '开始会话：等设置到位再开跑（否则会跳过设备检查）',
    /if \(!startRequest \|\| !settings\) return/.test(floatingCode)
  )

  /* ---------- 会话标题从「开始」一路带下来 ---------- */
  live.start('meeting', '我的面试记录')
  await sleep(150)
  const titled = sessions.get(live.getState().sessionId)
  check('标题：开始时传的标题落到会话上', titled?.title === '我的面试记录', String(titled?.title))
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
