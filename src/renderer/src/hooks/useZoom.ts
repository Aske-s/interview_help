import React from 'react'

/**
 * 界面等比缩放。
 *
 * 通过 Electron 的 webContents.setZoomFactor 生效，因此文字、图标、
 * 内边距会一起按比例缩放（真正的「等比」），而不是只改字号导致布局错位。
 * 快捷键：⌘/Ctrl + = 放大、⌘/Ctrl + - 缩小、⌘/Ctrl + 0 复位。
 */

const MIN = 0.5
const MAX = 2.5
const STEP = 0.1
const STORAGE_KEY = 'app-zoom'

function clamp(value: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(value * 100) / 100))
}

interface ZoomBridge {
  app?: {
    setZoom?: (factor: number) => Promise<number>
  }
}

export function useZoom(): {
  zoom: number
  setZoom: (value: number) => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
} {
  const [zoom, setZoomState] = React.useState(1)
  const zoomRef = React.useRef(1)

  const apply = React.useCallback(async (value: number): Promise<void> => {
    const next = clamp(value)
    zoomRef.current = next
    setZoomState(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      /* 无痕模式等场景忽略 */
    }
    const bridge = (window as unknown as { api?: ZoomBridge }).api
    const actual = await bridge?.app?.setZoom?.(next).catch(() => next)
    if (typeof actual === 'number' && actual !== next) {
      zoomRef.current = actual
      setZoomState(actual)
    }
  }, [])

  /* 启动时套用上次的缩放值 */
  React.useEffect(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    if (Number.isFinite(saved) && saved >= MIN && saved <= MAX && saved !== 1) {
      void apply(saved)
    }
  }, [apply])

  const setZoom = React.useCallback((value: number) => void apply(value), [apply])
  const zoomIn = React.useCallback(() => void apply(zoomRef.current + STEP), [apply])
  const zoomOut = React.useCallback(() => void apply(zoomRef.current - STEP), [apply])
  const reset = React.useCallback(() => void apply(1), [apply])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        void apply(zoomRef.current + STEP)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        void apply(zoomRef.current - STEP)
      } else if (e.key === '0') {
        e.preventDefault()
        void apply(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply])

  return { zoom, setZoom, zoomIn, zoomOut, reset }
}
