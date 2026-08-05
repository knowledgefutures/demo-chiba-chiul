/**
 * Shared pieces, and the mark language.
 *
 * `KIND_STYLE` is the single source of truth for what a kind looks like. The corpus map,
 * the session strip and the transcript all read from it, which is what makes the same
 * colour mean the same thing at every scale.
 */
import type { ReactNode } from 'react'

import type { Detail } from './api.ts'
import type { Kind } from '../lib/chi/kinds.ts'

export const KIND_STYLE: Record<
  Kind,
  { label: string; fill: string; text: string; wash: string; border: string; opacity: number }
> = {
  human: {
    label: 'Human',
    fill: 'var(--color-human)',
    text: 'text-human',
    wash: 'bg-human-wash',
    border: 'border-human/30',
    opacity: 1,
  },
  model: {
    label: 'Model',
    fill: 'var(--color-model)',
    text: 'text-model',
    wash: 'bg-model-wash',
    border: 'border-model/30',
    opacity: 1,
  },
  thinking: {
    // Same hue as `model` — thinking *is* the model — separated by weight rather than a
    // fourth hue, which keeps the identity palette at three and CVD-safe.
    label: 'Thinking',
    fill: 'var(--color-model)',
    text: 'text-model',
    wash: 'bg-model-wash',
    border: 'border-model/20',
    opacity: 0.4,
  },
  tool: {
    label: 'Tool',
    fill: 'var(--color-tool)',
    text: 'text-tool',
    wash: 'bg-tool-wash',
    border: 'border-tool/30',
    opacity: 1,
  },
  event: {
    label: 'Event',
    fill: 'var(--color-event)',
    text: 'text-ink-3',
    wash: 'bg-line',
    border: 'border-line',
    opacity: 0.7,
  },
}

export const KIND_ORDER: Kind[] = ['human', 'model', 'thinking', 'tool', 'event']

