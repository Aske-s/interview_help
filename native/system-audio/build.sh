#!/usr/bin/env bash
#
# 构建 macOS 系统音频采集 helper（方案 C）。
#
# 只依赖 Apple 自带工具链（swiftc + ScreenCaptureKit / AVFoundation 系统框架），
# 不需要 Xcode 工程、不需要任何第三方依赖、不新增 npm 依赖。
#
# 用法：
#   ./build.sh              # 编译到当前目录的 capture-sck
#   ./build.sh --run-test   # 编译并做一次 6 秒实测（需先授予「屏幕录制」权限）
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${DIR}/capture-sck"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "错误：未找到 swiftc。请安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

echo "==> swiftc 版本：$(swiftc --version | head -1)"
# -parse-as-library：源码里用了 @main，必须显式声明
swiftc -O -parse-as-library \
  -target arm64-apple-macosx13.0 \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics \
  -o "${OUT}" "${DIR}/capture-sck.swift"

echo "==> 构建完成：${OUT}"
chmod +x "${OUT}"

if [[ "${1:-}" == "--run-test" ]]; then
  echo "==> 实测 6 秒（若报 -3801，请到 系统设置 → 隐私与安全性 → 屏幕录制 勾选当前终端）"
  # 播一段测试音，用来验证「是否真的抓到了系统输出」
  TESTAUDIO="$(mktemp -t suisi-test).wav"
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=660:duration=5" -ar 44100 -ac 1 -y "${TESTAUDIO}" || true
    ( afplay "${TESTAUDIO}" & ) || true
  fi
  "${OUT}" --seconds 6 --out "${DIR}/sck-test.wav"
  rm -f "${TESTAUDIO}"
fi
