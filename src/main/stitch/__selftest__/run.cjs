/**
 * 长截图拼接自测（纯函数，不需要屏幕）。
 *
 * 运行：
 *   node src/main/stitch/__selftest__/run.cjs
 *
 * 用合成图验证：能识别重叠、按重叠裁剪拼接、内容顺序正确；
 * 无重叠时如实标记而不是产生错位图；宽度不一致时安全裁剪。
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

const { stitchImages, findOverlap } = require(path.join(ROOT, 'src/shared/stitch.ts'))

const RESULTS = []
function check(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`)
}

/* ---------------- 合成图工具 ---------------- */

const WIDTH = 120
const HEIGHT = 100

/**
 * 生成一张「页面」的截图：整页高度 totalHeight，
 * 从 scrollTop 处截取 HEIGHT 行，每行颜色由行号决定（便于验证拼接顺序）。
 */
function makePage(totalHeight, scrollTop, width = WIDTH) {
  const data = new Uint8ClampedArray(width * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    const pageRow = scrollTop + y
    if (pageRow >= totalHeight) break
    // 每行一个确定的三元组；再加一点列向变化，避免行签名退化
    const r = (pageRow * 7) % 256
    const g = (pageRow * 13) % 256
    const b = (pageRow * 29) % 256
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // 加入列向结构（模拟文字/线条），让不同行的签名彼此区分度更高，
      // 否则颜色空间太窄，无关的行也会凑巧落进容差，测试就失去意义
      const mod = (x * 17 + pageRow * 11) % 64
      data[i] = (r + mod) % 256
      data[i + 1] = (g + mod * 2) % 256
      data[i + 2] = (b + mod * 3) % 256
      data[i + 3] = 255
    }
  }
  return { width, height: HEIGHT, data }
}

/**
 * 取某一行前 3 个像素的颜色作为指纹，用于校验拼接结果的内容来源。
 * 列结构固定，因此同一 pageRow 的指纹必然一致。
 */
function rowColor(image, y) {
  const i = (y * image.width) * 4
  return [image.data[i], image.data[i + 1], image.data[i + 2]]
}

function expectedColorForPageRow(pageRow) {
  const r = (pageRow * 7) % 256
  const g = (pageRow * 13) % 256
  const b = (pageRow * 29) % 256
  const mod = (0 * 17 + pageRow * 11) % 64
  return [(r + mod) % 256, (g + mod * 2) % 256, (b + mod * 3) % 256]
}

function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/* ---------------- 用例 ---------------- */

