//
//  capture-sck.swift —— 基于 ScreenCaptureKit 的 macOS 系统音频采集 helper（方案 C）
//
//  用途：suisi-local 的「电脑音频」模式。Chromium 在 macOS 上没有 WASAPI 式的
//  系统回环（loopback），因此当 getDisplayMedia 拿不到系统音频时，由本 helper
//  作为兜底：它把系统混音（不含麦克风）转成 16kHz / 单声道 / PCM16 裸流，
//  从 stdout 吐给主进程，格式与 AudioCapture 输出完全一致。
//
//  编译：见同目录 build.sh（swiftc，无需 Xcode 工程、无第三方依赖）
//  用法：
//    capture-sck --list                         列出可采集的显示器/应用
//    capture-sck --seconds 6 --out /tmp/a.wav   采集 6 秒并写 WAV，同时打印统计
//    capture-sck --stream                       持续输出 16k/mono/s16le 裸 PCM 到 stdout
//    capture-sck --app com.tencent.xinWeChat     只采集指定 app 的音频（默认整个系统混音）
//
//  权限：必须授予「屏幕录制」（Screen Recording）。首次运行若未授权，
//  SCShareableContent.current 会抛 SCStreamErrorUserDeclined(-3801)，
//  本程序会打印明确的错误与授权指引，不会崩溃。
//

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

struct Options {
  var seconds: Double = 5
  var outPath: String?
  var listOnly = false
  var streamMode = false
  var appBundleId: String?
  var sampleRate = 16000
  var channelCount = 1
  /// 采集多少个显示器（默认第一个）
  var displayIndex = 0
}

func parseOptions() -> Options {
  var opts = Options()
  var args = Array(CommandLine.arguments.dropFirst())
  // 无参数即管道模式：主进程就是这样拉起本程序的（与原版 helper 的调用方式一致）。
  if args.isEmpty { opts.streamMode = true }
  while !args.isEmpty {
    let arg = args.removeFirst()
    switch arg {
    case "--seconds":
      if let v = args.first, let d = Double(v) { opts.seconds = d; args.removeFirst() }
    case "--out":
      if let v = args.first { opts.outPath = v; args.removeFirst() }
    case "--list":
      opts.listOnly = true
    case "--stream":
      opts.streamMode = true
    case "--app":
      if let v = args.first { opts.appBundleId = v; args.removeFirst() }
    case "--sample-rate":
      if let v = args.first, let n = Int(v) { opts.sampleRate = n; args.removeFirst() }
    case "--display":
      if let v = args.first, let n = Int(v) { opts.displayIndex = n; args.removeFirst() }
    case "--help", "-h":
      printUsage()
      exit(0)
    default:
      FileHandle.standardError.write("未知参数：\(arg)\n".data(using: .utf8)!)
    }
  }
  return opts
}

func printUsage() {
  print(
    """
    capture-sck —— macOS 系统音频采集（ScreenCaptureKit）

      --list                 列出可用的显示器与应用后退出
      --seconds <n>          采集时长（秒），默认 5
      --out <path>           把采集到的音频写成 WAV（16k/mono/s16le）
      --stream               持续输出裸 PCM 到 stdout（不给任何参数时即此模式）
      --app <bundleId>       只采集指定应用的音频；缺省为整个系统混音
      --sample-rate <n>      采样率，默认 16000
      --display <index>      采集第几个显示器，默认 0
      --help                 显示本帮助

    管道模式协议（主进程按此解析）：
      stderr:  "ready"                     采集已开始
               "failed: <原因>"            启动失败
      stdout:  [uint32 LE 长度][16k/mono/s16le PCM]，每帧 100ms（3200 字节）
    """)
}

/* ------------------------------------------------------------------ *
 * 采集器
 * ------------------------------------------------------------------ */

final class AudioSink: NSObject, SCStreamOutput {
  /// 累积的 16k/mono/Int16 采样
  private(set) var pcm = Data()
  private(set) var audioCallbackCount = 0
  private(set) var peak: Float = 0
  private var sumSquares: Double = 0
  private var totalFrames = 0
  /// 每 0.25 秒一格的 RMS，便于观察「有没有声音、什么时候有声音」
  private(set) var windowRms: [Float] = []
  private let windowFrames = 4000
  private var windowAccum: Double = 0
  private var windowCount = 0

