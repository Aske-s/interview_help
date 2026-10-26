import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@renderer/windows/quizbar/App'
import { ErrorBoundary } from '@renderer/ui'
import '@renderer/styles/globals.css'

/**
 * 悬浮工具条入口。
 * 窗口很小且透明，因此根节点必须撑满且背景透明。
 */
const root = document.getElementById('root')
if (root) {
  document.body.style.margin = '0'
  document.body.style.background = 'transparent'
  document.documentElement.style.background = 'transparent'
  document.documentElement.style.overflow = 'hidden'
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary name="quizbar">
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
