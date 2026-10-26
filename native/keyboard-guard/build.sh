#!/usr/bin/env bash
#
# 构建「键盘防护」原生 helper。
#
# 只依赖 Apple 自带工具链（swiftc + CoreGraphics / ApplicationServices / Carbon 系统框架），
# 不需要 Xcode 工程、不需要任何第三方依赖、不新增 npm 依赖、不下载任何东西。
#
# 用法：
#   bash native/keyboard-guard/build.sh                 # 编译出 native/keyboard-guard/keyboard-guard
#   bash native/keyboard-guard/build.sh --probe         # 编译后立刻跑一次能力探测
#   bash native/keyboard-guard/build.sh --install <dir> # 编译并安装到 <dir>（例如 app 的 Resources 目录）#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${DIR}/keyboard-guard"
SRC="${DIR}/keyboard-guard.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "错误：未找到 swiftc。请安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  arm64) TARGET="arm64-apple-macosx13.0" ;;
  x86_64) TARGET="x86_64-apple-macosx13.0" ;;
  *) TARGET="${ARCH}-apple-macosx13.0" ;;
esac

echo "==> swiftc 版本：$(swiftc --version | head -1)"
echo "==> 目标平台：${TARGET}"

swiftc -O \
  -target "${TARGET}" \
  -framework CoreGraphics -framework ApplicationServices -framework Carbon \
  -o "${OUT}" "${SRC}"

chmod +x "${OUT}"
echo "==> 构建完成：${OUT}"

if [[ "${1:-}" == "--probe" ]]; then
  echo "==> 能力探测："
  "${OUT}" --probe || true
fi

if [[ "${1:-}" == "--install" ]]; then
  DEST="${2:-}"
  if [[ -z "${DEST}" ]]; then
    echo "错误：--install 需要目标目录，例如 --install \"\${APP}/Contents/Resources\"" >&2
    exit 1
  fi
  if [[ ! -d "${DEST}" ]]; then
    echo "错误：目标目录不存在：${DEST}" >&2
    exit 1
  fi
  mkdir -p "${DEST}/keyboard-guard"
  cp -f "${OUT}" "${DEST}/keyboard-guard/keyboard-guard"
  chmod +x "${DEST}/keyboard-guard/keyboard-guard"
  echo "==> 已安装到：${DEST}/keyboard-guard/keyboard-guard"
fi
