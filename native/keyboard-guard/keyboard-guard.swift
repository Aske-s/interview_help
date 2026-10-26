//
//  keyboard-guard.swift — 随思本地版「键盘防护 / 安全输入」原生 helper
//
//  安全边界（务必保留此声明，代码评审时重点看这里）：
//    这是一个**防御性隐私**功能。helper 只做两件事：
//      1) 吞掉（swallow）指定一侧 Command 相关的键盘事件，让其它进程观察不到这些按键；
//      2) 开关 macOS 的 Secure Event Input。
//    helper **绝不**读取、记录、缓存、写盘或上报任何按键内容。
//    源码中不允许出现把 keycode / 字符写入日志或文件的代码。
//    如需调试，只允许打印事件「类型、是否被吞掉」这类计数，不允许打印按键内容。
//
//  子命令：
//    --probe                          能力探测：能否建 tap、是否已获辅助功能权限、安全输入当前状态；打印后立即退出
//    --side left|right|both           常驻：吞掉目标侧 Command 相关事件
//    --secure-input on|off            on = 开启安全输入并常驻持有；off = 关闭（本进程内）
//    --parent-pid <pid>               可选：父进程消失时自动清理退出（避免残留吞键盘的孤儿进程）
//    --dry-run                        仅自检：跑完整的常驻/信号/父进程看门狗流程，但**不建 tap、不开安全输入**
//                                     （用于在不干扰用户键盘的前提下验证 SIGTERM 清理是否有效）
//    --help
//
//  退出与清理：
//    SIGTERM / SIGINT / SIGHUP → 关闭 tap、DisableSecureEventInput、退出 0，并打印 GUARD_STOPPED=1
//    父进程消失（--parent-pid）→ 同上，2 秒轮询一次
//

import Foundation
import CoreGraphics
import ApplicationServices
import Carbon

// MARK: - 常量

let kLeftCommandKeyCode: Int64 = 55
let kRightCommandKeyCode: Int64 = 54

/// 已按下并被我们「接管」的修饰键，用于成对吞掉按下/抬起事件。
enum GuardSide: String {
  case left
  case right
  case both
}

let PROBE_WATCHDOG_SECONDS: Double = 2.0

// MARK: - 运行状态

final class GuardContext {
  let side: GuardSide
  var grabbedLeft = false
  var grabbedRight = false
  private var tap: CFMachPort?

  init(side: GuardSide) {
    self.side = side
  }

  func attach(tap: CFMachPort) {
    self.tap = tap
  }

  func reenableTap() {
    if let tap = tap {
      CGEvent.tapEnable(tap: tap, enable: true)
    }
  }

  func invalidateTap() {
    if let tap = tap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
      self.tap = nil
    }
  }

  var grabbedAny: Bool { grabbedLeft || grabbedRight }

  /// 该 keycode 是否属于本次防护的目标侧。
  func isTargetSideKeyCode(_ keyCode: Int64) -> Bool {
    switch side {
    case .left: return keyCode == kLeftCommandKeyCode
    case .right: return keyCode == kRightCommandKeyCode
    case .both: return keyCode == kLeftCommandKeyCode || keyCode == kRightCommandKeyCode
    }
  }

  /// 物理按键状态（左右侧可区分）。
  func physicallyDown(_ keyCode: Int64) -> Bool {
    return CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(keyCode))
  }

  /// 目标侧的 Command 当前是否处于「按下 / 已被接管」状态。
  func targetSideActive() -> Bool {
    switch side {
    case .left:
      return grabbedLeft || physicallyDown(kLeftCommandKeyCode)
    case .right:
      return grabbedRight || physicallyDown(kRightCommandKeyCode)
    case .both:
      return grabbedAny || physicallyDown(kLeftCommandKeyCode) || physicallyDown(kRightCommandKeyCode)
    }
  }
}

// MARK: - 吞事件判定（不读取任何按键内容）

/// flagsChanged 的退化判定：当 CGEventSource.keyState 不可用时，用事件 flags 猜按下状态；
/// 仅当另一侧 Command 没有按下时才采信，避免左右互串。
func flagsIndicateDown(_ event: CGEvent, keyCode: Int64) -> Bool {
  guard event.flags.contains(.maskCommand) else { return false }
  let other: Int64 = (keyCode == kLeftCommandKeyCode) ? kRightCommandKeyCode : kLeftCommandKeyCode
  return !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(other))
}

