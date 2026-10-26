import type { WindowApi } from '@shared/ipc'

declare global {
  interface Window {
    /** 由预加载脚本注入；具体形态取决于当前窗口（见 shared/ipc.ts 的 WindowApi） */
    api: WindowApi
  }
}

export {}