  private(set) var formatDescription = ""
  private(set) var firstError: String?
  private(set) var stopped = false

  var streamToStdout = false
  /// 是否把音频实时写入 stdout（--stream 模式）
  private let stdoutHandle = FileHandle.standardOutput

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    // 只关心音频；视频回调一律忽略
    guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
    audioCallbackCount += 1

    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(format)
    else {
      firstError = firstError ?? "音频样本缺少格式描述"
      return
    }
    let asbd = asbdPtr.pointee
    if formatDescription.isEmpty {
      let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
      let nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
      formatDescription =
        "id=\(fourCC(asbd.mFormatID)) rate=\(asbd.mSampleRate) ch=\(asbd.mChannelsPerFrame) "
        + "bits=\(asbd.mBitsPerChannel) float=\(isFloat) nonInterleaved=\(nonInterleaved)"
    }

    let channels = max(1, Int(asbd.mChannelsPerFrame))
    let abl = AudioBufferList.allocate(maximumBuffers: channels)
    defer { free(abl.unsafeMutablePointer) }

    var sizeNeeded = 0
    var blockBuffer: CMBlockBuffer?
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: &sizeNeeded,
      bufferListOut: abl.unsafeMutablePointer,
      bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: channels),
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBufferOut: &blockBuffer)
    guard status == noErr else {
      firstError = firstError ?? "取 AudioBufferList 失败：OSStatus=\(status)"
      return
    }

    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    var mono: [Int16] = []
    mono.reserveCapacity(4096)

    for index in 0..<Int(abl.count) {
      let buffer = abl[index]
      guard let data = buffer.mData else { continue }
      let byteCount = Int(buffer.mDataByteSize)
      if isFloat {
        let count = byteCount / MemoryLayout<Float32>.size
        let ptr = data.assumingMemoryBound(to: Float32.self)
        for i in 0..<count { mono.append(floatToInt16(ptr[i])) }
      } else if asbd.mBitsPerChannel == 16 {
        let count = byteCount / MemoryLayout<Int16>.size
        let ptr = data.assumingMemoryBound(to: Int16.self)
        for i in 0..<count { mono.append(ptr[i]) }
      } else if asbd.mBitsPerChannel == 32 {
        let count = byteCount / MemoryLayout<Int32>.size
        let ptr = data.assumingMemoryBound(to: Int32.self)
        for i in 0..<count { mono.append(Int16(clamping: ptr[i] >> 16)) }
      }
    }

    // 多声道按平均值混成单声道（与渲染层 AudioContext 的行为一致）
    var mixed: [Int16] = []
    if channels > 1 && Int(abl.count) > 1 {
      let frames = mono.count / channels
      mixed.reserveCapacity(frames)
      for frame in 0..<frames {
        var sum = 0
        for ch in 0..<channels { sum += Int(mono[frame * channels + ch]) }
        mixed.append(Int16(clamping: sum / channels))
      }
    } else {
      mixed = mono
    }

    for sample in mixed {
      let v = Float(sample) / 32768
      sumSquares += Double(v * v)
      totalFrames += 1
      peak = max(peak, abs(v))
      windowAccum += Double(v * v)
      windowCount += 1
      if windowCount >= windowFrames {
        windowRms.append(Float((windowAccum / Double(windowCount)).squareRoot()))
        windowAccum = 0
        windowCount = 0
      }
    }
    appendPCM(mixed)
  }

  /// 管道模式下攒够一帧（100ms = 1600 采样 = 3200 字节）再写出去
  private var streamPending = Data()
  private static let streamFrameBytes = 1600 * 2

  private func appendPCM(_ samples: [Int16]) {
    if streamToStdout {
      var little = samples
      let data = little.withUnsafeBufferPointer { Data(buffer: $0) }
      little.removeAll(keepingCapacity: true)
      streamPending.append(data)
      // 帧格式与主进程 handleStdout 对应：[uint32 LE 长度][PCM 载荷]
      while streamPending.count >= Self.streamFrameBytes {
        let frame = streamPending.prefix(Self.streamFrameBytes)
        var header = UInt32(frame.count).littleEndian
        let headerData = withUnsafeBytes(of: &header) { Data($0) }
        try? stdoutHandle.write(contentsOf: headerData)
        try? stdoutHandle.write(contentsOf: frame)
        streamPending.removeFirst(Self.streamFrameBytes)
      }
      return
    }
    var copy = samples
    let data = copy.withUnsafeBufferPointer { Data(buffer: $0) }
    copy.removeAll(keepingCapacity: true)
    pcm.append(data)
    if pcm.count > 16000 * 2 * 60 {  // 兜底：非 stream 模式最多留 60 秒
      pcm.removeFirst(pcm.count - 16000 * 2 * 60)
    }
  }

  private func floatToInt16(_ value: Float32) -> Int16 {
    let clamped = max(-1, min(1, value))
    return Int16(clamped * 32767)
  }

  func rms() -> Float {
    totalFrames > 0 ? Float((sumSquares / Double(totalFrames)).squareRoot()) : 0
  }

  func frames() -> Int { totalFrames }

  func flushWindow() {
    if windowCount > 0 {
      windowRms.append(Float((windowAccum / Double(windowCount)).squareRoot()))
      windowAccum = 0
      windowCount = 0
    }
  }
}