/// 返回 true 表示该事件需要被吞掉（其它进程与系统快捷键都看不到它）。
func shouldSwallow(_ type: CGEventType, _ event: CGEvent, _ ctx: GuardContext) -> Bool {
  // 只关心键盘类事件
  switch type {
  case .flagsChanged:
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

    if keyCode == kLeftCommandKeyCode {
      if ctx.grabbedLeft {
        // 我们吞掉了它的按下，就要负责吞掉抬起，保持事件流成对
        ctx.grabbedLeft = false
        return true
      }
      if ctx.isTargetSideKeyCode(keyCode) {
        if ctx.physicallyDown(keyCode) || flagsIndicateDown(event, keyCode: keyCode) {
          ctx.grabbedLeft = true
          return true
        }
      }
      return false
    }

    if keyCode == kRightCommandKeyCode {
      if ctx.grabbedRight {
        ctx.grabbedRight = false
        return true
      }
      if ctx.isTargetSideKeyCode(keyCode) {
        if ctx.physicallyDown(keyCode) || flagsIndicateDown(event, keyCode: keyCode) {
          ctx.grabbedRight = true
          return true
        }
      }
      return false
    }

    // 其它修饰键（Shift/Option/Ctrl/功能键）：仅在目标侧 Command 已被接管的「不可见窗口」内一并吞掉，
    // 避免其它进程看到半套不完整的状态。没有 Command 组合时一律放行。
    return ctx.grabbedAny

  case .keyDown, .keyUp:
    // 目标侧 Command 按下期间的一切按键都不外泄（这正是键盘记录器最想拿到的东西）
    return ctx.targetSideActive()

  default:
    return false
  }
}

/// C 事件回调：非捕获闭包，状态通过 userInfo 传入。
let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
  guard let userInfo = userInfo else {
    return Unmanaged.passUnretained(event)
  }
  let ctx = Unmanaged<GuardContext>.fromOpaque(userInfo).takeUnretainedValue()

  // 系统因超时/用户输入把 tap 关掉时，自动重新启用，避免防护静默失效
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    ctx.reenableTap()
    return Unmanaged.passUnretained(event)
  }

  if shouldSwallow(type, event, ctx) {
    return nil // 吞掉：不进系统、不给其它进程
  }
  return Unmanaged.passUnretained(event)
}

// MARK: - 事件 tap

func keyboardEventMask() -> CGEventMask {
  let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged]
  var mask: CGEventMask = 0
  for t in types {
    mask |= (CGEventMask(1) << CGEventMask(t.rawValue))
  }
  return mask
}

func createTap(_ ctx: GuardContext) -> CFMachPort? {
  return CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: keyboardEventMask(),
    callback: eventTapCallback,
    userInfo: Unmanaged.passUnretained(ctx).toOpaque()
  )
}

// MARK: - 输出小工具

func emit(_ line: String) {
  print(line)
  fflush(stdout)
}

// MARK: - probe

func runProbe() -> Never {
  // 看门狗：即使 tapCreate 之类的系统调用卡住，probe 也必须在几秒内返回，绝不能拖住上层
  let watchdog = DispatchQueue(label: "suisi.keyboard-guard.probe-watchdog")
  watchdog.asyncAfter(deadline: .now() + PROBE_WATCHDOG_SECONDS) {
    emit("GUARD_PROBE=1")
    emit("TAP_CREATABLE=0")
    emit("AX_TRUSTED=0")
    emit("PROBE_TIMEOUT=1")
    emit("PROBE_REASON=探测超时（系统未在 \(Int(PROBE_WATCHDOG_SECONDS)) 秒内返回）")
    exit(4)
  }

  let axTrusted = AXIsProcessTrusted()
  let secureInput = IsSecureEventInputEnabled()

  let ctx = GuardContext(side: .both)
  let tap = createTap(ctx)
  let creatable = tap != nil

  // 探测完立刻释放，不留驻、不吞任何事件
  if let tap = tap {
    CGEvent.tapEnable(tap: tap, enable: false)
    CFMachPortInvalidate(tap)
  }

  var reason = ""
  if !creatable {
    if axTrusted {
      reason = "无法创建事件监听（系统拒绝了 CGEventTap 请求）"
    } else {
      reason = "尚未获得辅助功能权限，键盘防护未生效。请在系统设置的辅助功能中允许随思"
    }
  }

  emit("GUARD_PROBE=1")
  emit("TAP_CREATABLE=\(creatable ? 1 : 0)")
  emit("AX_TRUSTED=\(axTrusted ? 1 : 0)")
  emit("SECURE_INPUT=\(secureInput ? 1 : 0)")
  if !reason.isEmpty {
    emit("PROBE_REASON=\(reason)")
  }
  exit(0)
}

// MARK: - 参数

func fail(_ reason: String, code: Int32) -> Never {
  emit("GUARD_ERROR=\(reason)")
  exit(code)
}

func printUsage() {
  emit("""
  keyboard-guard — 随思本地版键盘防护 helper（防御性隐私功能，不记录任何按键内容）

  用法：
    keyboard-guard --probe
    keyboard-guard --side left|right|both [--parent-pid <pid>]
    keyboard-guard --secure-input on|off [--parent-pid <pid>]

  代价：被防护那一侧的 Command 组合键（复制/粘贴等）会在所有应用里一并失效。
  """)
}

