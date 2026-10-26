//
//  cursor-hide.swift — 随思本地版「安全模式 / 隐藏鼠标」原生 helper
//
//  作用：把**真实系统光标**隐藏起来（这样屏幕共享/录屏里看不到鼠标位置），
//        本机用户则由随思的替代光标窗口提供位置感。
//
//  ⚠️ 最关键的陷阱（改代码前必读）：
//    `CGDisplayHideCursor` 是**按调用次数计数**的，必须成对调用；而且
//    **进程退出不会自动恢复光标**。一旦 helper 被强杀而没恢复，用户的鼠标就看不见了
//    ——这比键盘防护留残留更严重。所以本 helper 的退出路径上，
//    **恢复光标（Show）的优先级永远高于其它一切**：
//      1) --hold 常驻模式收到 SIGTERM/SIGINT/SIGHUP → 先 Show 再退
//      2) --parent-pid 父进程看门狗 → 父进程消失时先 Show 再退（Electron 崩溃也不会留残留）
//      3) --force-show 独立兜底，任何时候都能把光标拉回来
//
//  另一个实测发现（见 README）：
//    `CGCursorIsVisible()` 在 macOS 26 SDK 里被标记为 "No longer supported"，
//    运行时符号仍在（CoreGraphics 再导出 SkyLight 的 SLCursorIsVisible），但
//    实测它在 hide/show 前后恒为 1，**不能作为可信的可见性判据**。
//    因此 --status 同时输出「系统查询值」和「我们自己的台账」，并明确标注来源。
//
//  子命令：
//    --probe      能力探测（净零自检：Hide 后立刻 Show，不改变光标状态）后退出
//    --status     报告当前状态（系统查询 + 台账 + 是否残留）
//    --hide       隐藏一次后退出（⚠️ 退出后光标仍隐藏，必须用 --show / --force-show 恢复）
//    --show       恢复一次后退出
//    --force-show 兜底恢复：按台账把欠下的 Show 补齐
//    --hold       隐藏后常驻；信号/父进程消失时先恢复再退出（主进程封装用这个）
//    --dry-run    仅自检：跑完整常驻/信号/看门狗流程，但**不碰光标**
//    --parent-pid <pid>   父进程看门狗
//    --ledger <path>      台账文件路径（默认 $TMPDIR/suisi-cursor-hide.json）
//

import Foundation
import CoreGraphics
import Darwin

// MARK: - 光标可见性查询

typealias VisibleQueryFn = @convention(c) () -> Int32

/// CGCursorIsVisible 在新 SDK 里已标记不可用，只能用 dlsym 取符号（仍然存在）。
func resolveVisibleQuery() -> VisibleQueryFn? {
  if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGCursorIsVisible") {
    return unsafeBitCast(sym, to: VisibleQueryFn.self)
  }
  if let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY),
     let sym = dlsym(handle, "SLCursorIsVisible") {
    return unsafeBitCast(sym, to: VisibleQueryFn.self)
  }
  return nil
}

/// nil 表示查询不可用（此时只能靠台账推断）
func systemCursorVisible() -> Bool? {
  guard let fn = resolveVisibleQuery() else { return nil }
  return fn() != 0
}

// MARK: - 显示器

func allDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  if count == 0 { return [CGMainDisplayID()] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return Array(ids.prefix(Int(count)))
}

/// 在所有活动显示器上隐藏光标（光标可能停在任何一块屏上）。
@discardableResult
func hideCursorEverywhere() -> [Int32] {
  return allDisplays().map { CGDisplayHideCursor($0).rawValue }
}

/// 在所有活动显示器上恢复光标。times 必须与 hide 的次数配对，不要乱补。
@discardableResult
func showCursorEverywhere(times: Int) -> [Int32] {
  var errors: [Int32] = []
  for _ in 0..<max(1, times) {
    for display in allDisplays() { errors.append(CGDisplayShowCursor(display).rawValue) }
  }
  return errors
}

