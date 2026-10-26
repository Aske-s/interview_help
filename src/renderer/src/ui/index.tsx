import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 共用 UI 套件（Lead 维护）。
 *
 * 视觉规范严格对齐「随思」原版：
 *  - 令牌命名沿用原版 --ss-* 体系（--ss-1/2/3 表面、--ss-border 边框、
 *    --ss-primary 主色（黑底白字）、--ss-text/muted/faint 文字层级、--ss-mic 麦克风蓝）
 *  - 主按钮为深色实底，次级按钮为白底细边框，圆角 8px，字号 13px
 *
 * 约定：各窗口目录只允许 import，不允许修改本目录。
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ *
 * 基础控件
 * ------------------------------------------------------------------ */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonProps): React.ReactElement {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed select-none ss-no-drag whitespace-nowrap'
  const sizes = { sm: 'h-7 px-2.5 text-[12px]', md: 'h-9 px-3.5 text-[13px]' }
  const variants = {
    primary: 'bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))] hover:opacity-90',
    secondary:
      'bg-[rgb(var(--ss-1))] text-[rgb(var(--ss-text))] border border-[rgb(var(--ss-border))] hover:bg-[rgb(var(--ss-2))]',
    ghost: 'text-[rgb(var(--ss-muted))] hover:text-[rgb(var(--ss-text))] hover:bg-[rgb(var(--ss-2))]',
    danger: 'bg-[rgb(var(--ss-danger))] text-white hover:opacity-90'
  }
  return <button className={cx(base, sizes[size], variants[variant], className)} {...rest} />
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return (
    <input
      className={cx(
        'h-9 w-full rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] px-3 text-[13px] text-[rgb(var(--ss-text))] outline-none ss-no-drag transition-colors',
        'placeholder:text-[rgb(var(--ss-faint))] focus:border-[rgb(var(--ss-accent))]',
        className
      )}
      {...rest}
    />
  )
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  return (
    <textarea
      className={cx(
        'w-full resize-y rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-3 text-[13px] leading-relaxed text-[rgb(var(--ss-text))] outline-none ss-no-drag transition-colors',
        'placeholder:text-[rgb(var(--ss-faint))] focus:border-[rgb(var(--ss-accent))]',
        className
      )}
      {...rest}
    />
  )
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <select
      className={cx(
        'h-9 w-full rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] px-2.5 text-[13px] text-[rgb(var(--ss-text))] outline-none ss-no-drag',
        'focus:border-[rgb(var(--ss-accent))]',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  hint?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <label className={cx('flex items-start gap-3 ss-no-drag', disabled && 'opacity-50')}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors',
          checked ? 'bg-[rgb(var(--ss-primary))]' : 'bg-[rgb(var(--ss-3))]'
        )}
        aria-pressed={checked}
      >
        <span
          className={cx(
            'block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
          )}
        />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-[13px] text-[rgb(var(--ss-text))]">{label}</span>}
          {hint && <span className="mt-0.5 block text-[12px] leading-relaxed text-[rgb(var(--ss-muted))]">{hint}</span>}
        </span>
      )}
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="text-[12px] font-medium text-[rgb(var(--ss-muted))]">{label}</div>
      {children}
      {hint && <div className="text-[11px] leading-relaxed text-[rgb(var(--ss-faint))]">{hint}</div>}
    </div>
  )
}

export function Card({
  title,
  extra,
  children,
  className,
  padded = true
}: {
  title?: string
  extra?: React.ReactNode
  children: React.ReactNode
  className?: string
  padded?: boolean
}): React.ReactElement {
  return (
    <section className={cx('rounded-xl border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))]', padded && 'p-4', className)}>
      {(title || extra) && (
        <header className={cx('flex items-center justify-between gap-3', padded ? 'mb-3' : 'border-b border-[rgb(var(--ss-border))] px-4 py-2.5')}>
          {title && <h2 className="text-[13px] font-semibold text-[rgb(var(--ss-text))]">{title}</h2>}
          {extra}
        </header>
      )}
      {children}
    </section>
  )
}

