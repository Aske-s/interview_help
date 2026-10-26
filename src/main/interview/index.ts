import { randomUUID } from 'node:crypto'
import { JsonCollection, dataFile } from '../store/store'
import { activeProvider } from '../store/settings'
import { chatComplete } from '../gateway/llm'
import type {
  InterviewConfig,
  InterviewDifficulty,
  InterviewFocus,
  InterviewPacing,
  InterviewPhase,
  InterviewSession,
  InterviewTurn
} from '@shared/types'

/**
 * AI 模拟面试：状态机 + 逐轮评分 + 复盘报告。
 *
 * 与基础版的区别：把「面试官角色设定 / 难度等级 / 考察节奏 / 考察偏好 / 单题超时」
 * 这些配置维度真正注入 prompt，并按配置驱动出题与阶段推进。
 * 阶段顺序固定为：开场自我介绍 → 项目深挖 → 技术考察 → 行为协作 → 候选人反问 → 复盘。
 */

const interviews = new JsonCollection<InterviewSession>(dataFile('interviews.json'))

/** 自适应节奏下的整场轮数硬上限（含开场，不含反问） */
const MAX_TURNS = 15
/** 自适应节奏下计划考察的核心问题数，留出开场与反问的空间 */
const ADAPTIVE_CORE_ROUNDS = 12

const PHASE_LABEL: Record<InterviewPhase, string> = {
  idle: '未开始',
  intro: '开场自我介绍',
  project: '项目经历深挖',
  technical: '技术能力考察',
  behavioral: '行为与协作',
  candidate_qa: '候选人反问',
  review: '复盘'
}

const PHASE_GOAL: Record<InterviewPhase, string> = {
  idle: '尚未开始。',
  intro: '让候选人做自我介绍，快速定位其技术栈与经历亮点，为后续追问找线索。',
  project: '围绕简历中的项目深挖：背景、个人职责、技术选型、难点、量化结果与复盘。',
  technical: '考察技术基础与设计能力：原理、边界条件、方案取舍；按考察偏好决定偏八股还是偏系统设计。',
  behavioral: '考察行为与协作：跨团队沟通、冲突处理、故障复盘、主动性与成长性。',
  candidate_qa: '候选人反问环节：由候选人提问，面试官如实回答岗位与团队相关的问题。',
  review: '面试已结束，输出复盘报告。'
}

const PHASE_ORDER: InterviewPhase[] = ['idle', 'intro', 'project', 'technical', 'behavioral', 'candidate_qa', 'review']

/** 计入「考察轮数」的核心阶段：开场与反问不计入 */
const CORE_PHASES: InterviewPhase[] = ['project', 'technical', 'behavioral']

export const DEFAULT_INTERVIEW_CONFIG: InterviewConfig = {
  role: '未指定岗位',
  interviewer: '资深技术面试官',
  difficulty: 'medium',
  pacing: 'adaptive',
  fixedRounds: 6,
  focus: 'balanced',
  timeoutSec: 0,
  background: ''
}

const DIFFICULTIES: InterviewDifficulty[] = ['easy', 'medium', 'hard', 'expert']
const PACINGS: InterviewPacing[] = ['adaptive', 'fixed']
const FOCUSES: InterviewFocus[] = ['balanced', 'fundamentals', 'system_design', 'project', 'breadth']
const PHASES: InterviewPhase[] = ['idle', 'intro', 'project', 'technical', 'behavioral', 'candidate_qa', 'review']

const DIFFICULTY_LABEL: Record<InterviewDifficulty, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
  expert: '专家'
}

const DIFFICULTY_GUIDE: Record<InterviewDifficulty, string> = {
  easy: '【难度：简单】以基础概念、常见用法和真实场景为主，一次只覆盖一个知识点；候选人卡壳时给出提示，追问不超过 1 层，语气友善鼓励。',
  medium: '【难度：中等】基础与项目并重，关注实现细节、常见坑与方案取舍；追问 1-2 层，要求候选人给出具体例子或数据。',
  hard: '【难度：困难】深挖底层原理、边界条件与失败场景；对含糊或明显背诵的回答连续追问，要求量化数据与个人贡献，追问 2-3 层。',
  expert: '【难度：专家】以架构级与方向性难题、压力追问为主，主动质疑回答中的前提假设，要求给出多方案对比、权衡依据与量化指标；不接受泛泛而谈。'
}

