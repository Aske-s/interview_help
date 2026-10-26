import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getWindow,
  openCaptureWindow,
  openFloatingWindow,
  openInterviewWindow,
  openMainWindow,
  openQuizWindow,
  openQuizbarWindow,
  windowEntries
} from '../windows'
import { appendQa, appendTranscript, createSession, todos } from '../ipc/data'
import { settingsStore } from '../store/settings'
import { live } from '../live/orchestrator'
import { addDocument, knowledgeStore } from '../knowledge'
import { captureAndAnswer } from '../ipc/capture'
import { randomUUID } from 'node:crypto'

/**
 * 开发期辅助（仅在设置了对应环境变量时生效，生产运行完全不走这里）。
 *
 * 用途：本机可能没有显示器/截图权限，靠 Electron 自己的 capturePage 把窗口内容
 * 导出成 PNG，用于核对界面视觉效果。
 *
 *   SUISI_SHOT_DIR=/path/to/dir   开启截图
 *   SUISI_SHOT_DELAY=9000         截图前等待毫秒数
 *   SUISI_SHOT_EXIT=1             截完退出
 *   SUISI_SEED_DEMO=1             写入演示数据，让界面不为空
 */

export function setupDevHarness(): void {
  const dir = process.env['SUISI_SHOT_DIR']
  if (process.env['SUISI_SEED_DEMO'] === '1') void seedDemoData()
  if (!dir) return

  mkdirSync(dir, { recursive: true })

  openMainWindow()
  // 等主窗口渲染完再开其余窗口，避免同时抢占首帧
  setTimeout(() => {
    openFloatingWindow()
    openQuizWindow()
    openInterviewWindow()
  }, 2000)

  const delay = Number(process.env['SUISI_SHOT_DELAY'] ?? 9000)
  setTimeout(() => {
    void (async () => {
      if (process.env['SUISI_SYSAUDIO_DRIVE'] === '1') await driveSystemAudio()
      if (process.env['SUISI_USER_PATH'] === '1') await driveUserPath()
      if (process.env['SUISI_SHOT_DRIVE'] === '1') await driveScreenshotHotkey()
      if (process.env['SUISI_QUIZBAR_DRIVE'] === '1') await driveQuizbar()
      if (process.env['SUISI_MODE_DRIVE'] === '1') await driveModeCycle()
      if (process.env['SUISI_QUIZ_DRIVE'] === '1') await driveQuizLongShot()
      if (process.env['SUISI_SETTINGS_DRIVE'] === '1') await driveSettingsTyping()
      if (process.env['SUISI_DEVICE_CHECK'] === '1') await driveDeviceCheck()
      await captureAll(dir)
    })()
  }, delay)
}

/**
 * 驱动主窗口真实点一次「设备与检查 → 开始检查」，并把渲染出的结论读回来。
 *
 * 用途：验证整条链路（界面 → 渲染层真实打开麦克风/摄像头 → IPC 回传 → 落库）
 * 在真实 Electron 里能跑通，而不是只在单测里成立。
 */

/**
 * 驱动主窗口「高级设置 → 模型网关」，在 baseUrl 输入框里**逐字符**输入，
 * 然后读回本地设置文件确认是否真的保存成功。
 *
 * 用途：验证曾经的真实缺陷（整份数组回写 + 过期快照导致丢字）已被修复。
 */

/**
 * 驱动悬浮窗切换模式，验证「切换模式 → 参数真的套用」这条链路。
 */

/**
 * 驱动「快捷操作」工具条：验证点笔试后弹出、控件齐全、悬停显隐与穿透可用。
 */

/**
 * 模拟真实用户路径：进入主界面 → 点「笔试解题」标签 → 报告页面上到底有什么可点。
 * 用于回答「用户点了笔试为什么没看到东西」。
 */
/**
 * 模拟真实用户路径：进主界面 → 点「笔试解题」→ 报告页面内容 → 开始笔试 → 检查悬浮框。
 */