export function Badge({
  tone = 'muted',
  children
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' | 'mic'
  children: React.ReactNode
}): React.ReactElement {
  const tones = {
    muted: 'bg-[rgb(var(--ss-2))] text-[rgb(var(--ss-muted))]',
    ok: 'bg-[rgb(var(--ss-success)/0.12)] text-[rgb(var(--ss-success))]',
    warn: 'bg-[rgb(var(--ss-warning)/0.14)] text-[rgb(var(--ss-warning))]',
    danger: 'bg-[rgb(var(--ss-danger)/0.12)] text-[rgb(var(--ss-danger))]',
    accent: 'bg-[rgb(var(--ss-accent)/0.1)] text-[rgb(var(--ss-text))]',
    mic: 'bg-[rgb(var(--ss-mic)/0.12)] text-[rgb(var(--ss-mic))]'
  }
  return (
    <span className={cx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  )
}

/**
 * 标签页。原版风格：一行文本，选中项有浅色底与更深文字色。
 * variant='pill' 用于悬浮窗右侧的智能体/分类切换。
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  variant = 'text',
  className
}: {
  value: T
  onChange: (v: T) => void
  items: Array<{ value: T; label: string; dot?: boolean }>
  variant?: 'text' | 'pill'
  className?: string
}): React.ReactElement {
  return (
    <nav className={cx('flex shrink-0 items-center gap-1 ss-no-drag', className)}>
      {items.map((item) => {
        const active = value === item.value
        if (variant === 'pill') {
          return (
            <button
              key={item.value}
              onClick={() => onChange(item.value)}
              className={cx(
                'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                active
                  ? 'border-[rgb(var(--ss-primary))] bg-[rgb(var(--ss-primary))] text-[rgb(var(--ss-primary-fg))]'
                  : 'border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] text-[rgb(var(--ss-muted))] hover:text-[rgb(var(--ss-text))]'
              )}
            >
              {item.dot && <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--ss-danger))]" />}
              {item.label}
            </button>
          )
        }
        return (
          <button
            key={item.value}
            onClick={() => onChange(item.value)}
            className={cx(
              'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
              active
                ? 'bg-[rgb(var(--ss-2))] text-[rgb(var(--ss-text))]'
                : 'text-[rgb(var(--ss-muted))] hover:text-[rgb(var(--ss-text))]'
            )}
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

export function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-6 text-center text-[13px] leading-relaxed text-[rgb(var(--ss-faint))]">
      {children}
    </div>
  )
}

/** 侧边栏竖排导航项（原版左侧主导航的样式） */
export function NavItem({
  active,
  onClick,
  children,
  className
}: {
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-[13px] transition-colors ss-no-drag',
        active
          ? 'bg-[rgb(var(--ss-2))] font-medium text-[rgb(var(--ss-text))]'
          : 'text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-2)/0.6)] hover:text-[rgb(var(--ss-text))]',
        className
      )}
    >
      {children}
    </button>
  )
}

/** 列表项左键切换/选中的行容器 */
export function ListRow({
  active,
  onClick,
  children,
  className
}: {
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ss-no-drag',
        active ? 'bg-[rgb(var(--ss-2))]' : 'hover:bg-[rgb(var(--ss-2)/0.6)]',
        className
      )}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 错误边界：任何渲染异常都要给出可读提示，不能白屏
 * ------------------------------------------------------------------ */

