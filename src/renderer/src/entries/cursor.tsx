import React from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { ErrorBoundary } from '@renderer/ui'
import App from '@renderer/windows/cursor/App'

/**
 * 替代光标入口。
 *
 * 这个窗口覆盖整个屏幕、完全透明、鼠标穿透（forward: true），
 * 只用来在真实光标被藏起来时画出替身，因此根节点必须撑满且不能有任何背景。
 */
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

createRoot(container).render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(ErrorBoundary, { name: '替代光标' }, React.createElement(App))
  )
)