async function driveUserPath(): Promise<void> {
  const main = windowEntries().find(([kind]) => kind === 'main')?.[1]
  if (!main) return
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    const r1 = await main.webContents.executeJavaScript(`
      (() => {
        const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '笔试解题')
        if (t) { t.click(); return 'clicked-tab' }
        return 'no-tab'
      })()
    `)
    console.log(`[user-path] 点击「笔试解题」标签：${r1}`)
    await sleep(900)

    const page = await main.webContents.executeJavaScript(`
      (() => {
        const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
        const text = document.body.innerText
        return {
          buttons: buttons.slice(0, 20),
          hasPrep: ['准备', '名称', '截图来源', '本机截图', '为他机', '远程'].some((k) => text.indexOf(k) >= 0),
          len: text.length
        }
      })()
    `)
    console.log(`[user-path] 笔试标签下按钮：${JSON.stringify(page.buttons)}`)
    console.log(`[user-path] 是否有「准备」内容：${page.hasPrep ? '有' : '❌ 没有'}（页面文字 ${page.len} 字符）`)

    const sources = await main.webContents.executeJavaScript(`
      (() => {
        const t = document.body.innerText
        return {
          local: t.indexOf('本机截图答题') >= 0,
          serve: t.indexOf('为他机截图答题') >= 0,
          remote: t.indexOf('远程截图') >= 0,
          naming: t.indexOf('本次笔试名称') >= 0
        }
      })()
    `)
    console.log(`[user-path] 准备页三项来源：${JSON.stringify(sources)}`)

    // 关掉开发驱动自己开的笔试窗口，否则无法判断「点开始笔试」有没有弹大窗口
    const preQuiz = getWindow('quiz')
    if (preQuiz) {
      preQuiz.close()
      await sleep(500)
    }
    await main.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '笔试解题'); if (b) b.click(); return true })()
    `)
    await sleep(600)

    const started = await main.webContents.executeJavaScript(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始笔试')
        if (!b) return 'not-found'
        b.click()
        return 'clicked'
      })()
    `)
    console.log(`[user-path] 点击「开始笔试」：${started}`)
    await sleep(3500)
    const bar = getWindow('quizbar')
    console.log(`[user-path] 悬浮框：${bar ? `✅ 已弹出 ${bar.getSize().join('×')}` : '❌ 未弹出'}`)
    console.log(`[user-path] 大窗口是否被打开：${getWindow('quiz') ? '是（不符合原版）' : '❌ 否（符合原版：直接进透明框）'}`)

    if (!bar) return
    // 可用性：尺寸 / 拖动区 / 缩放手柄 / 内容区
    const usable = await bar.webContents.executeJavaScript(`
      (() => {
        const dragEls = [...document.querySelectorAll('.ss-drag')]
        const grip = [...document.querySelectorAll('div')].find((d) => (d.getAttribute('title') || '').includes('拖动调整窗口大小'))
        const dragW = dragEls.reduce((s, e) => {
          const r = e.getBoundingClientRect()
          const btns = [...e.querySelectorAll('button')].reduce((a, b) => a + b.getBoundingClientRect().width, 0)
          return s + Math.max(0, r.width - btns)
        }, 0)
        return {
          dragAreaWidth: Math.round(dragW),
          hasGrip: Boolean(grip),
          hasContent: [...document.querySelectorAll('div')].some((d) => (d.textContent || '').includes('识题结果显示在这里'))
        }
      })()
    `)
    console.log(`[user-path] 可拖动区域：${usable.dragAreaWidth}px ${usable.dragAreaWidth > 60 ? '✅' : '❌'}`)
    console.log(`[user-path] 缩放手柄：${usable.hasGrip ? '✅' : '❌'} 内容区：${usable.hasContent ? '✅' : '❌'}`)
    console.log(`[user-path] 窗口尺寸：${bar.getSize().join('×')} 可缩放=${bar.isResizable()}`)

    await bar.webContents.executeJavaScript(`window.api.bar.setSize(520, 420)`).catch(() => undefined)
    await sleep(700)
    console.log(`[user-path] setSize(520,420) 后：${bar.getSize().join('×')} ${bar.getSize()[0] === 520 ? '✅ 可拉大' : '❌'}`)

    // 退出入口
    const exitUi = await bar.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '退出')
        return btn ? { ok: true, title: btn.getAttribute('title') } : { ok: false }
      })()
    `)
    console.log(`[user-path] 退出按钮：${exitUi.ok ? `✅ 有（提示「${exitUi.title}」）` : '❌ 没有'}`)
  } catch (e) {
    console.error('[user-path] 失败：', e)
  }
}

/** 抓一屏并报告规格（格式/尺寸/体积），用于验证截图符合原版行为 */
async function captureSpecForTest(): Promise<{ format: string; width: number; height: number; bytes: number }> {
  const { captureScreenDataUrl } = await import('../capture')
  const { allWindows } = await import('../windows')
  const { nativeImage } = await import('electron')
  const dataUrl = await captureScreenDataUrl({ hideWindows: allWindows() })
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl)
  const format = m ? (m[1] === 'jpeg' ? 'jpeg' : m[1]) : 'unknown'
  const buf = m ? Buffer.from(m[2], 'base64') : Buffer.alloc(0)
  const img = nativeImage.createFromBuffer(buf)
  const size = img.getSize()
  return { format, width: size.width, height: size.height, bytes: buf.length }
}

/**
 * 复现「按快捷键截图」。
 * 对齐原版：整屏直出、不开选区遮罩（全屏遮罩容易被在线笔试平台检测到）。
 */
async function driveScreenshotHotkey(): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    // 先开笔试悬浮窗，才能验证「答案/报错是否显示在卡片上」
    openQuizbarWindow()
    await sleep(2500)
    console.log('[shot-drive] 模拟按下截图快捷键（热键真实入口）')
    const started = await captureAndAnswer()
    console.log(`[shot-drive] 抓屏并识题：${JSON.stringify(started)}`)
    await sleep(1200)
    console.log(`[shot-drive] 选区遮罩窗口：${getWindow('capture') ? '❌ 不该出现' : '✅ 未创建（整屏直出）'}`)

    // 答案是否真的到达界面（曾经因为参数个数不匹配，永远停在「生成中」）
    const bar = getWindow('quizbar')
    if (bar) {
      const ui = await bar.webContents.executeJavaScript(`
        (() => {
          const t = document.body.innerText
          return {
            waiting: t.indexOf('等待生成') >= 0,
            failed: t.indexOf('失败') >= 0 || t.indexOf('未配置') >= 0 || t.indexOf('权限') >= 0,
            sample: t.slice(0, 200),
            buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12)
          }
        })()
      `)
      console.log(`[shot-drive] 界面状态：等待生成=${ui.waiting} 已给出失败原因=${ui.failed}`)
      console.log(`[shot-drive] 卡片内容：${JSON.stringify(ui.sample)}`)
      console.log(`[shot-drive] 卡片按钮：${JSON.stringify(ui.buttons)}`)
      console.log(
        `[shot-drive] ${ui.failed ? '✅ 失败时明确报错（不再无声卡住）' : ui.waiting ? '⚠️ 仍在等待（若网关已配置说明流未到达）' : '✅ 已拿到结果/已结束'}`
      )
    }
  } catch (e) {
    console.error('[shot-drive] 失败：', e)
  }
}

/**
 * 工具条：弹出、控件、悬停显隐、穿透。
 */
/**
 * 验证系统音频采集链路：设置 → 开始 → 采集帧 → 推给编排层 → 流式识别会话。
 * 这是「选了系统音频但没反应」唯一能定位到底哪一环断掉的办法。
 */
async function driveSystemAudio(): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    // 只开系统音频，逼出问题
    settingsStore.patch({
      audio: { micEnabled: false, systemAudioEnabled: true },
      asr: { ...settingsStore.get().asr, kind: 'dashscope-realtime' }
    })
    console.log('[sysaudio] 已设置：仅系统音频 + 流式通道')

    const floating = openFloatingWindow()
    await sleep(2500)

    // 记录渲染层采集回调
    await floating.webContents.executeJavaScript(`
      (() => {
        window.__frames = 0; window.__err = '';
        return true
      })()
    `)

    // 触发界面上的「开始」
    const clicked = await floating.webContents.executeJavaScript(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => /开始/.test(x.textContent || ''))
        if (!b) return 'no-start-button'
        b.click()
        return 'clicked'
      })()
    `)
    console.log(`[sysaudio] 点击开始：${clicked}`)
    await sleep(9000)

    const report = await floating.webContents.executeJavaScript(`
      (() => ({
        text: (document.body.innerText || '').slice(0, 260),
        frameGuess: window.__frames ?? null
      }))()
    `)
    console.log(`[sysaudio] 界面文字：${JSON.stringify(report.text)}`)

    const st = live.getState()
    console.log(`[sysaudio] 编排层状态：running=${st.running} asr=${st.asr} lastTranscript=${JSON.stringify(st.lastTranscript)} hearing=${st.hearing}`)
    console.log('[sysaudio] 若界面出现「未能获取系统音频」或超时提示，说明采集这一环断了')
  } catch (e) {
    console.error('[sysaudio] 驱动失败：', e)
  }
}

