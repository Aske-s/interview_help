# keyboard-guard — 键盘防护 / 安全输入（原生 helper）

> 随思本地版（suisi-local）的**防御性隐私**组件。macOS 优先。

## 它做什么

| 能力 | 实现 | 效果 |
| --- | --- | --- |
| **键盘防护** | `CGEvent.tapCreate`（`.cgSessionEventTap` + `.headInsertEventTap`）建事件 tap，命中目标侧 Command 组合时 `return nil` 吞掉事件 | 你在使用该侧 Command 组合时的按键**不会进入系统事件流**，依赖 CGEventTap / NSEvent 的键盘记录器观察不到 |
| **安全输入** | `EnableSecureEventInput()` / `DisableSecureEventInput()` | macOS 的 Secure Event Input：除持有它的进程外，其它程序读不到键盘事件 |

## ⚠️ 安全边界（改代码前必读）

**这是防御性功能，不是键盘记录器。** helper 只被允许做两件事：

1. **吞掉**目标侧 Command 相关的键盘事件（`return nil`）；
2. **开关** Secure Event Input。

helper 与主进程封装**绝不**读取、复制、缓存、落盘、上报任何按键内容：

- 源码里不允许出现把 keycode、字符、按键序列写进日志/文件/网络的代码；
- 事件回调只做「这个事件是否属于目标侧 → 吞 / 放行」的布尔判定，不读取字符、不查表；
- 唯一的输出是启动就绪、错误原因、停止确认这类状态行（`GUARD_READY=1` / `GUARD_ERROR=…` / `GUARD_STOPPED=1`）。

如果你发现自己在写「把按键写进日志/文件」的代码，立刻停下——那不是本功能的需求。

## 代价（必须让用户知道）

- **被防护那一侧的 Command 组合键会在全局失效**：`Cmd+C` / `Cmd+V` 等系统快捷键在**所有应用**里都不再生效（事件在 session 层就被吞掉了，系统自己也收不到）。这就是原版文案「所选 Command 侧的复制、粘贴等系统快捷键在其他应用中会一并失效。建议只开一侧」的含义。
- `--side both` 会让两侧 Command 全部失效，只适合极端场景。
- **安全输入是全局的**：开启期间其它应用/输入法读不到键盘事件，因此**第三方中文输入法可能不可用**（原版用自研 `dist/secure-ime` 输入法解决；本任务不复刻输入法，只做开关与状态）。
- 安全输入按**进程**持有（reference counted）：持有它的进程一退出就失效，所以 helper 必须常驻；关闭的做法是终止这个常驻进程。

## 辅助功能权限（Accessibility）

`CGEventTap` 需要「辅助功能」权限，没有权限时 `tapCreate` 返回 `nil`：

- 给权限：**系统设置 → 隐私与安全性 → 辅助功能** → 打开「随思」。
- 命令行/开发期直接跑二进制时，权限归属**当前终端或宿主 App**（TCC 按 responsible process 归属），不是随思本身；打包成 `随思.app` 后需要为随思单独授权。
- 未授权时 helper **不抛异常**，而是打印可读中文原因并以退出码 5 退出：
  `尚未获得辅助功能权限，键盘防护未生效。请在系统设置的辅助功能中允许随思`
- 上层封装会同时参考 `systemPreferences.isTrustedAccessibilityClient(false)` 与 probe 结果，任一方认为已授权时，就不再提示用户去授权（避免用户反复点却找不到出路）。

## 构建

只依赖 Apple 自带工具链（swiftc + CoreGraphics / ApplicationServices / Carbon），无第三方依赖、不下载任何东西：

```bash
bash native/keyboard-guard/build.sh                 # 产出 native/keyboard-guard/keyboard-guard
bash native/keyboard-guard/build.sh --probe         # 编译后立即探测一次
bash native/keyboard-guard/build.sh --install "$APP/Contents/Resources"
```

安装后 helper 位于 `Resources/keyboard-guard/keyboard-guard`；主进程封装按
`process.resourcesPath` → 项目内 `native/keyboard-guard/` 的顺序查找（开发期用后者）。

## 命令行接口

```
keyboard-guard --probe                                  # 能力探测后立即退出
keyboard-guard --side left|right|both [--parent-pid N]  # 常驻吞事件
keyboard-guard --secure-input on|off  [--parent-pid N]  # on 常驻持有；off 本进程内关闭
keyboard-guard --dry-run [--parent-pid N]               # 仅自检：跑常驻/信号/看门狗流程，不建 tap、不开安全输入
keyboard-guard --help
```