func fourCC(_ value: OSType) -> String {
  let bytes = [
    UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF),
  ]
  return String(bytes: bytes, encoding: .ascii) ?? "????"
}

/* ------------------------------------------------------------------ *
 * WAV 封装（与 src/main/asr/index.ts 的 pcm16ToWav 一致）
 * ------------------------------------------------------------------ */

func writeWav(path: String, pcm: Data, sampleRate: Int, channels: Int) throws {
  var header = Data()
  func append32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  func append16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  let byteRate = UInt32(sampleRate * channels * 2)
  header.append(contentsOf: Array("RIFF".utf8))
  append32(UInt32(36 + pcm.count))
  header.append(contentsOf: Array("WAVE".utf8))
  header.append(contentsOf: Array("fmt ".utf8))
  append32(16)
  append16(1)
  append16(UInt16(channels))
  append32(UInt32(sampleRate))
  append32(byteRate)
  append16(UInt16(channels * 2))
  append16(16)
  header.append(contentsOf: Array("data".utf8))
  append32(UInt32(pcm.count))
  try (header + pcm).write(to: URL(fileURLWithPath: path))
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

@main
struct CaptureSCK {
  static func main() async {
    let opts = parseOptions()

    if opts.streamMode {
      // 裸 PCM 管道模式：所有诊断信息走 stderr，stdout 只放音频数据
      await runStream(opts)
      return
    }

    do {
      let content = try await SCShareableContent.current

      if opts.listOnly {
        emit([
          "ok": true,
          "permission": "granted",
          "displays": content.displays.map { ["id": Int($0.displayID), "width": $0.width, "height": $0.height] },
          "applications": content.applications.map { ["bundleId": $0.bundleIdentifier, "pid": Int($0.processID)] },
        ])
        return
      }

      guard let display = pickDisplay(content, index: opts.displayIndex) else {
        emit(["ok": false, "stage": "filter", "error": "没有可采集的显示器（SCShareableContent.displays 为空）"])
        exit(3)
      }

      let filter = makeFilter(display: display, content: content, bundleId: opts.appBundleId)
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.sampleRate = opts.sampleRate
      config.channelCount = opts.channelCount
      config.excludesCurrentProcessAudio = true
      // 只要系统混音，不要把麦克风混进来（captureMicrophone 默认 false；
      // macOS 15+ 才可显式设置，这里保持跨版本兼容不做赋值）
      config.width = 32  // 只采音频，视频尺寸压到最小以降低开销
      config.height = 32
      config.queueDepth = 3
      config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      config.showsCursor = false

      let sink = AudioSink()
      let stream = SCStream(filter: filter, configuration: config, delegate: nil)
      try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: DispatchQueue(label: "sck.audio"))

      try await stream.startCapture()
      let started = Date()
      try? await Task.sleep(nanoseconds: UInt64(max(0.2, opts.seconds) * 1_000_000_000))
      try await stream.stopCapture()
      sink.flushWindow()

      var result: [String: Any] = [
        "ok": true,
        "permission": "granted",
        "seconds": Date().timeIntervalSince(started),
        "audioCallbacks": sink.audioCallbackCount,
        "frames": sink.frames(),
        "sampleRate": opts.sampleRate,
        "channels": opts.channelCount,
        "peak": Double(sink.peak),
        "rms": Double(sink.rms()),
        "windowRms": sink.windowRms.map { Double($0) },
        "format": sink.formatDescription,
        "filter": opts.appBundleId == nil ? "display(wholeSystemMix)" : "app(\(opts.appBundleId!))",
      ]
      if let out = opts.outPath {
        try writeWav(path: out, pcm: sink.pcm, sampleRate: opts.sampleRate, channels: opts.channelCount)
        result["out"] = out
      }
      if let err = sink.firstError { result["firstError"] = err }
      emit(result)
    } catch {
      let ns = error as NSError
      var result: [String: Any] = [
        "ok": false,
        "stage": "startCapture",
        "error": ns.localizedDescription,
        "domain": ns.domain,
        "code": ns.code,
        "preflightScreenCapture": CGPreflightScreenCaptureAccess(),
      ]
      if ns.domain == SCStreamErrorDomain, ns.code == -3801 {
        result["hint"] = "用户未授权「屏幕录制」。系统设置 → 隐私与安全性 → 屏幕录制，勾选运行本程序的宿主（终端/Electron）。"
      }
      emit(result)
      exit(2)
    }
  }

  static func runStream(_ opts: Options) async {
    let sink = AudioSink()
    sink.streamToStdout = true
    // 与原版约定一致：startCapture 失败 → stderr 打 "failed: <原因>"。
    // 退回码同时保留，便于人工排查。
    let emitError: (String, String, Int) -> Void = { stage, message, code in
      let payload: [String: Any] = ["ok": false, "stage": stage, "error": message, "code": code]
      if let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8)
      {
        FileHandle.standardError.write("failed: \(line)\n".data(using: .utf8)!)
      }
      exit(Int32(code))
    }
    do {
      let content = try await SCShareableContent.current
      guard let display = pickDisplay(content, index: opts.displayIndex) else {
        emitError("filter", "没有可采集的显示器", 3)
        return
      }
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.sampleRate = opts.sampleRate
      config.channelCount = opts.channelCount
      config.excludesCurrentProcessAudio = true
      config.width = 32
      config.height = 32
      config.queueDepth = 3
      config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      config.showsCursor = false

      let stream = SCStream(
        filter: makeFilter(display: display, content: content, bundleId: opts.appBundleId),
        configuration: config, delegate: nil)
      try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: DispatchQueue(label: "sck.audio"))
      try await stream.startCapture()
      // 原版协议：就绪信号是 stderr 上单独一行 "ready"，stdout 只承载音频帧。
      FileHandle.standardError.write("ready\n".data(using: .utf8)!)
      // 一直跑到被主进程杀掉（SIGTERM/SIGINT → stopCapture）
      while true {
        try? await Task.sleep(nanoseconds: 200_000_000)
        if Task.isCancelled { break }
      }
      try await stream.stopCapture()
    } catch {
      let ns = error as NSError
      emitError("startCapture", "\(ns.localizedDescription) (domain=\(ns.domain) code=\(ns.code))", 2)
    }
  }

  static func pickDisplay(_ content: SCShareableContent, index: Int) -> SCDisplay? {
    if index >= 0 && index < content.displays.count { return content.displays[index] }
    return content.displays.first
  }

  static func makeFilter(display: SCDisplay, content: SCShareableContent, bundleId: String?) -> SCContentFilter {
    if let bundleId,
      let app = content.applications.first(where: { $0.bundleIdentifier == bundleId })
    {
      // 只采某个应用：麦克风混合里只保留该 app 的声音
      return SCContentFilter(display: display, including: [app], exceptingWindows: [])
    }
    return SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
  }

  static func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
      let line = String(data: data, encoding: .utf8)
    else { return }
    print("RESULT \(line)")
    fflush(stdout)
  }
}
