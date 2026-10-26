#!/usr/bin/env bash
#
# 构建「隐藏鼠标」原生 helper。
#
# 只依赖 Apple 自带工具链（swiftc + CoreGraphics），无第三方依赖、不新增 npm 依赖。
#
# 用法：
#   bash native/cursor-hide/build.sh                  # 编译出 native/cursor-hide/cursor-hide
#   bash native/cursor-hide/build.sh --probe          # 编译后立刻做一次净零能力探测
#   bash native/cursor-hide/build.sh --install <dir>  # 编译并安装到 <dir>（如 app 的 Resources）
#
# ⚠️ 不要用这个脚本做「长期隐藏光标」的实验：CGDisplayHideCursor 按次数计数，
#    进程退出不会自动恢复。要测清理行为请用 `cursor-hide --dry-run`（不碰光标）。
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${DIR}/cursor-hide"
SRC="${DIR}/cursor-hide.swift"

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
  -framework CoreGraphics \
  -o "${OUT}" "${SRC}"

chmod +x "${OUT}"
echo "==> 构建完成：${OUT}"

if [[ "${1:-}" == "--probe" ]]; then
  echo "==> 能力探测（净零自检，不会把你的光标留在隐藏态）："
  "${OUT}" --probe || true
  echo "==> 探测后状态："
  "${OUT}" --status || true
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
  mkdir -p "${DEST}/cursor-hide"
  cp -f "${OUT}" "${DEST}/cursor-hide/cursor-hide"
  chmod +x "${DEST}/cursor-hide/cursor-hide"
  echo "==> 已安装到：${DEST}/cursor-hide/cursor-hide"
fi