const FOCUS_LABEL: Record<InterviewFocus, string> = {
  balanced: '均衡',
  fundamentals: '侧重八股基础',
  system_design: '侧重系统设计架构',
  project: '基础与项目各半',
  breadth: '广度优先'
}

const FOCUS_GUIDE: Record<InterviewFocus, string> = {
  balanced: '【考察偏好：均衡】基础原理、项目实战、系统设计三方面均衡覆盖，并穿插少量行为协作问题。',
  fundamentals: '【考察偏好：侧重八股基础】以语言/运行时/网络/数据库/操作系统等基础原理为主，少谈项目细节，重点验证概念准确度与深度。',
  system_design: '【考察偏好：侧重系统设计架构】以系统设计题为主（容量估算、模块拆解、一致性、可用性、扩展与演进），要求候选人先讲清假设再给方案。',
  project: '【考察偏好：基础与项目各半】约一半问题围绕简历中的项目深挖（背景、职责、技术选型、指标、复盘），另一半考察基础原理。',
  breadth: '【考察偏好：广度优先】快速覆盖多个技术域（语言、框架、网络、数据库、缓存、消息队列、运维等），每个方向 1-2 题，不长时间深挖单点。'
}

/** 各考察偏好下 project/technical/behavioral 的轮次权重 */
const FOCUS_WEIGHTS: Record<InterviewFocus, Record<'project' | 'technical' | 'behavioral', number>> = {
  balanced: { project: 3, technical: 3, behavioral: 2 },
  fundamentals: { project: 1, technical: 5, behavioral: 2 },
  system_design: { project: 2, technical: 5, behavioral: 1 },
  project: { project: 4, technical: 3, behavioral: 1 },
  breadth: { project: 2, technical: 4, behavioral: 2 }
}

/* ------------------------------------------------------------------ *
 * 配置归一化 / 旧数据补齐
 * ------------------------------------------------------------------ */

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}

/** 补齐并纠正一份面试配置：容忍旧数据缺字段，也容忍手工改坏的值 */
export function normalizeInterviewConfig(
  input?: Partial<InterviewConfig> | null,
  fallback: { role?: string; background?: string } = {}
): InterviewConfig {
  const source: Partial<InterviewConfig> = input ?? {}
  const fallbackRole = typeof fallback.role === 'string' ? fallback.role : ''
  const role = typeof source.role === 'string' && source.role.trim() ? source.role.trim() : fallbackRole.trim()
  // 旧数据可能是脏值（数字/null），这里一律收敛成字符串
  const background =
    typeof source.background === 'string'
      ? source.background
      : typeof fallback.background === 'string'
        ? fallback.background
        : ''
  return {
    role: role || DEFAULT_INTERVIEW_CONFIG.role,
    interviewer:
      typeof source.interviewer === 'string' && source.interviewer.trim()
        ? source.interviewer.trim()
        : DEFAULT_INTERVIEW_CONFIG.interviewer,
    difficulty: pick(source.difficulty, DIFFICULTIES, DEFAULT_INTERVIEW_CONFIG.difficulty),
    pacing: pick(source.pacing, PACINGS, DEFAULT_INTERVIEW_CONFIG.pacing),
    // 固定轮数契约范围 3-15
    fixedRounds: clampInt(source.fixedRounds, 3, 15, DEFAULT_INTERVIEW_CONFIG.fixedRounds),
    focus: pick(source.focus, FOCUSES, DEFAULT_INTERVIEW_CONFIG.focus),
    // 单题超时按秒，0 表示不限
    timeoutSec: clampInt(source.timeoutSec, 0, 3600, DEFAULT_INTERVIEW_CONFIG.timeoutSec),
    background,
    resumeName: typeof source.resumeName === 'string' && source.resumeName ? source.resumeName : undefined
  }
}

/**
 * 兼容旧数据：早期 interviews.json 里的记录只有 role/background，没有 config。
 * 读取时统一补齐默认值（只在内存里补齐；下一次写入时会顺带落库）。
 */