export class ErrorBoundary extends React.Component<
  { children?: React.ReactNode; name?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[${this.props.name ?? 'ui'}] 渲染异常：`, error, info.componentStack)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ss-app-shell flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-[14px] font-medium text-[rgb(var(--ss-danger))]">界面出错了</div>
        <div className="max-h-40 max-w-md overflow-auto rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-1))] p-3 text-left font-mono text-[11px] leading-relaxed text-[rgb(var(--ss-muted))]">
          {error.message}
        </div>
        <button
          className="rounded-lg bg-[rgb(var(--ss-primary))] px-3.5 py-2 text-[13px] text-[rgb(var(--ss-primary-fg))] ss-no-drag"
          onClick={() => this.setState({ error: null })}
        >
          重试
        </button>
      </div>
    )
  }
}

/* ------------------------------------------------------------------ *
 * Markdown / 思维链
 * ------------------------------------------------------------------ */

/**
 * 代码块（原版 codeBlock.*）。
 *
 * 原版有两条：`codeBlock.copyCode` = 复制代码、`codeBlock.wrapLines` = 切换自动换行。
 * 代码题不给人复制按钮基本没法用，所以这两个是刚需。
 */
function CodeBlock({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [wrap, setWrap] = React.useState(false)

  /**
   * 复制代码。
   *
   * 顺序很重要：**先走主进程**。
   * 悬浮窗是 focusable:false 的（为了不抢焦点），而 navigator.clipboard.writeText()
   * 要求文档已聚焦，否则抛 NotAllowedError: Document is not focused ——
   * 只写渲染层 fallback 会出现「点了复制但剪贴板里没有」。
   */
  const copy = async (): Promise<void> => {
    let ok = false
    try {
      const api = (window as unknown as { api?: { clipboard?: { writeText?: (t: string) => Promise<boolean> } } }).api
      ok = (await api?.clipboard?.writeText?.(code)) === true
    } catch {
      ok = false
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(code)
        ok = true
      } catch {
        // 最后兜底：execCommand
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          ok = document.execCommand('copy')
        } catch {
          ok = false
        }
        document.body.removeChild(ta)
      }
    }
    setCopied(ok)
    // 失败也要给反馈，不能静默什么都不发生
    setFailed(!ok)
    window.setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, 1500)
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-base)/0.6)]">
      <div className="flex items-center gap-2 border-b border-[rgb(var(--ss-border))] px-2 py-1">
        <span className="text-[10px] uppercase text-[rgb(var(--ss-faint))]">{lang || 'text'}</span>
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-[rgb(var(--ss-muted))] hover:bg-[rgb(var(--ss-3))] ss-no-drag"
          title="切换自动换行"
          onClick={() => setWrap((v) => !v)}
        >
          切换自动换行
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-[10px] text-[rgb(var(--ss-accent))] hover:bg-[rgb(var(--ss-3))] ss-no-drag"
          onClick={() => void copy()}
        >
          {copied ? '已复制' : failed ? '复制失败' : '复制代码'}
        </button>
      </div>
      <pre
        className={cx(
          'm-0 overflow-auto p-2.5 text-[12px] leading-relaxed',
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        )}
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  )
}

export function Markdown({ children, className }: { children: string; className?: string }): React.ReactElement {
  return (
    <div className={cx('ss-markdown text-[13px]', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: cls, children: kids, ...rest }) {
            const text = String(kids ?? '')
            const match = /language-(\w+)/.exec(cls ?? '')
            // 有 language-xxx 或内容含换行 → 视为围栏代码块，走代码框
            const isBlock = Boolean(match) || text.includes('\n')
            if (!isBlock) {
              return (
                <code
                  className="rounded bg-[rgb(var(--ss-3))] px-1 py-0.5 font-mono text-[12px]"
                  {...rest}
                >
                  {text}
                </code>
              )
            }
            return <CodeBlock code={text.replace(/\n$/, '')} lang={match?.[1] ?? ''} />
          },
          // 代码框自己带 <pre>，这里避免双重包裹导致样式错乱
          pre({ children: kids }) {
            return <>{kids}</>
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** 思维链折叠块（默认折叠，原版行为） */
export function ThinkBlock({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  if (!text.trim()) return null
  return (
    <div className="mb-2 rounded-lg border border-[rgb(var(--ss-border))] bg-[rgb(var(--ss-2)/0.6)] ss-no-drag">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-[rgb(var(--ss-muted))]"
      >
        <span className="text-[9px]">{open ? '▼' : '▶'}</span>
        <span>思考过程{streaming ? '（进行中）' : ''}</span>
      </button>
      {open && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-2.5 pb-2 text-[11px] leading-relaxed text-[rgb(var(--ss-muted))]">
          {text}
        </pre>
      )}
    </div>
  )
}
