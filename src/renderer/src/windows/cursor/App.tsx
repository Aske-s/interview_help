import React from 'react'

/**
 * 安全模式「替代光标」渲染层。
 *
 * 背景：安全模式会调用原生 helper 把**真实系统光标**藏起来（这样屏幕共享/录屏里
 * 看不到鼠标位置）。但本机用户如果看不到任何光标就会失去位置感，所以由这个全屏透明
 * 窗口画一个**替代光标**：白底 + 黑描边 + 阴影，任何底色上都看得清。
 *
 * 位置来源（两种都支持，优先级从高到低）：
 *   1) Lead 通过 IPC 推位置 —— window.api.onCursorPosition(cb)（推荐：
 *      替代光标窗口一般是 setIgnoreMouseEvents(true) 的点击穿透窗口，
 *      开了 forward 才会收到 mousemove；主进程用 screen.getCursorScreenPoint()
 *      轮询推送最可靠，多显示器也不会有坐标偏移问题）。
 *   2) 自包含兜底：直接监听 window 的 mousemove —— 不依赖任何 IPC 也能工作
 *      （需要窗口以 setIgnoreMouseEvents(true, { forward: true }) 创建）。
 *
 * 本组件零依赖、不做任何原生调用，也不关心隐藏是否成功；隐藏/恢复由主进程
 * src/main/cursor 负责。窗口本体（透明 + 无边框 + 点击穿透）由 Lead 创建。
 */

/** 替代光标的视觉尺寸（CSS 像素），热点是箭头尖端（左上角） */
const ARROW_WIDTH = 21
const ARROW_HEIGHT = 28

/** 可选 IPC：Lead 若实现就优先用，位置比 mousemove 更可靠 */
interface CursorOverlayApi {
  onCursorPosition?: (callback: (point: { x: number; y: number }) => void) => (() => void) | void
  /** 兼容另一种常见命名 */
  onCursorMove?: (callback: (point: { x: number; y: number }) => void) => (() => void) | void
}

interface Point {
  x: number
  y: number
}

/** 经典 macOS 箭头轮廓（viewBox 24x31，尖端在 0,0 附近） */
const ARROW_PATH =
  'M2.6 1.4 L2.6 25.2 L8.3 19.6 L12.1 29.4 L16.2 27.7 L12.4 18.1 L19.9 18.1 Z'

export default function App(): React.ReactElement {
  const [point, setPoint] = React.useState<Point | null>(null)
  const latest = React.useRef<Point | null>(null)
  const frame = React.useRef<number | null>(null)

  /** 用 rAF 节流：mousemove/IPC 可能高频，避免每来一次就 setState */
  const schedule = React.useCallback((next: Point): void => {
    latest.current = next
    if (frame.current !== null) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null
      const value = latest.current
      if (value) {
        setPoint((previous) =>
          previous && previous.x === value.x && previous.y === value.y ? previous : { x: value.x, y: value.y }
        )
      }
    })
  }, [])

  React.useEffect(() => {
    const api = (window as unknown as { api?: CursorOverlayApi }).api
    const subscribe = api?.onCursorPosition ?? api?.onCursorMove

    if (typeof subscribe === 'function') {
      const unsubscribe = subscribe((next) => {
        if (next && Number.isFinite(next.x) && Number.isFinite(next.y)) schedule({ x: next.x, y: next.y })
      })
      if (typeof unsubscribe === 'function') {
        return () => {
          unsubscribe()
          if (frame.current !== null) window.cancelAnimationFrame(frame.current)
        }
      }
    }

    // 兜底：自包含监听 mousemove（不依赖 IPC）
    const onMove = (event: MouseEvent): void => schedule({ x: event.clientX, y: event.clientY })
    window.addEventListener('mousemove', onMove, { passive: true })
    // 鼠标离开窗口时保留最后位置（真实光标仍被隐藏，替代光标不能凭空消失）
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    }
  }, [schedule])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: 'transparent',
        cursor: 'none', // 本窗口内不显示系统光标，避免出现「双光标」
        pointerEvents: 'none', // 全窗口点击穿透（配合主进程 setIgnoreMouseEvents）
        userSelect: 'none',
        WebkitUserSelect: 'none'
      }}
    >
      {point ? (
        <svg
          width={ARROW_WIDTH}
          height={ARROW_HEIGHT}
          viewBox="0 0 24 31"
          style={{
            position: 'fixed',
            // 热点（箭头尖端）对齐鼠标位置；外层容器不加任何 translate
            left: point.x,
            top: point.y,
            // 白底 + 黑描边 + 阴影：亮色/暗色/花哨背景上都能看清
            filter: 'drop-shadow(0 0 1.2px rgba(0,0,0,0.95)) drop-shadow(0 1px 2px rgba(0,0,0,0.55))',
            willChange: 'left, top'
          }}
          aria-hidden="true"
        >
          <path d={ARROW_PATH} fill="#ffffff" stroke="#000000" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      ) : null}
    </div>
  )
}