async function driveQuizbar(): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    const main = windowEntries().find(([kind]) => kind === 'main')?.[1]
    await main?.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '笔试解题'); if (b) b.click(); return true })()
    `)
    await sleep(700)
    await main?.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始笔试'); if (b) b.click(); return true })()
    `)
    await sleep(3000)

    const bar = getWindow('quizbar')
    if (!bar) {
      console.log('[quizbar-drive] ❌ 工具条没有弹出')
      return
    }
    const probe = await bar.webContents.executeJavaScript(`
      (() => ({
        hasApi: typeof window.api !== 'undefined',
        apiKeys: window.api ? Object.keys(window.api) : null
      }))()
    `)
    console.log(`[quizbar-drive] window.api：${JSON.stringify(probe)}`)
    const controls = await bar.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].map((b) => b.getAttribute('title') || b.textContent.trim())
    `)
    console.log(`[quizbar-drive] 控件：${JSON.stringify(controls)}`)

    // 笔试界面要素（原版 quiz.* / qz.* / quizCard.*）
    const quizUi = await bar.webContents.executeJavaScript(`
      (() => {
        const text = document.body.innerText
        const selects = [...document.querySelectorAll('select')].map((s) => ({
          value: s.value,
          options: [...s.options].map((o) => o.textContent)
        }))
        return {
          emptyState: text.includes('识题结果显示在这里'),
          hasKind: text.includes('题型'),
          hasMode: text.includes('模式'),
          selects
        }
      })()
    `)
    console.log(`[quizbar-drive] 空态「识题结果显示在这里」：${quizUi.emptyState ? '✅' : '❌'}`)
    console.log(`[quizbar-drive] 底部栏：题型=${quizUi.hasKind ? '✅' : '❌'} 模式=${quizUi.hasMode ? '✅' : '❌'}`)
    console.log(`[quizbar-drive] 下拉项：${JSON.stringify(quizUi.selects)}`)

    // 悬停显隐：开启后由主进程判定光标位置，渲染层整体淡出
    const onReveal = await bar.webContents.executeJavaScript(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '悬停显隐')
        if (b) b.click()
        return Boolean(b)
      })()
    `)
    await sleep(500)
    const st = settingsStore.get()
    console.log(`[quizbar-drive] 悬停显隐：${st.stealth.hoverReveal ? '✅ 已开启（鼠标移开时整个悬浮窗会淡出）' : '❌ 未开启'}（点击生效=${onReveal}）`)

    // 穿透：必须验证**窗口本身**真的不再接收鼠标，而不只是设置值变了
    const before = bar.isMovable()
    await bar.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '穿透'); if (b) b.click(); return true })()
    `)
    await sleep(900)
    const setting = settingsStore.get().stealth.clickThrough
    console.log(`[quizbar-drive] 鼠标穿透设置值：${setting ? '✅ 已开启' : '❌ 未开启'}`)
    // 用主进程侧的真实状态判断：穿透开启后窗口不应再接收鼠标事件
    const dom = await bar.webContents.executeJavaScript(`
      (() => {
        const t = document.body.innerText
        return { warned: t.indexOf('鼠标穿透已开启') >= 0, hint: t.indexOf('关闭') >= 0 }
      })()
    `)
    console.log(`[quizbar-drive] 界面提示穿透已开启：${dom.warned ? '✅' : '❌'}（含关闭指引=${dom.hint}）`)
    console.log(`[quizbar-drive] 窗口仍可移动（穿透不影响拖动配置）：${before}`)

    /*
     * 验证穿透真的被应用。
     *
     * 注意：不能用 webContents.sendInputEvent 验证 —— 它是直接注入渲染层，
     * 绕过了操作系统级的 setIgnoreMouseEvents，测出来永远「仍能收到」（我踩过这个坑）。
     * Electron 也没有 setIgnoreMouseEvents 的 getter。
     * 这次回归的本质是「对工具条窗口根本没调用过」，
     * 所以直接监视该窗口上的调用记录即可精准复现。
     */
    const calls: Array<[boolean, unknown]> = []
    const original = bar.setIgnoreMouseEvents.bind(bar)
    ;(bar as unknown as { setIgnoreMouseEvents: unknown }).setIgnoreMouseEvents = (
      value: boolean,
      opts?: unknown
    ): void => {
      calls.push([value, opts])
      original(value, opts as never)
    }

    // 关掉再打开，观察调用
    await bar.webContents.executeJavaScript(`window.api.bar.releaseClickThrough()`)
    await sleep(600)
    calls.length = 0
    await bar.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '穿透'); if (b) b.click(); return true })()
    `)
    await sleep(900)
    const setTrue = calls.some(([v]) => v === true)
    const forwarded = calls.some(([, o]) => Boolean((o as { forward?: boolean } | undefined)?.forward))
    console.log(`[quizbar-drive] 开启穿透时对工具条调用了 setIgnoreMouseEvents(true)：${setTrue ? '✅' : '❌ 这就是回归'}`)
    console.log(`[quizbar-drive] 带 forward:true（悬停仍能收到移动）：${forwarded ? '✅' : '❌'}  调用记录=${JSON.stringify(calls)}`)
    // 重新开启，验证快捷键必须能解开（否则用户被困住）
    await bar.webContents.executeJavaScript(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '穿透'); if (b) b.click(); return true })()
    `)
    await sleep(700)
    const ctKey = await bar.webContents.executeJavaScript(`window.api.bar.clickThroughHotkey()`)
    console.log(`[quizbar-drive] 穿透解锁快捷键：${ctKey}`)
    await bar.webContents.executeJavaScript(`window.api.bar.releaseClickThrough()`)
    await sleep(600)
    console.log(`[quizbar-drive] 解除后设置值：${settingsStore.get().stealth.clickThrough ? '❌ 仍开启' : '✅ 已关闭'}`)
  } catch (e) {
    console.error('[quizbar-drive] 失败：', e)
  }
}

async function driveModeCycle(): Promise<void> {
  const floating = windowEntries().find(([kind]) => kind === 'floating')?.[1]
  if (!floating) {
    console.log('[mode-drive] 未找到悬浮窗')
    return
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  try {
    const before = settingsStore.get()
    console.log(`[mode-drive] 切换前：mode=${before.activeModeId} 透明度=${before.ui.opacity} 声纹=${before.voiceprint.enabled}`)

    // 点悬浮窗里的「下一个角色」
    const clicked = await floating.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '下一个角色')
        if (!btn) return 'not-found'
        btn.click()
        return 'clicked'
      })()
    `)
    console.log(`[mode-drive] 点击「下一个角色」：${clicked}`)
    await sleep(900)

    const after = settingsStore.get()
    const active = after.modes.find((m) => m.id === after.activeModeId)
    console.log(`[mode-drive] 切换后：mode=${after.activeModeId}（${active?.name}） 透明度=${after.ui.opacity} 声纹=${after.voiceprint.enabled}`)
    console.log(`[mode-drive] 模式数量仍为 ${after.modes.length}（不应被清空）`)
    // 注意单位：模式是 0-100，ui.opacity 是 0-1（0.15-1 区间）
    const expectedOpacity = Math.min(1, Math.max(0.15, (active?.overlayOpacity ?? 70) / 100))
    const opacityOk = Math.abs(after.ui.opacity - expectedOpacity) < 1e-9
    const voiceOk = after.voiceprint.enabled === active?.excludeSelfVoice
    console.log(
      `[mode-drive] 透明度跟随：${opacityOk ? '✅' : '❌'}（${after.ui.opacity} vs 期望 ${expectedOpacity}）` +
        ` 声纹跟随：${voiceOk ? '✅' : '❌'}`
    )

    // 再切一次确认能循环
    await floating.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '下一个角色')
        if (btn) btn.click()
        return true
      })()
    `)
    await sleep(900)
    const third = settingsStore.get()
    console.log(`[mode-drive] 再切一次：mode=${third.activeModeId}（${third.modes.find((m) => m.id === third.activeModeId)?.name}）`)
  } catch (error) {
    console.error('[mode-drive] 驱动失败：', error)
  }
}

async function driveSettingsTyping(): Promise<void> {
  const main = windowEntries().find(([kind]) => kind === 'main')?.[1]
  if (!main) return

  const target = 'https://typed-by-ui.example/v1'
  const settingsFile = join(app.getPath('userData'), 'data', 'settings.json')

  try {
    await main.webContents.executeJavaScript(`
      (() => {
        const nav = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '高级设置')
        if (nav) { nav.click(); return true }
        return false
      })()
    `)
    await new Promise((resolve) => setTimeout(resolve, 700))

    const located = await main.webContents.executeJavaScript(`
      (() => {
        const inputs = [...document.querySelectorAll('input')]
        const el = inputs.find((i) => (i.placeholder || '').includes('deepseek'))
        if (!el) return 'not-found'
        el.setAttribute('data-drive-target', '1')
        el.focus()
        return 'found'
      })()
    `)
    console.log(`[settings-drive] baseUrl 输入框：${located}`)
    if (located !== 'found') return

    // 先清空，避免默认值混入导致比对失真
    await main.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('[data-drive-target="1"]')
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await new Promise((resolve) => setTimeout(resolve, 250))

    for (const ch of target) {
      await main.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector('[data-drive-target="1"]')
          if (!el) return false
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(el, (el.value || '') + ${JSON.stringify(ch)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()
      `)
      // 故意不等 IPC 往返，制造最坏情况的连续输入
      await new Promise((resolve) => setTimeout(resolve, 15))
    }

    await new Promise((resolve) => setTimeout(resolve, 1200))
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      providers: Array<{ id: string; baseUrl: string; model: string }>
    }
    const provider = saved.providers[0]

    const uiValue = await main.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-drive-target="1"]'); return el ? el.value : null })()`
    )

    console.log(
      `[settings-drive] 逐字符输入 ${target.length} 个字符后：` +
        `界面="${uiValue}" 磁盘="${provider.baseUrl}" ` +
        `${provider.baseUrl === target ? '✅ 保存成功' : '❌ 保存失败（丢字）'}`
    )
  } catch (error) {
    console.error('[settings-drive] 驱动失败：', error)
  }
}