function main() {
  /* 1. 单图直接返回 */
  const single = stitchImages([makePage(500, 0)])
  check('单图：原样返回并给出提示', single.image.height === HEIGHT && single.notes.length > 0, single.notes.join('；'))

  /* 2. 精确重叠：两屏重叠 30 行 */
  const page1 = makePage(400, 0) // 覆盖页 0..99
  const page2 = makePage(400, 70) // 覆盖页 70..169，与上一屏重叠 30 行
  const overlap = findOverlap(page1, page2)
  check('重叠检测：识别出 30 行重叠', Math.abs(overlap.overlap - 30) <= 3, `实际 ${overlap.overlap}，差异 ${overlap.diff.toFixed(1)}`)

  const stitched = stitchImages([page1, page2])
  check('拼接：高度 = 100 + (100 - 30)', Math.abs(stitched.image.height - 170) <= 3, `实际 ${stitched.image.height}`)
  check('拼接：全部相邻图都匹配成功', stitched.allMatched === true, stitched.notes.join('；') || '无异常')
  check(
    '拼接：首行内容正确',
    sameColor(rowColor(stitched.image, 0), expectedColorForPageRow(0)),
    JSON.stringify(rowColor(stitched.image, 0))
  )
  check(
    '拼接：重叠处无误（第 99 行应为页 99）',
    sameColor(rowColor(stitched.image, 99), expectedColorForPageRow(99)),
    `${JSON.stringify(rowColor(stitched.image, 99))} 期望 ${JSON.stringify(expectedColorForPageRow(99))}`
  )
  check(
    '拼接：末尾内容正确（第 169 行应为页 169）',
    sameColor(rowColor(stitched.image, stitched.image.height - 1), expectedColorForPageRow(169)),
    JSON.stringify(rowColor(stitched.image, stitched.image.height - 1))
  )

  /* 3. 三屏连续拼接 */
  // 滚动 70 → 相邻重叠 30 行（高于 24px 最小重叠下限）
  const three = stitchImages([makePage(500, 0), makePage(500, 70), makePage(500, 140)])
  check('三屏：高度正确', Math.abs(three.image.height - (HEIGHT + 2 * (HEIGHT - 30))) <= 6, `实际 ${three.image.height}（期望 ${HEIGHT + 2 * (HEIGHT - 30)}）`)
  check('三屏：全部匹配', three.allMatched === true)
  check(
    '三屏：最后一行内容正确',
    sameColor(rowColor(three.image, three.image.height - 1), expectedColorForPageRow(239)),
    JSON.stringify(rowColor(three.image, three.image.height - 1))
  )

  /* 4. 完全无重叠：应如实标记，不产生错位 */
  const a = makePage(400, 0)
  const b = makePage(400, 200) // 与 a 完全不相邻
  const noOverlap = stitchImages([a, b])
  check('无重叠：被标记为未匹配', noOverlap.allMatched === false, noOverlap.notes.join('；'))
  check('无重叠：仍安全堆叠（高度 = 两屏之和）', noOverlap.image.height === HEIGHT * 2, `实际 ${noOverlap.image.height}`)
  check('无重叠：给出可读提示', noOverlap.notes.some((n) => /滚动过快|留白|未找到重叠/.test(n)), noOverlap.notes[0])

  /* 5. 宽度不一致：按第一张宽度裁剪，不越界 */
  const wide = makePage(400, 0, 200)
  const narrow = makePage(400, 70, 80)
  const mixed = stitchImages([wide, narrow])
  check('宽度不一致：输出宽度取第一张', mixed.image.width === 200, String(mixed.image.width))
  check('宽度不一致：数据长度与尺寸一致', mixed.image.data.length === mixed.image.width * mixed.image.height * 4, `${mixed.image.data.length} vs ${mixed.image.width * mixed.image.height * 4}`)

  /* 6. 空输入 */
  const empty = stitchImages([])
  check('空输入：返回空图且不抛异常', empty.image.width === 0 && empty.image.height === 0)

  /* 7. 透明像素应被忽略（模拟滚动时出现的固定浮层） */
  const withOverlayA = makePage(400, 0)
  const withOverlayB = makePage(400, 70)
  // 在 B 的顶部 20 行叠一层半透明浮层（alpha 低 → 签名忽略）
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      withOverlayB.data[i + 3] = 4
    }
  }
  const overlay = findOverlap(withOverlayA, withOverlayB)
  check('透明浮层：仍能找到重叠', overlay.overlap > 0, `找到 ${overlay.overlap} 行`)

  /* 7.5 重叠低于下限（24px）时不识别——这是刻意的取舍，注释说明 */
  const tinyOverlap = stitchImages([makePage(400, 0), makePage(400, 90)])
  check(
    '极小重叠（10px，低于 24px 下限）：如实标记为未匹配而不是错位拼接',
    tinyOverlap.allMatched === false && tinyOverlap.image.height === HEIGHT * 2,
    `实际高度 ${tinyOverlap.image.height}`
  )

  /* 8. 滚动幅度很大时的边界（重叠接近 0） */
  const far = makePage(600, 99)
  const farStitch = stitchImages([makePage(600, 0), far])
  check('重叠为 0 的相邻屏：不崩溃且高度合理', farStitch.image.height >= HEIGHT, `实际 ${farStitch.image.height}`)

  /* 9. 整帧重复（用户没滚动就截了两次）应跳过而不是叠一份 */
  const same = makePage(400, 0)
  const dup = stitchImages([same, makePage(400, 0)])
  check('整帧重复：高度不翻倍', dup.image.height === HEIGHT, `实际 ${dup.image.height}`)
  check('整帧重复：给出可读提示', dup.notes.some((n) => /未检测到滚动|基本相同/.test(n)), dup.notes.join('；'))

  /* 10. 只改动屏幕上一小块（模拟滚动窗口内的小面板）→ 仍应识别为整帧重叠 */
  const screenA = makePage(600, 0)
  const screenB = makePage(600, 0)
  for (let y = 10; y < 40; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      screenB.data[i] = 255
      screenB.data[i + 1] = 0
      screenB.data[i + 2] = 0
    }
  }
  const smallChange = stitchImages([screenA, screenB])
  check('局部改动：识别为整帧重叠并跳过', smallChange.image.height === HEIGHT, `实际 ${smallChange.image.height}`)

  /* 11. 小幅度滚动（100 行里的 20 行）应正确定位重叠而不是当成整帧重复 */
  const smallScroll = stitchImages([makePage(600, 0), makePage(600, 20)])
  check('小幅滚动：重叠 80 行被正确识别', Math.abs(smallScroll.image.height - (HEIGHT + 20)) <= 2, `实际 ${smallScroll.image.height}（期望 120）`)
  check('小幅滚动：标记为匹配成功', smallScroll.allMatched === true, smallScroll.notes.join('；'))

  const failed = RESULTS.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${RESULTS.length - failed.length}/${RESULTS.length} 通过 =====`)
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail ?? ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
