/** 应用内的窗口种类。与 src/renderer/*.html 一一对应。 */
export type WindowKind = 'main' | 'floating' | 'quiz' | 'interview' | 'capture' | 'quizbar' | 'cursor'

export const WINDOW_KINDS: WindowKind[] = [
  'main',
  'floating',
  'quiz',
  'interview',
  'capture',
  'quizbar',
  'cursor'
]