// MARK: - 入口

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--help") || arguments.contains("-h") || arguments.isEmpty {
  printUsage()
  exit(0)
}

if arguments.contains("--probe") {
  runProbe()
}

func value(for flag: String) -> String? {
  guard let idx = arguments.firstIndex(of: flag), idx + 1 < arguments.count else { return nil }
  return arguments[idx + 1]
}

var parentPid: pid_t? = nil
if let raw = value(for: "--parent-pid"), let pid = pid_t(raw), pid > 0 {
  parentPid = pid
}

// 解析模式
enum Mode {
  case guardSide(GuardSide)
  case secureInput(Bool)
  case dryRun
}

let mode: Mode
if arguments.contains("--dry-run") {
  // 自检模式：只跑常驻与清理流程，不碰键盘（不建 tap、不开安全输入）
  mode = .dryRun
} else if let sideRaw = value(for: "--side") {
  guard let side = GuardSide(rawValue: sideRaw) else {
    fail("无效的 --side 取值：\(sideRaw)（只允许 left / right / both）", code: 2)
  }
  mode = .guardSide(side)
} else if let secureRaw = value(for: "--secure-input") {
  switch secureRaw {
  case "on": mode = .secureInput(true)
  case "off": mode = .secureInput(false)
  default: fail("无效的 --secure-input 取值：\(secureRaw)（只允许 on / off）", code: 2)
  }
} else {
  printUsage()
  exit(2)
}

// MARK: 清理与退出（唯一退出路径，保证「不留残留」

let ctx: GuardContext? = {
  if case .guardSide(let side) = mode { return GuardContext(side: side) }
  return nil
}()

var secureInputOwned = false
var stopRequested = false

func cleanup() {
  // 幂等：可能被信号与正常退出各调用一次
  if secureInputOwned {
    DisableSecureEventInput()
    secureInputOwned = false
  }
  ctx?.invalidateTap()
}

func requestStop() {
  stopRequested = true
  CFRunLoopStop(CFRunLoopGetMain())
}

// 信号处理：先忽略默认行为，再用 DispatchSource 在主队列上安全处理
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
signal(SIGHUP, SIG_IGN)

let signalQueue = DispatchQueue.main
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
let sighupSource = DispatchSource.makeSignalSource(signal: SIGHUP, queue: signalQueue)
for source in [sigtermSource, sigintSource, sighupSource] {
  source.setEventHandler { requestStop() }
  source.resume()
}

// 父进程看门狗：父进程没了就自杀，避免残留一个「吞键盘」的孤儿进程
var parentTimer: DispatchSourceTimer? = nil
if let pid = parentPid {
  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
  timer.schedule(deadline: .now() + 2.0, repeating: 2.0)
  timer.setEventHandler {
    // kill(pid, 0)：进程存在返回 0；不存在返回 -1 且 errno == ESRCH
    if kill(pid, 0) != 0 && errno == ESRCH {
      requestStop()
    }
  }
  timer.resume()
  parentTimer = timer
}

// 启动
switch mode {
case .guardSide(let side):
  guard let context = ctx else { fail("内部错误：缺少防护上下文", code: 3) }
  guard let tap = createTap(context) else {
    let axTrusted = AXIsProcessTrusted()
    if axTrusted {
      fail("无法创建事件监听（系统拒绝了 CGEventTap 请求），键盘防护未生效，请重试。", code: 5)
    }
    fail("尚未获得辅助功能权限，键盘防护未生效。请在系统设置的辅助功能中允许随思", code: 5)
  }
  context.attach(tap: tap)
  guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    context.invalidateTap()
    fail("无法为事件监听创建 RunLoop 源，键盘防护未生效，请重试。", code: 5)
  }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  emit("GUARD_READY=1")
  emit("MODE=guard")
  emit("SIDE=\(side.rawValue)")

case .secureInput(let on):
  if on {
    EnableSecureEventInput()
    secureInputOwned = true
    emit("GUARD_READY=1")
    emit("MODE=secure-input")
    emit("SECURE_INPUT=1")
  } else {
    // 本进程内关闭；注意：安全输入是按进程计数的，这里只对本进程生效
    DisableSecureEventInput()
    emit("GUARD_READY=1")
    emit("MODE=secure-input")
    emit("SECURE_INPUT=0")
    exit(0)
  }

case .dryRun:
  emit("GUARD_READY=1")
  emit("MODE=dry-run")
}

CFRunLoopRun()

// 只有 requestStop 才能走到这里：统一清理后再退出
cleanup()
emit("GUARD_STOPPED=1")
exit(0)
