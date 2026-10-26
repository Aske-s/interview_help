# cursor-hide — 隐藏真实鼠标（安全模式）

> 随思本地版（suisi-local）的「安全模式下隐藏鼠标」原生组件。macOS 优先。

## 它做什么

安全模式打开「隐藏鼠标」后：

1. 原生 helper 调用 `CGDisplayHideCursor()` 把**真实系统光标**藏起来 → 屏幕共享/录屏里看不到鼠标位置；
2. 随思自己用一个全屏透明窗口画**替代光标**（`src/renderer/src/windows/cursor/App.tsx`）→ 本机用户仍有位置感。

对应原版文案：`隐藏鼠标` / `在共享画面中隐藏真实鼠标。` / `自己可用替代光标，录屏/共享中不显示真实鼠标`。

## ⚠️ 最关键的风险：计数 + 退出不恢复

`CGDisplayHideCursor` 是**按调用次数计数**的，必须成对调用；
并且**进程退出不会自动恢复光标**。一旦「隐藏了但没恢复」，使用者的鼠标就看不见了
——这比键盘防护留下残留更严重。所以本组件有三层保护：

| 层 | 机制 | 效果 |
| --- | --- | --- |
| 1 | `--hold` 常驻模式：收到 SIGTERM/SIGINT/SIGHUP 时**先 `Show` 再退出** | 正常关闭、`disable` 都不会留下隐藏 |
| 2 | `--parent-pid` 父进程看门狗（每 2 秒检查）：父进程消失时**先 `Show` 再退出** | Electron 崩溃/被强杀也不会留下隐藏 |
| 3 | `--force-show` 独立兜底子命令 + 主进程 `show()`/`shutdown()` 里**无条件**补一次 | 任何异常残留都能手动/自动拉回来 |

额外设计：**隐藏一律用 `--hold`，不用一次性 `--hide`**
（`--hide` 只用于自测/人工排查）。这样 hide 与 show 在**同一个进程内配对**，
即使将来 macOS 改了计数语义（全局计数 vs 每进程计数）也不会失配。

`--force-show` 的补 Show 次数是**有界**的：`max(1, min(台账欠账, 8))`。
既保证至少执行一次恢复，又不会因为狂点「恢复」把计数狂减到难以预料的值
（计数若允许变负，过多的 Show 可能让之后单次 Hide 不再生效）。

主进程侧还有 `process.once('exit')` 兜底向 holder 发 SIGTERM、
`shutdown()` 幂等（重复调用也会再补一次恢复）。

## 实测发现（macOS 26.6.1 arm64，2026-10-22）

1. **`CGCursorIsVisible()` 不能用来判断可见性。**
   它在 macOS 26 SDK 的 `CGRemoteOperation.h` 里被标记为
   `API_DEPRECATED("No longer supported", macos(10.3,10.9))`，**直接调用无法编译**；
   用 `dlsym` 能取到符号（CoreGraphics 再导出了 SkyLight 的 `SLCursorIsVisible`），
   但实测：
   - 在 hide 之后立刻查询，它**仍返回 1**；`SLCursorIsDrawnInFramebuffer`(恒 0)、
     `SLSHardwareCursorActive`(恒 1) 同样不随隐藏状态变化；
   - 但在**打字/鼠标静止**等场景下，它会**瞬时返回 0**（系统「键入时自动隐藏光标」之类），
     连续采样 8 次可以稳定为 1，偶发一次 0。

   → 结论：这个查询**既不真也不假，不可作为状态判据**。
   因此：`--status` 会同时输出「系统查询值(`CURSOR_VISIBLE`)」和「我们自己的台账」，
   而主进程 `isHidden()` **以台账为准**（确定性，不会因瞬时 0 误报「随思正在隐藏」）；
   `CURSOR_VISIBLE` 只作诊断参考。自测里有一条专门的回归用例（3e）守住这个行为。