输出协议（逐行 `KEY=VALUE`，供上层解析）：

| 输出 | 含义 |
| --- | --- |
| `GUARD_PROBE=1` | probe 输出开始标记（上层以此判定 probe 是否有效） |
| `TAP_CREATABLE=0\|1` | 能否创建事件 tap（0 通常是没权限或系统拒绝） |
| `AX_TRUSTED=0\|1` | helper 进程自身是否已被辅助功能授权 |
| `SECURE_INPUT=0\|1` | 系统当前安全输入状态（`IsSecureEventInputEnabled()`） |
| `PROBE_REASON=<中文>` | 不可用时的可读原因 |
| `PROBE_TIMEOUT=1` | probe 看门狗触发（2 秒） |
| `GUARD_READY=1` / `MODE=…` | 常驻模式就绪（上层以此判定启动成功） |
| `GUARD_ERROR=<中文>` | 启动失败的可读原因（非 0 退出码） |
| `GUARD_STOPPED=1` | 已清理并退出 |

- `--probe` 内置 **2 秒看门狗**（独立线程）：即使 `tapCreate` 之类的系统调用卡住也会打印 `PROBE_TIMEOUT=1` 并退出，上层不会被拖住。上层封装另有 **1.5 秒 `spawnSync` 超时 + SIGKILL** 双保险。

## 清理与防残留（重要）

残留一个正在吞事件的 helper 会让用户键盘「失灵」，因此做了三层保护：

1. **SIGTERM / SIGINT / SIGHUP**：在主队列上安全处理（不是信号上下文里做清理），先关 tap、`DisableSecureEventInput()`，再打印 `GUARD_STOPPED=1` 退出 0。
2. **父进程看门狗**（`--parent-pid`，封装默认传入）：每 2 秒 `kill(pid, 0)` 检查父进程；父进程崩溃消失时 helper 自行清理退出。**Electron 崩溃也不会留下吞键盘的孤儿进程。**
3. **封装侧**：`disable()` / `shutdown()` 先 SIGTERM 优雅退出，2 秒后仍活着才 SIGKILL；另有 `process.once('exit')` 兜底。

## 本机实测（2026-10-22，macOS 26.6.1 arm64，swiftc 6.3.3）

```
$ ./native/keyboard-guard/keyboard-guard --probe
GUARD_PROBE=1
TAP_CREATABLE=1
AX_TRUSTED=1
SECURE_INPUT=0
# 耗时约 90ms，退出码 0
```

清理行为实测：

- `--dry-run` 收到 SIGTERM → `GUARD_READY=1` … `GUARD_STOPPED=1`，退出码 0，无残留进程；
- 真实 `--side right` 模式 0.5 秒窗口收到 SIGTERM → `GUARD_READY=1` / `MODE=guard` / `SIDE=right` / `GUARD_STOPPED=1`，退出码 0，`pgrep` 无残留；
- 父进程 `kill -9` 后，孤儿 helper 在 4.5 秒内自行退出并打印 `GUARD_STOPPED=1`。

## 已知限制

1. **未做真机吞键行为验证**（避免干扰使用者键盘）：吞键逻辑经静态审查 + 信号清理实测，未做按键注入实验。需要在真实使用中确认。
2. **挡不住内核级/硬件级采集**：CGEventTap 在 session 层拦截，能挡住绝大多数基于 CGEventTap / NSEvent 的键盘记录器，但挡不住 USB HID 硬件记录器或带 root 的驱动级采集。
3. **安全输入期间中文输入法可能不可用**（无自研输入法）。
4. 左右侧判断依赖 `CGEventSource.keyState(.combinedSessionState, …)`（左 Command=55，右 Command=54）；
   合成事件或来自其它 session 的事件下可能不准，已用事件 `flags` 做退化判定。
5. helper 未签名/未 notarize：正式分发需随 app 一起签名，否则 Gatekeeper 可能拦截。
6. `--secure-input off` 只对本进程生效（系统按进程计数）；关闭安全输入的正确做法是终止常驻 helper。

## 上层封装

`src/main/keyboard-guard/index.ts`（主进程侧）导出
`getSupport()` / `getStatus()` / `enable(side)` / `disable()` / `setSecureInput(on)`
以及附加的 `shutdown()`（建议在 `app.before-quit` 调用）、`resolveHelperPath()`、`GUARD_TEXT`（文案常量）。

自测：`node src/main/keyboard-guard/__selftest__/run.cjs`（46 项，含真实 helper probe 实测）。
