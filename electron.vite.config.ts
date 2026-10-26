import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          floating: resolve('src/preload/floating.ts'),
          quiz: resolve('src/preload/quiz.ts'),
          interview: resolve('src/preload/interview.ts'),
          capture: resolve('src/preload/capture.ts'),
          quizbar: resolve('src/preload/quizbar.ts'),
          cursor: resolve('src/preload/cursor.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer/src') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          floating: resolve('src/renderer/floating.html'),
          quiz: resolve('src/renderer/quiz.html'),
          interview: resolve('src/renderer/interview.html'),
          capture: resolve('src/renderer/capture.html'),
          quizbar: resolve('src/renderer/quizbar.html'),
          cursor: resolve('src/renderer/cursor.html')
        }
      }
    }
  }
})