/** Always present wherever marks are — identity is never colour alone. */
export function KindLegend({ counts }: { counts?: Partial<Record<Kind, number>> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      {KIND_ORDER.map((kind) => {
        const style = KIND_STYLE[kind]
        return (
          <li key={kind} className="flex items-center gap-1.5 text-[11px] text-ink-2">
            <span
              className="h-2.5 w-1.5 rounded-[1px]"
              style={{ background: style.fill, opacity: style.opacity }}
            />
            {style.label}
            {counts?.[kind] !== undefined ? (
              <span className="font-mono text-[10px] tabular-nums text-ink-3">
                {counts[kind]!.toLocaleString()}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A pane. Hairline border, square-ish, and the header separated by a rule rather than by
 * padding — so several panes in a column read as one instrument face.
 */
export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return (
    <section className={`rounded-[3px] border border-line bg-surface ${className}`}>
      {title ? (
        <header className="flex items-baseline gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <h2 className="text-[12px] font-semibold leading-tight tracking-tight">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{subtitle}</p> : null}
          </div>
          {action ? <div className="ml-auto shrink-0">{action}</div> : null}
        </header>
      ) : null}
      <div className={pad ? 'p-3' : ''}>{children}</div>
    </section>
  )
}

/**
 * A stat tile. The value is mono and tabular so a row of them forms a column of digits —
 * the thing that most makes a dashboard feel like an instrument rather than a page.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'human' | 'model' | 'tool'
}) {
  const rule =
    tone === 'human'
      ? 'bg-human'
      : tone === 'model'
        ? 'bg-model'
        : tone === 'tool'
          ? 'bg-tool'
          : 'bg-rule'
  return (
    <div className="relative overflow-hidden rounded-[3px] border border-line bg-surface px-3 py-2.5">
      <span className={`absolute inset-y-0 left-0 w-[2px] ${rule}`} />
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 font-mono text-[22px] font-medium leading-none tracking-tight tabular-nums">
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-[11px] leading-snug text-ink-3">{hint}</div> : null}
    </div>
  )
}

const DETAIL_STYLE: Record<Detail, { light: string; dark: string; label: string }> = {
  full: {
    light: 'bg-human-wash text-human border-human/35',
    dark: 'bg-human/20 text-white border-human/50',
    label: 'raw records',
  },
  reduced: {
    light: 'bg-model-wash text-model border-model/35',
    dark: 'bg-model/30 text-white border-model/50',
    label: 'summaries',
  },
  metrics: {
    light: 'bg-warn-wash text-warn border-warn/35',
    dark: 'bg-warn/25 text-shell-ink border-warn/45',
    label: 'shape only',
  },
  none: {
    light: 'bg-plane text-ink-3 border-rule',
    dark: 'bg-shell-line text-shell-muted border-shell-line',
    label: 'no access',
  },
}

export function DetailBadge({ detail, onDark = false }: { detail: Detail; onDark?: boolean }) {
  const style = DETAIL_STYLE[detail]
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-[2px] border px-1 py-px font-mono text-[10px] leading-[1.4] ${
        onDark ? style.dark : style.light
      }`}
      title={`Grant level: ${detail}`}
    >
      {style.label}
    </span>
  )
}

/** Horizontal bars for one measure. One series, so no legend — the labels name each row. */
export function Bars({
  rows,
  max,
  format = (n: number) => n.toLocaleString(),
  tone = 'var(--color-human)',
}: {
  rows: { label: string; value: number }[]
  max?: number
  format?: (n: number) => string
  tone?: string
}) {
  const ceiling = max ?? Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-[3px]">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-2">
          <span className="truncate font-mono text-[11px] text-ink-2" title={row.label}>
            {row.label}
          </span>
          <span className="h-[7px] bg-plane">
            <span
              className="block h-full rounded-r-[1px]"
              style={{
                width: `${Math.max(0.7, (row.value / ceiling) * 100)}%`,
                background: tone,
              }}
            />
          </span>
          <span className="text-right font-mono text-[11px] tabular-nums text-ink-2">
            {format(row.value)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-2">
      <span className="size-3 animate-spin rounded-full border border-rule border-t-accent" />
      {label}
    </div>
  )
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn'; children: ReactNode }) {
  const style =
    kind === 'warn'
      ? 'border-warn/35 bg-warn-wash text-ink'
      : 'border-accent/30 bg-accent-wash text-ink'
  return (
    <div className={`rounded-[2px] border px-2.5 py-1.5 text-[11px] leading-snug ${style}`}>
      {children}
    </div>
  )
}

/** A dense table. One place decides the row rhythm so every table matches. */
export function Th({
  children,
  align = 'left',
}: {
  children: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={`border-b border-line pb-1.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <span className="eyebrow">{children}</span>
    </th>
  )
}

export function Td({
  children,
  align = 'left',
  mono = false,
  className = '',
}: {
  children: ReactNode
  align?: 'left' | 'right'
  mono?: boolean
  className?: string
}) {
  return (
    <td
      className={`border-b border-line/70 py-1.5 ${align === 'right' ? 'text-right' : ''} ${
        mono ? 'font-mono' : ''
      } ${className}`}
    >
      {children}
    </td>
  )
}

export const fmtUsd = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

export const fmtCompact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n)

/**
 * One page header for every page, so the top of the app has a single rhythm.
 *
 * Deliberately small: a 15px title over an 11px line, on one hairline. A large heading
 * eats vertical space that a dense tool wants for data, and reads as a document.
 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2.5">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold leading-tight tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-[11px] leading-snug text-ink-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}

/** A compact control. One button style, so nothing on screen is accidentally emphatic. */
export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'default' | 'primary'
  type?: 'button' | 'submit'
}) {
  const style =
    variant === 'primary'
      ? 'bg-accent text-white border-accent hover:opacity-90'
      : 'border-line bg-surface hover:border-rule hover:bg-plane'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-[5px] text-[11px] font-medium transition disabled:opacity-40 ${style}`}
    >
      {children}
    </button>
  )
}
