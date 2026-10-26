// 可编程的模型桩：按 system prompt 区分「评估/复盘/出题」
const mock = {
  evalScores: [],
  defaultScore: 70,
  questionIndex: 0,
  reviewText: '# 复盘报告\n\n平均分...\n',
  failNextQuestion: false,
  calls: []
}
function chatComplete(opts) {
  const system = opts.messages[0].content
  const user = opts.messages[opts.messages.length - 1].content
  mock.calls.push({ system, user })
  if (system.includes('面试评估官')) {
    const score = mock.evalScores.length ? mock.evalScores.shift() : mock.defaultScore
    if (score === 'throw') return Promise.reject(new Error('评分服务不可用'))
    return Promise.resolve({ text: '```json\n' + JSON.stringify({ score, comment: '点评' + score }) + '\n```' })
  }
  if (system.includes('面试教练')) return Promise.resolve({ text: mock.reviewText })
  if (mock.failNextQuestion) { mock.failNextQuestion = false; return Promise.reject(new Error('出题失败')) }
  mock.questionIndex += 1
  return Promise.resolve({ text: '问题' + mock.questionIndex + '？' })
}
module.exports = { chatComplete, __mock: mock }