// MARK: - 台账（记录「我们欠了几次 Show」）

struct Ledger: Codable {
  var count: Int
  var pid: Int32
  var mode: String
  var updatedAt: Double
}

func ledgerURL() -> URL {
  if let override = ProcessInfo.processInfo.environment["SUISI_CURSOR_LEDGER"], !override.isEmpty {
    return URL(fileURLWithPath: override)
  }
  return FileManager.default.temporaryDirectory.appendingPathComponent("suisi-cursor-hide.json")
}

func readLedger() -> Ledger? {
  guard let data = try? Data(contentsOf: ledgerURL()) else { return nil }
  return try? JSONDecoder().decode(Ledger.self, from: data)
}

func writeLedger(_ ledger: Ledger?) {
  let url = ledgerURL()
  guard let ledger = ledger else {
    try? FileManager.default.removeItem(at: url)
    return
  }
  guard let data = try? JSONEncoder().encode(ledger) else { return }
  // 原子写：先写临时文件再替换，避免读到半个文件
  let tmp = url.appendingPathExtension("tmp")
  do {
    try data.write(to: tmp)
    _ = try? FileManager.default.removeItem(at: url)
    try FileManager.default.moveItem(at: tmp, to: url)
  } catch {
    try? data.write(to: url)
  }
}

func pidAlive(_ pid: Int32) -> Bool {
  if pid <= 0 { return false }
  if kill(pid, 0) == 0 { return true }
  return errno == EPERM // 存在但没权限（也算活着）
}

// MARK: - 输出

func emit(_ line: String) {
  print(line)
  fflush(stdout)
}

func fail(_ reason: String, code: Int32) -> Never {
  emit("CURSOR_ERROR=\(reason)")
  exit(code)
}

// MARK: - 参数

let arguments = Array(CommandLine.arguments.dropFirst())