function hydrateSession(raw: InterviewSession | null): InterviewSession | null {
  if (!raw) return null
  const config = normalizeInterviewConfig(raw.config, { role: raw.role, background: raw.background })
  return {
    ...raw,
    role: config.role,
    background: config.background,
    config,
    phase: pick(raw.phase, PHASES, 'idle'),
    turns: Array.isArray(raw.turns) ? raw.turns : []
  }
}

/* ------------------------------------------------------------------ *
 * Prompt 组装
 * ------------------------------------------------------------------ */

function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const start = cleaned.search(/[[{]/)
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

async function askModel(system: string, user: string, json = true): Promise<string> {
  const provider = activeProvider()
  if (!provider?.baseUrl) throw new Error('未配置模型网关，请到「设置 → 模型网关」填写后再开始面试')
  const result = await chatComplete({
    provider,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    json
  })
  return result.text
}

/** 面试官 system prompt：角色设定 + 难度 + 偏好 + 超时 + 当前阶段 */
function interviewerSystem(config: InterviewConfig, phase: InterviewPhase): string {
  return [
    `你是一名${config.interviewer}，正在为「${config.role}」岗位主持一场模拟面试，全程使用中文。`,
    DIFFICULTY_GUIDE[config.difficulty],
    FOCUS_GUIDE[config.focus],
    config.timeoutSec > 0
      ? `【单题限时】每道核心问题限时 ${config.timeoutSec} 秒，出题要短、聚焦单一考察点，便于候选人在限时内作答。`
      : '',
    `【当前阶段】${PHASE_LABEL[phase]}：${PHASE_GOAL[phase]}`,
    '【问答规则】一次只问一个问题；不要自问自答；可以针对候选人上一轮的回答追问；不要重复已经问过的内容。'
  ]
    .filter(Boolean)
    .join('\n')
}

function countAnsweredCore(turns: InterviewTurn[]): number {
  return turns.filter((t) => t.answer !== undefined && CORE_PHASES.includes(t.phase)).length
}

function countAnsweredInPhase(turns: InterviewTurn[], phase: InterviewPhase): number {
  return turns.filter((t) => t.answer !== undefined && t.phase === phase).length
}

/** 按考察偏好把总轮数分配到各核心阶段（最大余数法，保证总数为 total） */
function planCorePhases(focus: InterviewFocus, total: number): InterviewPhase[] {
  const weights = FOCUS_WEIGHTS[focus] ?? FOCUS_WEIGHTS.balanced
  const rounds = Math.max(1, Math.min(MAX_TURNS, Math.round(total)))
  const entries = (['project', 'technical', 'behavioral'] as const).map((phase) => ({ phase: phase as InterviewPhase, weight: weights[phase] }))
  const sum = entries.reduce((acc, e) => acc + e.weight, 0) || 1
  const counts = entries.map((e) => {
    const value = (e.weight / sum) * rounds
    return { phase: e.phase, count: Math.floor(value), rest: value - Math.floor(value) }
  })
  // 余数最大的先补，补到刚好 rounds 个
  const order = counts.slice().sort((a, b) => b.rest - a.rest)
  let assigned = counts.reduce((acc, c) => acc + c.count, 0)
  for (let i = 0; assigned < rounds; i += 1) {
    order[i % order.length].count += 1
    assigned += 1
  }
  const plan: InterviewPhase[] = []
  for (const c of counts) for (let k = 0; k < c.count; k += 1) plan.push(c.phase)
  return plan
}

function phaseIndex(phase: InterviewPhase): number {
  return PHASE_ORDER.indexOf(phase)
}

/** 不允许阶段倒退（自适应提前晋级后，计划表可能还停留在更早的阶段） */
function forwardOnly(target: InterviewPhase, current: InterviewPhase): InterviewPhase {
  return phaseIndex(target) < phaseIndex(current) ? current : target
}

function nextPhase(current: InterviewPhase): InterviewPhase {
  const index = PHASE_ORDER.indexOf(current)
  if (index < 0 || index >= PHASE_ORDER.length - 1) return 'review'
  return PHASE_ORDER[index + 1]
}

/**
 * 决定下一阶段。
 * - fixed：只统计核心问题（开场与反问不计入），达到 fixedRounds 即进入反问环节。
 * - adaptive：按阶段计划推进，并用本轮评分微调（高分提前晋级、低分同阶段再追一轮），最多 15 轮。
 */
function decideNextPhase(session: InterviewSession, lastScore: number | undefined): InterviewPhase {
  const config = session.config
  const current = session.phase
  const answeredTurns = session.turns.filter((t) => t.answer !== undefined).length
  const coreAnswered = countAnsweredCore(session.turns)

  if (config.pacing === 'fixed') {
    if (coreAnswered >= config.fixedRounds) return 'candidate_qa'
    const plan = planCorePhases(config.focus, config.fixedRounds)
    return forwardOnly(plan[coreAnswered] ?? 'candidate_qa', current)
  }

  if (answeredTurns >= MAX_TURNS) return 'candidate_qa'
  if (current === 'idle') return 'intro'
  if (current === 'intro') {
    const plan = planCorePhases(config.focus, ADAPTIVE_CORE_ROUNDS)
    return forwardOnly(plan[0] ?? 'candidate_qa', current)
  }
  if (!CORE_PHASES.includes(current)) return 'candidate_qa'

  const inPhase = countAnsweredInPhase(session.turns, current)
  if (lastScore !== undefined && lastScore >= 80 && inPhase >= 1) {
    // 高分：提前进入下一阶段
    return nextPhase(current)
  }
  if (lastScore !== undefined && lastScore < 60 && inPhase < 2) {
    // 低分：同阶段再追问一轮，确认是偶发还是知识盲区
    return current
  }
  const plan = planCorePhases(config.focus, ADAPTIVE_CORE_ROUNDS)
  return forwardOnly(plan[coreAnswered] ?? 'candidate_qa', current)
}

async function askQuestion(session: InterviewSession, phase: InterviewPhase): Promise<string> {
  const config = session.config
  const history = session.turns
    .slice(-4)
    .map((t) => `问：${t.question}\n答：${t.answer ?? '（未作答）'}${typeof t.score === 'number' ? `（评分 ${t.score}）` : ''}`)
    .join('\n\n')
  const progress =
    config.pacing === 'fixed'
      ? `进度：核心问题 ${Math.min(countAnsweredCore(session.turns), config.fixedRounds)}/${config.fixedRounds}（开场与反问不计入）`
      : `进度：已作答 ${session.turns.filter((t) => t.answer !== undefined).length} 轮，本场最多 ${MAX_TURNS} 轮`

  const question = await askModel(
    interviewerSystem(config, phase),
    [
      `候选人背景资料：\n${config.background || '（未提供）'}`,
      `最近对话：\n${history || '（暂无）'}`,
      progress,
      `当前阶段：${PHASE_LABEL[phase]}`,
      '请提出下一个问题。只输出问题本身，不要编号，不要解释。'
    ].join('\n\n'),
    false
  )
  return question.trim() || '请继续展开说明你的思路。'
}

/* ------------------------------------------------------------------ *
 * 对外 API
 * ------------------------------------------------------------------ */

export function listInterviews(): InterviewSession[] {
  return interviews
    .all()
    .map((item) => hydrateSession(item))
    .filter((item): item is InterviewSession => item !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getInterview(id: string): InterviewSession | null {
  return hydrateSession(interviews.get(id))
}

/** 创建面试会话。支持新签名 (config) 与旧签名 (role, background) */
export function createInterview(config: InterviewConfig): InterviewSession
export function createInterview(role: string, background?: string): InterviewSession
export function createInterview(configOrRole: InterviewConfig | string, background = ''): InterviewSession {
  const config =
    typeof configOrRole === 'string'
      ? normalizeInterviewConfig({ role: configOrRole, background })
      : normalizeInterviewConfig(configOrRole)
  const now = Date.now()
  return interviews.upsert({
    id: randomUUID(),
    role: config.role,
    background: config.background,
    config,
    phase: 'idle',
    turns: [],
    createdAt: now,
    updatedAt: now
  })
}

export function deleteInterview(id: string): void {
  interviews.remove(id)
}

/**
 * 开始面试 / 让面试官继续提问。
 * 若末尾已有待回答问题则直接返回；若上一题已作答但生成失败，可再次调用补出下一题。
 */
export async function startInterview(id: string): Promise<InterviewSession> {
  const session = hydrateSession(interviews.get(id))
  if (!session) throw new Error('面试会话不存在')

  const pending = session.turns[session.turns.length - 1]
  if (pending && pending.answer === undefined) return session
  if (session.finished || session.phase === 'review') throw new Error('该面试已结束，请重新创建一场')
  // 反问环节不再由面试官出题
  if (session.phase === 'candidate_qa') return session

  const phase: InterviewPhase = session.turns.length === 0 ? 'intro' : session.phase
  const question = await askQuestion(session, phase)

  session.phase = phase
  session.turns.push({ id: randomUUID(), phase, question, createdAt: Date.now() })
  session.updatedAt = Date.now()
  return interviews.upsert(session)
}

/** 提交回答：先评分，再按配置推进阶段并生成下一问 */
export async function answerInterview(id: string, answer: string, elapsedMs?: number): Promise<InterviewSession> {
  const session = hydrateSession(interviews.get(id))
  if (!session) throw new Error('面试会话不存在')
  const text = answer.trim()
  if (!text) throw new Error('回答内容不能为空')

  const config = session.config

  // 反问环节：用户提问，面试官作答；不评分、不推进阶段
  if (session.phase === 'candidate_qa') {
    const reply = await askModel(
      `${interviewerSystem(config, 'candidate_qa')}\n现在由候选人向你提问，你以面试官身份坦诚回答，控制在 200 字以内，可结合岗位要求与考察偏好说明。`,
      [`岗位：${config.role}`, `候选人的问题：${text}`, '请直接回答，不要反问，不要输出 JSON。'].join('\n\n'),
      false
    )
    session.turns.push({
      id: randomUUID(),
      phase: 'candidate_qa',
      question: text,
      answer: reply.trim() || '（面试官未给出回答）',
      createdAt: Date.now()
    })
    session.updatedAt = Date.now()
    return interviews.upsert(session)
  }

  if (session.phase === 'idle') throw new Error('面试尚未开始，请先点击「开始面试」')
  if (session.phase === 'review') throw new Error('面试已结束，无法继续作答')

  const last = session.turns[session.turns.length - 1]
  if (!last) throw new Error('还没有问题，无法作答')
  if (last.answer !== undefined) throw new Error('当前没有待回答的问题')

  last.answer = text
  // 回答耗时：优先用渲染层传入的值，否则按出题时间推算
  last.elapsedMs =
    typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs)
      : Math.max(0, Date.now() - last.createdAt)

  // 1) 评估本轮回答
  try {
    const evaluation = await askModel(
      '你是严格但友善的面试评估官。只输出 JSON，不要输出任何其他内容。',
      [
        `岗位：${config.role}`,
        `面试官设定：${config.interviewer}`,
        `难度：${DIFFICULTY_LABEL[config.difficulty]}`,
        `考察偏好：${FOCUS_LABEL[config.focus]}`,
        `阶段：${PHASE_LABEL[session.phase]}`,
        `问题：${last.question}`,
        `候选人回答：${text}`,
        last.elapsedMs > 0 ? `作答用时：${Math.round(last.elapsedMs / 1000)} 秒（限时 ${config.timeoutSec || '不限'} 秒）` : '',
        '评分请结合准确度、深度、结构化程度与岗位匹配度，并按上面的难度校准严格程度。',
        '请输出 JSON：{"score": 0-100 的整数, "comment": "两句以内的点评，指出亮点与不足"}'
      ]
        .filter(Boolean)
        .join('\n')
    )
    const parsed = parseJson<{ score?: number; comment?: string }>(evaluation)
    if (parsed) {
      last.score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : undefined
      last.comment = parsed.comment
    }
  } catch (error) {
    last.comment = `（本轮评分失败：${error instanceof Error ? error.message : String(error)}）`
  }

  // 2) 按配置推进阶段。先落库，避免后续出题失败把已回答的内容丢掉
  const phase = decideNextPhase(session, last.score)
  session.phase = phase
  session.updatedAt = Date.now()
  interviews.upsert(session)
  if (phase === 'candidate_qa') return session

  // 3) 生成下一问（失败时本轮回答与阶段已保存，UI 可点「让面试官继续提问」重试）
  const question = await askQuestion(session, phase)
  session.turns.push({ id: randomUUID(), phase, question, createdAt: Date.now() })
  session.updatedAt = Date.now()
  return interviews.upsert(session)
}

function formatTranscript(turns: InterviewTurn[]): string {
  if (!turns.length) return '（无作答记录）'
  return turns
    .map((t, index) => {
      const qa = t.phase === 'candidate_qa'
      const lines = [qa ? `第 ${index + 1} 条【候选人反问】` : `第 ${index + 1} 题【${PHASE_LABEL[t.phase]}】`]
      lines.push(qa ? `候选人问：${t.question}` : `问：${t.question}`)
      lines.push(t.answer ? (qa ? `面试官答：${t.answer}` : `答：${t.answer}`) : '答：（未作答）')
      if (typeof t.score === 'number') lines.push(`评分：${t.score}${t.comment ? ` · ${t.comment}` : ''}`)
      if (typeof t.elapsedMs === 'number' && t.elapsedMs > 0) lines.push(`用时：${Math.round(t.elapsedMs / 1000)} 秒`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/** 组装复盘报告（从本次纪要中提炼关键问题与可复用答案） */
async function buildReview(session: InterviewSession): Promise<string> {
  const config = session.config
  const scored = session.turns.filter((t) => typeof t.score === 'number')
  const average = scored.length ? Math.round(scored.reduce((acc, t) => acc + (t.score ?? 0), 0) / scored.length) : null
  const paceText =
    config.pacing === 'fixed'
      ? `固定轮数（核心问题 ${config.fixedRounds} 题，开场与反问不计入），实际核心问题 ${countAnsweredCore(session.turns)} 题`
      : `评分驱动自适应（最多 ${MAX_TURNS} 轮），实际作答 ${session.turns.filter((t) => t.answer !== undefined).length} 轮`

  return askModel(
    '你是资深面试教练，擅长把一场模拟面试的纪要转化为可执行的复盘报告。请用中文输出 Markdown。',
    [
      `岗位：${config.role}`,
      `面试官设定：${config.interviewer}`,
      `难度：${DIFFICULTY_LABEL[config.difficulty]}`,
      `考察偏好：${FOCUS_LABEL[config.focus]}`,
      `考察节奏：${paceText}`,
      config.timeoutSec > 0 ? `单题限时：${config.timeoutSec} 秒` : '单题限时：不限',
      `候选人背景：\n${config.background || '（未提供）'}`,
      `平均分：${average === null ? '（无有效评分）' : `${average} 分（共 ${scored.length} 题评分）`}`,
      `面试纪要：\n${formatTranscript(session.turns)}`,
      '请输出 Markdown 复盘报告，必须包含以下小节：',
      '## 一、总体评价',
      '## 二、表现亮点',
      '## 三、主要短板',
      '## 四、逐题改进建议',
      '## 五、关键问题与可复用答案',
      '（用 Markdown 表格列出「关键问题 | 可复用答案要点」，从上面的纪要中提炼，至少 3 条）',
      '## 六、下一步准备清单',
      '只输出报告正文，不要输出 JSON，也不要额外解释。'
    ].join('\n\n'),
    false
  )
}

/**
 * 生成复盘报告。
 * `finish: true` 会同时把面试置为已结束（复盘阶段）；`finish: false` 只生成报告、不打断面试。
 * finishInterview 与本函数共用同一套生成逻辑。
 */
export async function generateInterviewReview(id: string, opts: { finish?: boolean } = {}): Promise<InterviewSession> {
  const session = hydrateSession(interviews.get(id))
  if (!session) throw new Error('面试会话不存在')

  if (opts.finish === true) {
    session.phase = 'review'
    session.finished = true
  }

  try {
    session.review = await buildReview(session)
  } catch (error) {
    session.review = `复盘生成失败：${error instanceof Error ? error.message : String(error)}`
  }

  session.updatedAt = Date.now()
  return interviews.upsert(session)
}

/** 结束面试并生成复盘报告 */
export async function finishInterview(id: string): Promise<InterviewSession> {
  return generateInterviewReview(id, { finish: true })
}

export const interviewStore = interviews
export type { InterviewTurn }