2. **`screencapture -C` 不能用来截图验证。**
   实测整屏（2880×1800）对比带/不带 `-C` 的截图只差 **20 像素**（且位置不是光标处），
   说明这台机器上 `-C` 根本没有把光标画进截图。
3. `CGDisplayHideCursor` / `CGDisplayShowCursor` 在 2 块显示器上均返回
   `kCGErrorSuccess(0)`；`--probe` 的「Hide 后立刻 Show」净零自检通过（`HIDE_OK=1`）。
4. **清理路径实测（全部通过）**：

   | 场景 | 结果 |
   | --- | --- |
   | `--dry-run` 收到 SIGTERM（不碰光标） | `CURSOR_RESTORED=1` → `CURSOR_STOPPED=1`，退出码 0，无残留 |
   | 父进程 `kill -9` 后孤儿 `--dry-run` | 自检输出恢复标记后自行退出，无残留 |
   | `--hold` 常驻中被 `kill -9`（真实隐藏，无清理机会） | `--status` 报 `STALE=1 / HIDDEN=1`；`--force-show` 后 `LEDGER_COUNT=0 / HIDDEN=0`，恢复成功 |
   | 标准序列 `--hide → --status → --show → --status` | 依次 `CURSOR_HIDDEN=1` → `LEDGER_COUNT=1 / STALE=1 / HIDDEN=1` → `CURSOR_SHOWN=1` → `LEDGER_COUNT=0 / HIDDEN=0` |

> 结论：**软件层面无法在本机客观验证「光标确实看不见了」**。
> 隐藏/恢复的调用、计数配平、台账归零都能验证，但「眼睛看到的效果」请人工确认一次：
> ```bash
> ./native/cursor-hide/cursor-hide --hide; sleep 2; ./native/cursor-hide/cursor-hide --force-show
> ```
> 这 2 秒内鼠标应不可见（但移动/点击仍然有效），命令结束后必须恢复可见。

## 构建与安装

只依赖 Apple 自带工具链（swiftc + CoreGraphics），无第三方依赖、不下载任何东西：

```bash
bash native/cursor-hide/build.sh                  # 产出 native/cursor-hide/cursor-hide
bash native/cursor-hide/build.sh --probe          # 编译后立刻做净零能力探测 + 打印状态
bash native/cursor-hide/build.sh --install "$APP/Contents/Resources"
```

安装后 helper 位于 `Resources/cursor-hide/cursor-hide`；主进程封装按
`process.resourcesPath` → 项目内 `native/cursor-hide/` 的顺序查找（开发期用后者）。

## 命令行接口

```
cursor-hide --probe                     能力探测（净零自检：Hide 后立刻 Show）后退出
cursor-hide --status                    报告状态（系统查询 + 台账 + 是否残留）
cursor-hide --hide                      ⚠️ 隐藏一次后退出；退出后光标仍隐藏，必须 --show 恢复
cursor-hide --show                      恢复一次后退出
cursor-hide --force-show                兜底恢复：按台账把欠下的 Show 补齐
cursor-hide --hold [--parent-pid N]     隐藏后常驻；信号/父进程消失时先恢复再退出（封装用这个）
cursor-hide --dry-run [--parent-pid N]  仅自检：跑完整常驻/信号/看门狗流程，**不碰光标**
--ledger <path>                         台账路径（默认 $TMPDIR/suisi-cursor-hide.json）
```

输出协议（逐行 `KEY=VALUE`）：

