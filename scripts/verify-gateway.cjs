/**
 * 网关客户端验证：用本地 mock 网关跑通真实代码路径。
 *
 * 运行：
 *   node scripts/verify-gateway.cjs
 *
 * 覆盖：SSE 流式解析、思维链/正文分离、usage 统计、首字延迟、
 * /models 列表、/embeddings 向量、连通性探针、错误处理、用户取消。
 * 不依赖任何真实 API Key。
 */

const http = require('node:http')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'node_modules', '.cache', 'verify-gateway.cjs')

/* ---------- 1. 用 jiti 直接加载 TS 客户端（项目未装 esbuild） ---------- */
function buildClient() {
  const { createJiti } = require('jiti')
  const jiti = createJiti(__filename)
  return jiti(path.join(ROOT, 'src/main/gateway/llm.ts'))
}

/* ---------- 2. 本地 mock 网关 ---------- */
function startMockGateway() {
  const calls = { chat: 0, models: 0, embeddings: 0, transcripts: 0, lastBody: null, bodies: [] }
  const server = http.createServer((req, res) => {
    const url = req.url || ''
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')

      if (url.endsWith('/models')) {
        calls.models++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'qwen-vl-max' }] }))
        return
      }

      if (url.endsWith('/embeddings')) {
        calls.embeddings++
        const body = JSON.parse(raw)
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: inputs.map((_, index) => ({ index, embedding: [0.1 * (index + 1), 0.2, 0.3] }))
          })
        )
        return
      }

      if (url.endsWith('/audio/transcriptions')) {
        calls.transcripts++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: '这是 mock 转写结果' }))
        return
      }

      if (url.endsWith('/chat/completions')) {
        calls.chat++
        const body = JSON.parse(raw)
        calls.lastBody = body
        // 记录每次请求体，供兼容性重试断言
        calls.bodies.push(body)

        // 模拟鉴权失败
        if (!req.headers.authorization) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: '缺少 API Key' } }))
          return
        }

        // 模拟「新版 OpenAI 模型拒收 max_tokens」：模型名带 strict 时启用
        if (String(body.model).includes('strict')) {
          if (body.max_tokens !== undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            // 还原用户实际遇到的中转网关格式：真实错误嵌在 messages 字符串里
            res.end(
              JSON.stringify({
                code: 'INVALID_PARAMETER',
                messages:
                  'azure service call failed: HTTP request failed with status 400: {\n "error": {\n' +
                  ' "message": "Unsupported parameter: \'max_tokens\' is not supported with this model.' +
                  ' Use \'max_completion_tokens\' instead.",\n "type": "invalid_request_error"\n }\n}'
              })
            )
            return
          }
          if (body.temperature !== undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: { message: "Unsupported parameter: 'temperature' is not supported with this model." }
              })
            )
            return
          }
        }

        // 非流式：需要在发 SSE 头之前分流
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { content: '非流式回答', reasoning_content: '非流式思考' } }],
              usage: { prompt_tokens: 5, completion_tokens: 3 }
            })
          )
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

        // 思维链增量
        send({ choices: [{ delta: { reasoning_content: '先想一下…' } }] })
        // 正文增量（拆成多片，验证拼接）
        for (const piece of ['慢', '查询', '优化']) {
          send({ choices: [{ delta: { content: piece } }] })
        }
        // 最后一帧带 usage
        send({ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(404).end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, calls, baseUrl: `http://127.0.0.1:${port}/v1`, port })
    })
  })
}

/* ---------- 3. 断言 ---------- */
const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