func value(for flag: String) -> String? {
  guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

if arguments.contains("--help") || arguments.contains("-h") || arguments.isEmpty {
  emit("""
  cursor-hide — 随思本地版「隐藏真实鼠标」helper（安全模式下配合替代光标使用）

  用法：
    cursor-hide --probe
    cursor-hide --status
    cursor-hide --hide | --show | --force-show
    cursor-hide --hold [--parent-pid <pid>]
    cursor-hide --dry-run [--parent-pid <pid>]

  ⚠️ CGDisplayHideCursor 按次数计数且进程退出不会自动恢复：
     用 --hide 隐藏后必须用 --show / --force-show 恢复；常驻请用 --hold。
  """)
  exit(0)
}

enum Mode {
  case probe, status, hide, show, forceShow, hold, dryRun
}

let mode: Mode
if arguments.contains("--probe") { mode = .probe }
else if arguments.contains("--status") { mode = .status }
else if arguments.contains("--hide") { mode = .hide }
else if arguments.contains("--show") { mode = .show }
else if arguments.contains("--force-show") { mode = .forceShow }
else if arguments.contains("--hold") { mode = .hold }
else if arguments.contains("--dry-run") { mode = .dryRun }
else {
  emit("CURSOR_ERROR=未知参数：\(arguments.joined(separator: " "))（用 --help 查看用法）")
  exit(2)
}

var parentPid: Int32? = nil
if let raw = value(for: "--parent-pid"), let pid = Int32(raw), pid > 0 { parentPid = pid }

// MARK: - 各子命令

/// 净零自检：Hide 之后立刻 Show，验证计数可写且不会把用户光标留在隐藏态。
func runProbe() -> Never {
  let watchdog = DispatchQueue(label: "suisi.cursor.probe-watchdog")
  watchdog.asyncAfter(deadline: .now() + 2.0) {
    // 极端情况下也要先把光标恢复回来再退出
    _ = showCursorEverywhere(times: 2)
    emit("CURSOR_PROBE=1")
    emit("HIDE_OK=0")
    emit("PROBE_TIMEOUT=1")
    emit("CURSOR_ERROR=探测超时（系统未在 2 秒内返回）")
    exit(4)
  }

  let displays = allDisplays()
  var hideErrors: [Int32] = []
  for display in displays { hideErrors.append(CGDisplayHideCursor(display).rawValue) }
  // 立刻恢复：probe 必须保证净零
  var showErrors: [Int32] = []
  for display in displays { showErrors.append(CGDisplayShowCursor(display).rawValue) }

  let hideOK = hideErrors.allSatisfy { $0 == 0 } && showErrors.allSatisfy { $0 == 0 }
  let visible = systemCursorVisible()
  let ledger = readLedger()

  emit("CURSOR_PROBE=1")
  emit("DISPLAY_COUNT=\(displays.count)")
  emit("HIDE_OK=\(hideOK ? 1 : 0)")
  emit("VISIBLE_QUERY=\(resolveVisibleQuery() == nil ? 0 : 1)")
  if let visible = visible { emit("CURSOR_VISIBLE=\(visible ? 1 : 0)") }
  emit("LEDGER_COUNT=\(ledger?.count ?? 0)")
  if let ledger = ledger {
    emit("LEDGER_PID=\(ledger.pid)")
    emit("LEDGER_ALIVE=\(pidAlive(ledger.pid) ? 1 : 0)")
    emit("STALE=\((ledger.count > 0 && !pidAlive(ledger.pid)) ? 1 : 0)")
  } else {
    emit("STALE=0")
  }
  if !hideOK { emit("PROBE_REASON=光标计数不可写（Hide/Show 返回错误 \(hideErrors) / \(showErrors)）") }
  exit(0)
}

func runStatus() -> Never {
  let ledger = readLedger()
  let alive = ledger.map { pidAlive($0.pid) } ?? false
  let stale = (ledger?.count ?? 0) > 0 && !alive
  let visible = systemCursorVisible()

  emit("CURSOR_STATUS=1")
  emit("LEDGER_COUNT=\(ledger?.count ?? 0)")
  if let ledger = ledger {
    emit("LEDGER_PID=\(ledger.pid)")
    emit("LEDGER_MODE=\(ledger.mode)")
    emit("LEDGER_ALIVE=\(alive ? 1 : 0)")
  }
  emit("STALE=\(stale ? 1 : 0)")
  emit("VISIBLE_QUERY=\(resolveVisibleQuery() == nil ? 0 : 1)")
  if let visible = visible { emit("CURSOR_VISIBLE=\(visible ? 1 : 0)") }
  // 综合判定：系统查询若明确说不可见，那就是不可见；否则以台账为准
  // （实测 macOS 26 上 CURSOR_VISIBLE 恒为 1，属于不可信信号，见 README）
  let hidden = (visible == false) || (ledger?.count ?? 0) > 0
  emit("HIDDEN=\(hidden ? 1 : 0)")
  exit(0)
}

/// 扣减台账里的一笔隐藏记录（count 减 1；到 0 就删掉台账文件）
func consumeLedgerHide(count: Int) {
  let remaining = max(0, count - 1)
  if remaining == 0 {
    writeLedger(nil)
  } else if let existing = readLedger() {
    writeLedger(Ledger(count: remaining, pid: existing.pid, mode: existing.mode, updatedAt: Date().timeIntervalSince1970))
  }
}

func recordLedgerHide(mode: String) -> Int {
  let previous = readLedger()
  let count = (previous?.count ?? 0) + 1
  writeLedger(Ledger(count: count, pid: getpid(), mode: mode, updatedAt: Date().timeIntervalSince1970))
  return count
}

// MARK: 常驻与清理（恢复光标优先于一切）

var didRestore = false
var ledgerOwnedCount = 0
var runningMode = "idle"

/// 幂等：把光标恢复回来。优先级最高，任何退出路径都要先走这里。
func restoreCursorAndClearLedger() {
  if didRestore { return }
  didRestore = true
  if ledgerOwnedCount > 0 {
    _ = showCursorEverywhere(times: ledgerOwnedCount)
  }
  consumeLedgerHide(count: ledgerOwnedCount)
  emit("CURSOR_RESTORED=1")
  emit("CURSOR_STOPPED=1")
}

func requestStop() {
  CFRunLoopStop(CFRunLoopGetMain())
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGHUP, SIG_IGN)

let sources = [SIGTERM, SIGINT, SIGHUP].map { sig -> DispatchSourceSignal in
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { requestStop() }
  source.resume()
  return source
}

var parentTimer: DispatchSourceTimer? = nil

switch mode {
case .probe:
  runProbe()

case .status:
  runStatus()

case .hide:
  let errors = hideCursorEverywhere()
  guard errors.allSatisfy({ $0 == 0 }) else {
    fail("隐藏鼠标失败（系统返回错误 \(errors)）", code: 5)
  }
  ledgerOwnedCount = recordLedgerHide(mode: "oneshot")
  emit("CURSOR_HIDDEN=1")
  emit("CURSOR_READY=1")
  emit("MODE=oneshot")
  emit("LEDGER_COUNT=\(ledgerOwnedCount)")
  // 注意：一次性 --hide 退出后光标仍然隐藏，需要 --show / --force-show 恢复
  exit(0)

case .show:
  let ledger = readLedger()
  let times = max(1, min(ledger?.count ?? 1, 8))
  let errors = showCursorEverywhere(times: times)
  guard errors.allSatisfy({ $0 == 0 }) else {
    fail("恢复鼠标失败（系统返回错误 \(errors)），可用 --force-show 重试", code: 5)
  }
  consumeLedgerHide(count: ledger?.count ?? 0)
  emit("CURSOR_SHOWN=1")
  emit("CURSOR_READY=1")
  emit("MODE=show")
  if let visible = systemCursorVisible() { emit("CURSOR_VISIBLE=\(visible ? 1 : 0)") }
  exit(0)

case .forceShow:
  let ledger = readLedger()
  // 兜底恢复：把台账欠的次数补齐（至少 1 次），上限 8 次防止过度递减
  let times = max(1, min(ledger?.count ?? 0, 8))
  let errors = showCursorEverywhere(times: times)
  writeLedger(nil)
  emit("CURSOR_SHOWN=1")
  emit("CURSOR_RESTORED=1")
  emit("CURSOR_READY=1")
  emit("MODE=force-show")
  emit("SHOW_TIMES=\(times)")
  if let visible = systemCursorVisible() { emit("CURSOR_VISIBLE=\(visible ? 1 : 0)") }
  emit("SHOW_ERRORS_OK=\(errors.allSatisfy { $0 == 0 } ? 1 : 0)")
  exit(0)

case .hold:
  let errors = hideCursorEverywhere()
  guard errors.allSatisfy({ $0 == 0 }) else {
    fail("隐藏鼠标失败（系统返回错误 \(errors)）", code: 5)
  }
  ledgerOwnedCount = recordLedgerHide(mode: "hold")
  runningMode = "hold"
  emit("CURSOR_READY=1")
  emit("MODE=hold")
  emit("CURSOR_HIDDEN=1")
  emit("LEDGER_COUNT=\(ledgerOwnedCount)")

case .dryRun:
  runningMode = "dry-run"
  emit("CURSOR_READY=1")
  emit("MODE=dry-run")
}

// 父进程看门狗：Electron 崩溃时孤儿 helper 必须自己把光标恢复回来
if let pid = parentPid {
  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
  timer.schedule(deadline: .now() + 2.0, repeating: 2.0)
  timer.setEventHandler {
    if kill(pid, 0) != 0 && errno == ESRCH {
      requestStop()
    }
  }
  timer.resume()
  parentTimer = timer
}
_ = parentTimer
_ = sources
_ = runningMode

CFRunLoopRun()

// 只有 requestStop 能走到这里：先恢复光标，再退出
restoreCursorAndClearLedger()
exit(0)