| 输出 | 含义 |
| --- | --- |
| `CURSOR_PROBE=1` | probe 输出开始标记 |
| `DISPLAY_COUNT=N` | 参与 hide/show 的活动显示器数量 |
| `HIDE_OK=0\|1` | Hide+Show 净零自检是否成功（计数是否可写） |
| `CURSOR_VISIBLE=0\|1` | 系统查询值（⚠️ 本机恒为 1，不可信，见上） |
| `VISIBLE_QUERY=0\|1` | 该符号是否存在 |
| `CURSOR_STATUS=1` | status 输出开始标记 |
| `LEDGER_COUNT=N` | 台账里「我们欠了几次 Show」 |
| `LEDGER_PID` / `LEDGER_MODE` / `LEDGER_ALIVE` | 谁在持有这次隐藏、是否还活着 |
| `STALE=0\|1` | 台账有欠账但持有者已死（**危险态**，下一次 `hide()` 会先兜底恢复） |
| `HIDDEN=0\|1` | 综合判定：查询说不可见，或台账有欠账 |
| `CURSOR_READY=1` / `MODE=…` | 常驻/一次性操作成功（封装以此判定就绪） |
| `CURSOR_HIDDEN=1` | 已隐藏 |
| `CURSOR_RESTORED=1` / `CURSOR_STOPPED=1` | 退出前已完成恢复并停止 |
| `CURSOR_ERROR=<中文>` | 可读失败原因（非 0 退出码） |

## 「光标没恢复」怎么排查

按顺序做（每一步都是幂等的，多做不会坏事）：

```bash
H=./native/cursor-hide/cursor-hide
"$H" --status          # 看 LEDGER_COUNT / LEDGER_ALIVE / STALE / HIDDEN
"$H" --force-show      # 兜底恢复（按台账补齐 Show，最多 8 次）
"$H" --force-show      # 再补一次
"$H" --status          # 应看到 LEDGER_COUNT=0、HIDDEN=0
rm -f "$TMPDIR/suisi-cursor-hide.json"   # 最后手段：清掉台账（不改系统状态）
```

- 若 `STALE=1`：说明上次隐藏的进程被强杀。`--force-show` 即可恢复；
  封装下次 `hide()` 也会自动先恢复再隐藏，不会把计数叠高。
- 若 `--force-show` 后光标仍不可见：检查是否有**其它程序**也隐藏了光标
  （每个进程各自计数），或直接注销/重启（重启必然清零）。
- 想验证清理路径但**不想真的藏起鼠标**：用 `--dry-run`，它跑完整的信号/看门狗流程但不碰光标。

## 已知限制

1. **无法在软件层确认「视觉上确实隐藏了」**（见上文实测发现）：可见性查询在 macOS 26 上是死 API，
   `screencapture -C` 也不画光标。需要人工确认一次。
2. `CGDisplayHideCursor` 是**全局**的：隐藏期间所有应用都看不到系统光标（这正是目的），
   也因此替代光标窗口必须自己保证可见性。
3. 替代光标窗口若用 `setIgnoreMouseEvents(true)`，**必须加 `{ forward: true }`**
   才会收到 mousemove；否则请让主进程用 `screen.getCursorScreenPoint()` 轮询推送位置。
4. 多显示器：hide/show 会对所有活动显示器成对调用；替代光标窗口的坐标是否覆盖多屏
   由 Lead 的窗口创建方式决定（组件按窗口本地坐标绘制）。
5. helper 未签名/未 notarize，正式分发需随 app 一起签名。
6. 只支持 macOS（非 darwin 平台封装返回「当前系统暂不支持隐藏鼠标」）。

## 文件

- `cursor-hide.swift` — 原生 helper（hide/show/status/probe/hold/force-show/dry-run + 台账 + 三层清理）
- `build.sh` — swiftc 构建 / `--probe` / `--install <dir>`
- `src/main/cursor/index.ts` — 主进程封装：`getSupport()` / `hide()` / `show()` / `isHidden()` / `shutdown()`
  （附加：`resolveHelperPath()`、`CURSOR_TEXT` 文案常量）
- `src/renderer/src/windows/cursor/App.tsx` — 替代光标渲染（默认导出 App，零依赖）
- `src/main/cursor/__selftest__/run.cjs` — 自测（35 项，全部用 stub，不会真的隐藏鼠标）
