import React from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/globals.css'
import { ErrorBoundary } from '@renderer/ui'
import App from '@renderer/windows/main/App'

/** 各窗口统一入口：套一层错误边界，渲染异常时给出可读提示而不是白屏 */
const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

createRoot(container).render(
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(ErrorBoundary, { name: '主窗口' }, React.createElement(App))
  )
)
