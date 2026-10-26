import React from 'react'
import type { CaptureWindowApi } from '@shared/ipc'

/**
 * 选区截图覆盖层。
 *
 * 全屏透明窗口：把主进程抓到的整屏图铺满，用户拖拽选区后裁剪回传。
 * 零依赖，纯 canvas + 鼠标事件。
 */

const api = window.api as unknown as CaptureWindowApi

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export default function App(): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const dragStart = React.useRef<{ x: number; y: number } | null>(null)
  const [rect, setRect] = React.useState<Rect | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState('')

  /* 载入底图 */
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dataUrl = await api.getSource()
        if (!dataUrl) throw new Error('未能获取屏幕画面')
        const image = new Image()
        image.onload = () => {
          if (cancelled) return
          imageRef.current = image
          setReady(true)
        }
        image.onerror = () => setError('底图加载失败')
        image.src = dataUrl
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        // 拿不到底图时绝不能把用户困在全屏遮罩里：3 秒后自动退出
        window.setTimeout(() => api.cancel(), 3000)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* 绘制遮罩与选区 */
  React.useEffect(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    canvas.style.width = `${window.innerWidth}px`
    canvas.style.height = `${window.innerHeight}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

    // 底图按窗口尺寸等比铺满（截图分辨率可能与窗口不同）
    ctx.drawImage(image, 0, 0, window.innerWidth, window.innerHeight)

    // 暗色遮罩 + 选区镂空
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)
    if (rect && rect.w > 1 && rect.h > 1) {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
      ctx.drawImage(
        image,
        (rect.x / window.innerWidth) * image.width,
        (rect.y / window.innerHeight) * image.height,
        (rect.w / window.innerWidth) * image.width,
        (rect.h / window.innerHeight) * image.height,
        rect.x,
        rect.y,
        rect.w,
        rect.h
      )
      ctx.strokeStyle = 'rgb(118,140,255)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)

      // 尺寸提示
      const label = `${Math.round(rect.w)} × ${Math.round(rect.h)}`
      ctx.font = '12px -apple-system, sans-serif'
      const padding = 6
      const textWidth = ctx.measureText(label).width
      const boxY = rect.y > 24 ? rect.y - 22 : rect.y + rect.h + 6
      ctx.fillStyle = 'rgba(20,20,30,0.85)'
      ctx.fillRect(rect.x, boxY, textWidth + padding * 2, 18)
      ctx.fillStyle = '#eceef8'
      ctx.fillText(label, rect.x + padding, boxY + 13)
    }
  }, [rect, ready])

  const confirm = React.useCallback(() => {
    const image = imageRef.current
    if (!image || !rect || rect.w < 3 || rect.h < 3) return
    const scaleX = image.width / window.innerWidth
    const scaleY = image.height / window.innerHeight
    const out = document.createElement('canvas')
    out.width = Math.round(rect.w * scaleX)
    out.height = Math.round(rect.h * scaleY)
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.drawImage(
      image,
      Math.round(rect.x * scaleX),
      Math.round(rect.y * scaleY),
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height
    )
    api.done(out.toDataURL('image/png'))
  }, [rect])

  /* 键盘：Esc 取消，Enter 确认 */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') api.cancel()
      if (e.key === 'Enter') confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm])

  const onMouseDown = (e: React.MouseEvent) => {
    dragStart.current = { x: e.clientX, y: e.clientY }
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const start = dragStart.current
    if (!start) return
    setRect({
      x: Math.min(start.x, e.clientX),
      y: Math.min(start.y, e.clientY),
      w: Math.abs(e.clientX - start.x),
      h: Math.abs(e.clientY - start.y)
    })
  }

  const onMouseUp = () => {
    if (dragStart.current && rect && rect.w > 3 && rect.h > 3) confirm()
    dragStart.current = null
  }

  return (
    <div
      className="h-full w-full cursor-crosshair select-none"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <canvas ref={canvasRef} className="block" />
      <div className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white">
        {error ? `${error}（3 秒后自动退出）` : '拖拽框选题目区域 · Esc 取消'}
      </div>
    </div>
  )
}