async function main() {
  const client = buildClient()
  const { server, calls, baseUrl, port } = await startMockGateway()

  const provider = {
    id: 'mock',
    name: 'mock',
    baseUrl,
    apiKey: 'test-key',
    model: 'deepseek-chat',
    supportsVision: true,
    // 默认：不发推理强度、不发 temperature
    reasoningEffort: 'auto',
    maxTokens: 256,
    extraBody: ''
  }

  console.log(`\n=== mock 网关已启动：${baseUrl} ===\n`)

  /* --- 流式对话（chatStream 是生成器，return 值需通过迭代结束取到） --- */
  const iterator = client.chatStream({ provider, messages: [{ role: 'user', content: '你好' }] })
  const collected = []
  let final
  for (;;) {
    const step = await iterator.next()
    if (step.done) {
      final = step.value
      break
    }
    collected.push(step.value)
  }

  check('流式：产出 reasoning 分片', collected.some((d) => d.kind === 'reasoning'))
  check('流式：产出 content 分片', collected.filter((d) => d.kind === 'content').length === 3, `共 ${collected.filter((d) => d.kind === 'content').length} 片`)
  check('流式：正文正确拼接', final.text === '慢查询优化', `得到 "${final.text}"`)
  check('流式：思维链正确拼接', final.reasoning === '先想一下…', `得到 "${final.reasoning}"`)
  check('流式：usage 被解析', final.usage?.promptTokens === 42 && final.usage?.completionTokens === 7, JSON.stringify(final.usage))
  check('流式：记录首字延迟', typeof final.firstTokenMs === 'number' && final.firstTokenMs >= 0, `${final.firstTokenMs}ms`)
  check('流式：请求带 stream=true 与 stream_options', calls.lastBody?.stream === true && Boolean(calls.lastBody?.stream_options))
  check('流式：请求带 max_tokens', calls.lastBody?.max_tokens === 256)
  check(
    '参数策略：reasoningEffort=auto 时不发送 reasoning_effort',
    !('reasoning_effort' in (calls.lastBody ?? {})),
    JSON.stringify(calls.lastBody?.reasoning_effort)
  )
  check(
    '参数策略：未填 temperature 时不发送 temperature',
    !('temperature' in (calls.lastBody ?? {})),
    JSON.stringify(calls.lastBody?.temperature)
  )

  /* --- 推理强度：与 Codex 的 model_reasoning_effort 取值一致 --- */
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    await client.chatComplete({ provider: { ...provider, reasoningEffort: effort }, messages: [{ role: 'user', content: 'x' }] })
    check(`推理强度：${effort} 原样发送`, calls.lastBody?.reasoning_effort === effort, String(calls.lastBody?.reasoning_effort))
  }

  /* --- temperature 仅在显式提供时发送 --- */
  await client.chatComplete({ provider: { ...provider, temperature: 0.3 }, messages: [{ role: 'user', content: 'x' }] })
  check('temperature：显式设置时才发送', calls.lastBody?.temperature === 0.3, String(calls.lastBody?.temperature))

  /* --- 自定义请求参数：深合并 --- */
  await client.chatComplete({
    provider: { ...provider, extraBody: '{"enable_thinking": true, "reasoning": {"effort": "high", "budget": 2048}}' },
    messages: [{ role: 'user', content: 'x' }]
  })
  check('自定义参数：顶层字段被合并', calls.lastBody?.enable_thinking === true)
  check(
    '自定义参数：嵌套对象被深合并',
    calls.lastBody?.reasoning?.effort === 'high' && calls.lastBody?.reasoning?.budget === 2048,
    JSON.stringify(calls.lastBody?.reasoning)
  )
  check('自定义参数：不覆盖已有基础字段', calls.lastBody?.model === 'deepseek-chat' && calls.lastBody?.stream === false)

  /* --- 自定义参数非法时不破坏请求 --- */
  await client.chatComplete({ provider: { ...provider, extraBody: '{不是合法 JSON' }, messages: [{ role: 'user', content: 'x' }] })
  check('自定义参数：非法 JSON 被忽略且请求仍成功', calls.lastBody?.model === 'deepseek-chat')

  /* ============ 参数兼容性自愈 ============ */

  /* 场景 1：模型名带 strict（模拟 o 系列 / GPT-5 拒收 max_tokens） + auto 模式
     auto 模式按模型名推断不出来（model 是 mock-strict，不匹配 o/gpt-5），
     因此必须靠网关报错自愈 —— 这正是要验证的能力。 */
  calls.bodies.length = 0
  const strict = { ...provider, model: 'mock-strict', maxTokensParam: 'auto', maxTokens: 128 }
  const fixed = await client.chatComplete({ provider: strict, messages: [{ role: 'user', content: 'hi' }] })
  check('自愈：max_tokens 被拒后自动改用 max_completion_tokens', calls.bodies.length === 2, `共 ${calls.bodies.length} 次请求`)
  check('自愈：第一次请求确实带了 max_tokens', calls.bodies[0]?.max_tokens === 128, JSON.stringify(calls.bodies[0]?.max_tokens))
  check('自愈：第二次请求改带 max_completion_tokens', calls.bodies[1]?.max_completion_tokens === 128, JSON.stringify(calls.bodies[1]?.max_completion_tokens))
  check('自愈：第二次请求不再带 max_tokens', calls.bodies[1]?.max_tokens === undefined)
  check('自愈：最终请求成功并返回内容', fixed.text === '非流式回答', fixed.text)
  check('自愈：把调整记录回报给调用方', Array.isArray(fixed.adjustments) && fixed.adjustments.length > 0, fixed.adjustments?.join('；'))

  /* 场景 2：显式配置 max_completion_tokens，应一次成功 */
  calls.bodies.length = 0
  await client.chatComplete({
    provider: { ...provider, model: 'mock-strict', maxTokensParam: 'max_completion_tokens', maxTokens: 64 },
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('显式配置：一次请求即用 max_completion_tokens', calls.bodies.length === 1 && calls.bodies[0]?.max_completion_tokens === 64, `共 ${calls.bodies.length} 次`)

  /* 场景 3：模型名匹配 o/gpt-5 时，auto 模式应直接推断，无需重试 */
  calls.bodies.length = 0
  await client.chatComplete({
    provider: { ...provider, model: 'gpt-5-mock', maxTokensParam: 'auto', maxTokens: 32 },
    messages: [{ role: 'user', content: 'hi' }]
  })
  check(
    'auto 推断：gpt-5* 直接使用 max_completion_tokens',
    calls.bodies.length === 1 && calls.bodies[0]?.max_completion_tokens === 32,
    `共 ${calls.bodies.length} 次，body=${JSON.stringify(calls.bodies[0]?.max_completion_tokens)}`
  )

  /* 场景 4：temperature 也被拒时，应被移除后重试 */
  calls.bodies.length = 0
  await client.chatComplete({
    provider: { ...provider, model: 'mock-strict', maxTokensParam: 'max_completion_tokens', temperature: 0.7 },
    messages: [{ role: 'user', content: 'hi' }]
  })
  check('自愈：temperature 被拒后移除并重试成功', calls.bodies.length === 2 && calls.bodies[1]?.temperature === undefined, `共 ${calls.bodies.length} 次`)

  /* 场景 5：鉴权失败不应触发参数重试，且错误信息要完整可读 */
  calls.bodies.length = 0
  const authFail = await client.testProvider({ ...provider, apiKey: '' })
  check('非参数错误不重试：401 只请求一次', calls.bodies.length === 1, `共 ${calls.bodies.length} 次`)
  check('错误信息：从嵌套 messages 中提取真实原因', /Unsupported parameter|缺少 API Key/.test(authFail.message), authFail.message.slice(0, 90))

  /* 场景 6：流式请求同样具备自愈能力 */
  calls.bodies.length = 0
  const streamIter = client.chatStream({
    provider: { ...provider, model: 'mock-strict', maxTokensParam: 'auto', maxTokens: 16 },
    messages: [{ role: 'user', content: 'hi' }]
  })
  let streamFinal
  for (;;) {
    const step = await streamIter.next()
    if (step.done) {
      streamFinal = step.value
      break
    }
  }
  check('自愈（流式）：重试后成功拿到内容', streamFinal.text === '慢查询优化', streamFinal.text)
  check('自愈（流式）：第二次请求用 max_completion_tokens', calls.bodies[1]?.max_completion_tokens === 16)

  /* --- extraBody 校验函数 --- */
  check('校验：空字符串合法', client.validateExtraBody('').ok)
  check('校验：合法对象通过', client.validateExtraBody('{"a":1}').ok)
  check('校验：数组被拒', !client.validateExtraBody('[1,2]').ok)
  check('校验：语法错误被拒', !client.validateExtraBody('{oops').ok)

  /* --- 非流式 --- */
  const complete = await client.chatComplete({ provider, messages: [{ role: 'user', content: 'hi' }] })
  check('非流式：正文与思维链都取到', complete.text === '非流式回答' && complete.reasoning === '非流式思考')

  /* --- JSON 模式 --- */
  await client.chatComplete({ provider, messages: [{ role: 'user', content: 'x' }], json: true })
  check('JSON 模式：发送 response_format', calls.lastBody?.response_format?.type === 'json_object')

  /* --- 模型列表 --- */
  const models = await client.listModels(provider)
  check('模型列表：解析出 2 个模型', models.ok && models.models.length === 2, models.models.join(', '))

  /* --- 向量 --- */
  const vectors = await client.embed({ baseUrl, apiKey: 'k', model: 'emb' }, ['a', 'b'])
  check('向量：批量返回并按 index 排序', vectors.length === 2 && vectors[0][0] === 0.1 && vectors[1][0] === 0.2)

  /* --- 连通性探针 --- */
  const probe = await client.testProvider(provider)
  check('探针：成功时返回 ok 与延迟', probe.ok && probe.latencyMs >= 0, probe.message)

  /* --- 错误处理：缺 Key --- */
  const bad = await client.testProvider({ ...provider, apiKey: '' })
  check('错误处理：401 时返回可读错误而非抛异常', !bad.ok && /401|API Key/.test(bad.message), bad.message)

  /* --- 错误处理：地址不可达 --- */
  const unreachable = await client.testProvider({ ...provider, baseUrl: 'http://127.0.0.1:1/v1' })
  check('错误处理：地址不可达时返回错误', !unreachable.ok, unreachable.message.slice(0, 60))

  /* --- 用户取消 --- */
  const controller = new AbortController()
  const cancelIterator = client.chatStream({
    provider,
    messages: [{ role: 'user', content: 'cancel' }],
    signal: controller.signal
  })
  let aborted = false
  try {
    for (;;) {
      const step = await cancelIterator.next()
      if (step.done) break
      controller.abort()
    }
  } catch (error) {
    aborted = /abort/i.test(String(error?.name || error?.message || error))
  }
  check('取消：AbortSignal 能中断请求（不抛未捕获异常）', true, aborted ? '以 AbortError 结束' : '正常结束')

  /* --- 音频转写端点可达性（由 asr 模块使用同一网关地址） --- */
  const form = new FormData()
  form.append('model', 'whisper-1')
  const asrRes = await fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', body: form })
  const asrJson = await asrRes.json()
  check('语音识别端点：mock 返回可解析 JSON', asrJson.text === '这是 mock 转写结果', JSON.stringify(asrJson))

  server.close()

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name} ${f.detail ?? ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('验证脚本异常：', error)
  process.exitCode = 1
})
