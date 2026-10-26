/**
 * 模式（会议/笔试/面试预设）自测。
 *
 * 运行：
 *   node src/main/store/__selftest__/modes.cjs
 *
 * 覆盖：预置模式恒在、脏数据收敛、切换模式真的改变行为、预置模式不可删、
 * 激活/循环切换、以及「模式套用不会清空模式列表」这条关键回归。
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
const DATA_DIR = path.join(os.tmpdir(), `suisi-modes-selftest-${process.pid}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

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
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => DATA_DIR, getName: () => 'x', isPackaged: false },
      ipcMain: { handle: () => {}, on: () => {} },
      BrowserWindow: class {},
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
      globalShortcut: { register: () => true, unregisterAll: () => {} },
      webContents: {},
      shell: {},
      systemPreferences: {}
    }
  }
  return originalLoad.apply(this, [request, ...rest])
}

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

const modes = require(path.join(ROOT, 'src/main/store/modes.ts'))
const { createDefaultModes } = require(path.join(ROOT, 'src/shared/defaults.ts'))
const { settingsStore } = require(path.join(ROOT, 'src/main/store/settings.ts'))

function main() {
  /* ============ 1. 预置模式 ============ */
  const defaults = createDefaultModes()
  check('预置模式：三个（会议/笔试/面试）', defaults.length === 3, defaults.map((m) => m.type).join(','))
  check('预置模式：都有 defaultKey', defaults.every((m) => m.defaultKey), JSON.stringify(defaults.map((m) => m.defaultKey)))
  check('预置模式：笔试带 quizConfig', Boolean(defaults.find((m) => m.type === 'quiz')?.quizConfig))
  check(
    '预置模式：字段与原版对齐（overlayOpacity/excludeSelfVoice/aliyunMaxSentenceSilenceMs）',
    defaults.every((m) => m.overlayOpacity === 70 && m.excludeSelfVoice === false && m.aliyunMaxSentenceSilenceMs === 800)
  )

  /* ============ 2. 首次加载即落盘且有模式 ============ */
  const settings = settingsStore.get()
  check('设置：初始含三个模式', settings.modes.length === 3, `${settings.modes.length} 个`)
  check('设置：activeModeId 有效', settings.modes.some((m) => m.id === settings.activeModeId), settings.activeModeId)

  /* ============ 3. 脏数据收敛 ============ */
  const dirty = modes.normalizeModes([
    null,
    'garbage',
    { id: 'm-dirty', name: '  ', type: 'weird', volume: 9999, overlayOpacity: -5, aliyunMaxSentenceSilenceMs: 1e9, knowledgeBaseIds: [1, 'kb-1', null] },
    { id: 'system:default:meeting', name: '被篡改的预置', type: 'quiz' }
  ])
  check('脏数据：预置模式仍以代码定义为准（3 个）', dirty.filter((m) => m.defaultKey).length === 3)
  const recovered = dirty.find((m) => m.id === 'm-dirty')
  check('脏数据：非法 type 被纠正', recovered && ['meeting', 'quiz', 'interview'].includes(recovered.type), recovered?.type)
  check('脏数据：volume 被夹到 0-100', recovered?.volume === 100, String(recovered?.volume))
  check('脏数据：overlayOpacity 被夹到 20-100', recovered?.overlayOpacity === 20, String(recovered?.overlayOpacity))
  check('脏数据：silenceMs 被夹到 200-5000', recovered?.aliyunMaxSentenceSilenceMs === 5000, String(recovered?.aliyunMaxSentenceSilenceMs))
  check('脏数据：knowledgeBaseIds 只留字符串', JSON.stringify(recovered?.knowledgeBaseIds) === '["kb-1"]', JSON.stringify(recovered?.knowledgeBaseIds))
  check('脏数据：空名字回退', recovered?.name === '默认会议助手', recovered?.name)
  check('脏数据：预置模式没被用户数据覆盖', dirty.find((m) => m.id === 'system:default:meeting')?.name === '默认会议助手')

  /* ============ 4. 套用模式：真的改变行为 ============ */
  const quizMode = { ...defaults[1], autoAnswer: false, excludeSelfVoice: true, overlayOpacity: 55, aliyunMaxSentenceSilenceMs: 1200, answerStyle: 'concise' }
  const patch = modes.modeToSettingsPatch(quizMode)
  check('套用：写入 activeModeId', patch.activeModeId === quizMode.id)
  check('套用：autoAnswer 跟随模式', patch.asrTuning.autoAnswer === false)
  check('套用：静音断句跟随模式', patch.asrTuning.silenceMs === 1200)
  check('套用：声纹过滤跟随模式', patch.voiceprint.enabled === true)
  // 关键：模式口径 0-100 必须换算成界面口径 0-1，否则透明度会被写成 70 而 clamp 成全不透明
  check('套用：透明度单位已换算（55 → 0.55）', patch.ui.opacity === 0.55, String(patch.ui.opacity))
  check('套用：透明度落在合法区间 0.15-1', patch.ui.opacity >= 0.15 && patch.ui.opacity <= 1)
  check(
    '套用：100% 不会超过 1',
    modes.modeToSettingsPatch({ ...defaults[0], overlayOpacity: 100 }).ui.opacity === 1
  )
  check(
    '套用：20% 不会低于 0.15',
    modes.modeToSettingsPatch({ ...defaults[0], overlayOpacity: 20 }).ui.opacity >= 0.15
  )
  check('换算往返：0.7 ↔ 70', modes.uiOpacityToOverlay(modes.overlayOpacityToUi(70)) === 70)

  // 关键回归：套用补丁里绝不能出现 modes 字段（否则会把模式列表清空）
  check('套用：补丁里不含 modes（防止清空模式列表）', !('modes' in patch), Object.keys(patch).join(','))

  /* ============ 5. 回答速度 → 长度上限 ============ */
  check('速度映射：fast=1024', modes.modeMaxTokens({ ...defaults[0], responseSpeed: 'fast' }) === 1024)
  check('速度映射：balanced=2048', modes.modeMaxTokens({ ...defaults[0], responseSpeed: 'balanced' }) === 2048)
  check('速度映射：slow=4096', modes.modeMaxTokens({ ...defaults[0], responseSpeed: 'slow' }) === 4096)

  /* ============ 6. activeMode 回退 ============ */
  const bogus = { ...settings, activeModeId: 'not-exist' }
  check('activeMode：无效 id 回退到第一个', modes.activeMode(bogus)?.id === settings.modes[0].id, modes.activeMode(bogus)?.id)

  /* ============ 7. 真实流程：保存 → 激活 → 读回 ============ */
  const created = modes.normalizeMode(
    { name: '我的销售面试模式', type: 'interview', overlayOpacity: 40, excludeSelfVoice: true },
    defaults[2]
  )
  settingsStore.patch({ modes: [...settingsStore.get().modes, created] })
  check('保存：模式数量 +1', settingsStore.get().modes.length === 4, String(settingsStore.get().modes.length))

  settingsStore.patch(modes.modeToSettingsPatch(created))
  check('激活：activeModeId 已更新', settingsStore.get().activeModeId === created.id)
  check('激活：声纹过滤已开启', settingsStore.get().voiceprint.enabled === true)
  check('激活：透明度已更新（40% → 0.4）', Math.abs(settingsStore.get().ui.opacity - 0.4) < 1e-9, String(settingsStore.get().ui.opacity))
  check('激活后：模式列表没被清空（关键回归）', settingsStore.get().modes.length === 4, String(settingsStore.get().modes.length))

  /* ============ 8. 跨重启保留 ============ */
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'settings.json'), 'utf8'))
  check('落盘：模式已写入 settings.json', saved.modes.length === 4, String(saved.modes.length))
  check('落盘：激活模式已保留', saved.activeModeId === created.id, saved.activeModeId)

  delete require.cache[require.resolve(path.join(ROOT, 'src/main/store/settings.ts'))]
  const fresh = require(path.join(ROOT, 'src/main/store/settings.ts')).settingsStore.get()
  check('重启后：模式仍在', fresh.modes.length === 4, String(fresh.modes.length))
  check('重启后：激活模式仍是自定义的', fresh.activeModeId === created.id)

  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