/**
 * 驱动笔试窗口走一遍「长截图 → 拼接」链路，验证真实 Electron 下的抓屏与拼接。
 *
 * 由于本环境可能没有屏幕录制权限，抓到的图可能全黑——这本身也是有意义的结论，
 * 因此这里同时报告抓屏是否成功、拼接后的尺寸变化。
 */
async function driveQuizLongShot(): Promise<void> {
  const quiz = windowEntries().find(([kind]) => kind === 'quiz')?.[1]
  if (!quiz) {
    console.log('[quiz-drive] 未找到笔试窗口')
    return
  }
  const click = async (label: string): Promise<string> => {
    const r = await quiz.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
        if (!btn) return 'not-found'
        btn.click()
        return 'clicked'
      })()
    `)
    return r
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  try {
    const dom = await quiz.webContents.executeJavaScript(`
      (() => {
        const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)
        const text = document.body.innerText
        return {
          buttons: buttons.slice(0, 24),
          hasConfig: /代码格式/.test(text) && /结论格式/.test(text) && /编程语言/.test(text),
          hasCases: /测试样例/.test(text),
          hasLangOptions: [...document.querySelectorAll('option')].length
        }
      })()
    `)
    console.log(`[quiz-drive] 界面控件：${JSON.stringify(dom)}`)

    console.log(`[quiz-drive] 进入长截图：${await click('长截图')}`)
    await sleep(400)
    console.log(`[quiz-drive] 第 1 屏：${await click('截取下一屏')}`)
    await sleep(1500)
    // 真实滚动页面，制造部分重叠（否则两帧完全相同，测不出重叠检测）
    const scrolled = await quiz.webContents.executeJavaScript(`
      (() => {
        const target = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 40)
        if (!target) return 'no-scrollable'
        target.scrollTop = Math.floor(target.scrollHeight * 0.35)
        return 'scrolled-to-' + target.scrollTop
      })()
    `)
    console.log(`[quiz-drive] 滚动页面：${scrolled}`)
    await sleep(900)
    console.log(`[quiz-drive] 第 2 屏：${await click('截取下一屏')}`)
    await sleep(1500)

    const before = await quiz.webContents.executeJavaScript(
      `(() => { const img = document.querySelector('img'); return img ? { w: img.naturalWidth, h: img.naturalHeight, count: document.querySelectorAll('img').length } : null })()`
    )
    console.log(`[quiz-drive] 拼接前：${JSON.stringify(before)}`)

    console.log(`[quiz-drive] 触发拼接：${await click('拼接')}`)
    await sleep(4000)

    const after = await quiz.webContents.executeJavaScript(`
      (() => {
        const text = document.body.innerText
        const m = text.match(/拼接自\\s*(\\d+)\\s*屏/)
        const imgs = [...document.querySelectorAll('img')]
        return {
          images: imgs.length,
          frames: m ? Number(m[1]) : null,
          size: imgs[0] ? { w: imgs[0].naturalWidth, h: imgs[0].naturalHeight } : null,
          error: (text.match(/第 \\d+ 屏未找到重叠[^\\n]*/) || [])[0] || null
        }
      })()
    `)
    console.log(`[quiz-drive] 拼接后：${JSON.stringify(after)}`)
    if (after.size && before) {
      const grew = after.size.h > before.h
      console.log(`[quiz-drive] 纵向是否变高：${grew ? '是' : '否'}（${before.h} → ${after.size?.h}）`)
    }
  } catch (error) {
    console.error('[quiz-drive] 驱动失败：', error)
  }
}

async function driveDeviceCheck(): Promise<void> {
  const main = windowEntries().find(([kind]) => kind === 'main')?.[1]
  if (!main) return

  try {
    // 1) 切到「设备与检查」页
    await main.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const nav = btns.find((b) => b.textContent.trim() === '设备与检查')
        if (nav) { nav.click(); return 'nav-clicked' }
        return 'nav-not-found'
      })()
    `)
    await new Promise((resolve) => setTimeout(resolve, 600))

    // 2) 点「开始检查」
    const clicked = await main.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const run = btns.find((b) => b.textContent.trim() === '开始检查')
        if (!run) return 'button-not-found'
        run.click()
        return 'clicked'
      })()
    `)
    console.log(`[device-check] 触发结果：${clicked}`)

    // 3) 等真实采集完成（麦克风 1.6s + 摄像头 0.9s，并发执行）
    await new Promise((resolve) => setTimeout(resolve, 11000))

    // 4) 读回界面上的检查结论
    const report = await main.webContents.executeJavaScript(`
      (() => {
        const text = document.body.innerText
        const lines = text.split('\\n').map((s) => s.trim()).filter(Boolean)
        const start = lines.findIndex((l) => l.includes('开始检查') || l.includes('检查中'))
        const slice = start >= 0 ? lines.slice(start, start + 24) : lines.slice(-24)
        return slice.join(' | ')
      })()
    `)
    console.log('[device-check] 界面结论：', report)

    // 5) 再驱动一次环境检查
    const clicked2 = await main.webContents.executeJavaScript(`
      (() => {
        const btns = [...document.querySelectorAll('button')]
        const run = btns.find((b) => b.textContent.trim() === '重新检测')
        if (!run) return 'button-not-found'
        run.click()
        return 'clicked'
      })()
    `)
    console.log(`[env-check] 触发结果：${clicked2}`)
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const envReport = await main.webContents.executeJavaScript(`
      (() => {
        const lines = document.body.innerText.split('\\n').map((s) => s.trim()).filter(Boolean)
        const start = lines.findIndex((l) => l.includes('环境检查'))
        return start >= 0 ? lines.slice(start, start + 22).join(' | ') : '(未找到环境检查区域)'
      })()
    `)
    console.log('[env-check] 界面结论：', envReport)
  } catch (error) {
    console.error('[device-check] 驱动失败：', error)
  }
}

async function captureAll(dir: string): Promise<void> {
  // 可选：截图前套用缩放，用于核验等比缩放是否真的生效
  const zoom = Number(process.env['SUISI_SHOT_ZOOM'] ?? '')
  if (Number.isFinite(zoom) && zoom > 0) {
    for (const [, win] of windowEntries()) {
      win.webContents.setZoomFactor(zoom)
    }
    // 回读确认 Electron 真的接受了该缩放值
    const readback = windowEntries().map(([kind, win]) => `${kind}=${win.webContents.getZoomFactor()}`)
    console.log(`[shot] 请求缩放 ${zoom}，回读：${readback.join(', ')}`)
    // 缩放后渲染器需要重排并绘制新帧，必须等一帧以上再截图，否则拍到的是旧画面
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }

  for (const [kind, win] of windowEntries()) {
    try {
      // 防录屏会让 capturePage 拿到黑图，截图前临时关掉
      win.setContentProtection(false)
      if (kind === 'floating') win.setOpacity(1)
      const image = await win.webContents.capturePage()
      const file = join(dir, `${kind}.png`)
      writeFileSync(file, image.toPNG())
      console.log(`[shot] ${kind} -> ${file}`)
    } catch (error) {
      console.error(`[shot] ${kind} 失败：`, error)
    }
  }
  if (process.env['SUISI_SHOT_EXIT'] === '1') app.quit()
}

/** 写入一批演示数据，便于核对列表/详情类界面的视觉效果 */
async function seedDemoData(): Promise<void> {
  if (knowledgeStore.kbs.all().length === 0) {
    const kbId = randomUUID()
    const now = Date.now()
    knowledgeStore.kbs.upsert({
      id: kbId,
      name: '我的知识库',
      description: '项目资料与面经',
      createdAt: now,
      updatedAt: now
    })
    // 走公开的 addDocument，分块与向量化都由知识库模块自己处理
    await addDocument(kbId, {
      name: '后端面经.md',
      text: [
        'MySQL 慢查询优化：先开启慢查询日志，再用 EXPLAIN 分析执行计划，重点关注 type、rows、Extra 字段。',
        '索引优化是最常用的手段：检查 WHERE、JOIN、ORDER BY、GROUP BY 字段是否有合适索引，注意避免索引失效。',
        'Redis 缓存穿透可以用布隆过滤器或空值缓存解决；缓存击穿用互斥锁或逻辑过期；缓存雪崩给过期时间加随机值。'
      ].join('\n\n')
    })
  }

  if (todos.all().length === 0) {
    todos.upsert({ id: randomUUID(), text: '整理本周会议纪要', done: false, createdAt: Date.now() })
    todos.upsert({ id: randomUUID(), text: '复习 MySQL 索引与执行计划', done: true, createdAt: Date.now() - 86400000 })
  }

  const sessions = createSession('meeting', '项目复盘会议')
  appendTranscript(sessions.id, {
    id: randomUUID(),
    text: '请先介绍一下你自己',
    source: 'system',
    startMs: 0,
    endMs: 1800,
    final: true
  })
  appendTranscript(sessions.id, {
    id: randomUUID(),
    text: '你们项目里怎么处理慢查询的',
    source: 'system',
    startMs: 3000,
    endMs: 5200,
    final: true
  })
  appendQa(sessions.id, {
    id: randomUUID(),
    question: '你们项目里怎么处理 MySQL 慢查询的？',
    answer:
      '**核心思路：** 先定位问题，再对症下药，通常分两步走。\n\n**排查与定位：**\n\n- 先开启慢查询日志，设置合理阈值，比如超过 1 秒的 SQL 就记下来：`SET GLOBAL slow_query_log = 1`。\n- 拿到慢 SQL 后第一时间用 `EXPLAIN` 分析执行计划，重点看 `type`（全表扫描 ALL 还是走索引 ref/range）、`rows`（扫描行数）、`Extra`（是否出现 Using filesort / Using temporary）。\n- 线上问题还可以用 `SHOW PROCESSLIST` 找到长时间处于 Sending data 或 Locked 状态的查询。\n\n**具体优化手段：**\n\n- **索引优化**：检查 WHERE、JOIN、ORDER BY、GROUP BY 字段是否有合适索引，避免对索引字段使用函数或隐式类型转换。\n- **SQL 语句重写**：把 `SELECT *` 改成只查需要的字段，可能触发索引覆盖、减少回表；大分页用游标或子查询优化。\n- **表结构优化**：大表考虑分区或分表；字段值重复率很高时（如性别）索引效果差，可在业务层过滤。',
    createdAt: Date.now(),
    trigger: 'auto'
  })
}
