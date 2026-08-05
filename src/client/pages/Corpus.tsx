/**
 * The whole corpus, at once.
 *
 * Every one of the 9,299 records is on this page as a single mark, coloured by kind. That
 * is possible because the server sends each session's shape as a string of
 * single-character codes — about 9 KB for the entire corpus — so there is nothing to page
 * through and no reason not to draw all of it.
 *
 * Two things this earns beyond looking good. The rhythm of agent work becomes visible:
 * the long aqua runs are tool loops, the violet blocks are reasoning, and the thin blue
 * ticks are the human, who turns out to speak rarely. And a session a persona may *not*
 * read still shows its shape — which is exactly what `metrics` access means, made
 * legible instead of described.
 *
 * Chi calls its reduction levels `z`, for zoom. This zoom is a different axis — scale of
 * view, not level of reduction — and the two are kept separate deliberately: conflating
 * them would be a nice metaphor and a wrong one.
 */
import { useQuery } from '@tanstack/react-query'
import { Minus, Plus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { api } from '../api.ts'
import type { Detail } from '../api.ts'
import { CODE_KIND } from '../../lib/chi/kinds.ts'
import type { Kind } from '../../lib/chi/kinds.ts'
import { Card, DetailBadge, fmtCompact, fmtUsd, KIND_STYLE, KindLegend, Notice, Spinner } from '../ui.tsx'

type CorpusSession = {
  sessionId: string
  source: string
  title: string | null
  startedAt: string | null
  costUsd: number
  approxTokens: number
  detail: Detail
  canOpen: boolean
  marks: string
}

type CorpusResponse = {
  sessions: CorpusSession[]
  links: { originSessionId: string; childSessionId: string; specialistId: string | null }[]
  withheld: number
  totalEntries: number
}

const ROW_H = 16

/** One session as a run of marks. Hover is one handler per row, not per mark. */
function Strip({
  marks,
  markW,
  onPick,
  onHover,
}: {
  marks: string
  markW: number
  onPick: (index: number) => void
  onHover: (index: number | null) => void
}) {
  const ref = useRef<SVGSVGElement>(null)

  // Runs of the same kind collapse into one rect: 9,299 marks become ~4,000 rects, and
  // adjacent same-kind entries read as a block, which is the pattern worth seeing.
  const runs = useMemo(() => {
    const out: { start: number; len: number; kind: Kind }[] = []
    for (let i = 0; i < marks.length; i++) {
      const kind = CODE_KIND[marks[i]!] ?? 'event'
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.len++
      else out.push({ start: i, len: 1, kind })
    }
    return out
  }, [marks])

  function indexAt(clientX: number): number {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.min(marks.length - 1, Math.max(0, Math.floor((clientX - rect.left) / markW)))
  }

  return (
    <svg
      ref={ref}
      className="marks block cursor-pointer"
      width={Math.max(2, marks.length * markW)}
      height={ROW_H}
      onMouseMove={(e) => onHover(indexAt(e.clientX))}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => onPick(indexAt(e.clientX))}
    >
      {runs.map((run) => {
        const style = KIND_STYLE[run.kind]
        // Thinking and events sit lower and shorter — weight carries what a fourth hue
        // would have, keeping the identity palette at three and CVD-safe.
        const h = run.kind === 'thinking' ? ROW_H * 0.5 : run.kind === 'event' ? ROW_H * 0.3 : ROW_H
        return (
          <rect
            key={run.start}
            x={run.start * markW}
            y={ROW_H - h}
            width={Math.max(1, run.len * markW - (markW > 3 ? 1 : 0))}
            height={h}
            fill={style.fill}
            opacity={style.opacity}
            rx={markW > 5 ? 1.5 : 0}
          />
        )
      })}
    </svg>
  )
}

export function Corpus() {
  const navigate = useNavigate()
  const [markW, setMarkW] = useState(2)
  const [hover, setHover] = useState<{ session: CorpusSession; index: number } | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)

  const { data } = useQuery({ queryKey: ['corpus'], queryFn: () => api.get<CorpusResponse>('/api/corpus') })
  if (!data) return <Spinner label="Reading the corpus…" />

  const sources = [...new Set(data.sessions.map((s) => s.source))].sort()
  const shown = sourceFilter ? data.sessions.filter((s) => s.source === sourceFilter) : data.sessions

  const counts = shown.reduce<Partial<Record<Kind, number>>>((acc, session) => {
    for (const ch of session.marks) {
      const kind = CODE_KIND[ch] ?? 'event'
      acc[kind] = (acc[kind] ?? 0) + 1
    }
    return acc
  }, {})

  const longest = Math.max(1, ...shown.map((s) => s.marks.length))
  const days = new Set(shown.map((s) => s.startedAt?.slice(0, 10)).filter(Boolean)).size

  return (
    <div className="space-y-2">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2.5">
        <div>
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">The corpus</h1>
          <p className="mt-0.5 text-xs text-ink-2">
            {shown.length} sessions · {fmtCompact(shown.reduce((n, s) => n + s.marks.length, 0))}{' '}
            records · {sources.length} sources · {days} active days
          </p>
        </div>

        {/* Filters in one row above the marks. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-[2px] border border-line bg-surface px-1 py-0.5">
            <button
              type="button"
              onClick={() => setSourceFilter(null)}
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                sourceFilter === null ? 'bg-accent-wash text-accent' : 'text-ink-2 hover:text-ink'
              }`}
            >
              All
            </button>
            {sources.map((source) => (
              <button
                key={source}
                type="button"
                onClick={() => setSourceFilter(source)}
                className={`rounded px-2 py-1 text-[11px] font-medium ${
                  sourceFilter === source ? 'bg-accent-wash text-accent' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {source}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 rounded-[2px] border border-line bg-surface px-2 py-1">
            <button
              type="button"
              onClick={() => setMarkW((w) => Math.max(1, w - 1))}
              className="text-ink-2 hover:text-ink disabled:opacity-40"
              disabled={markW <= 1}
              aria-label="Zoom out"
            >
              <Minus className="size-3.5" />
            </button>
            <input
              type="range"
              min={1}
              max={14}
              value={markW}
              onChange={(e) => setMarkW(Number(e.target.value))}
              className="h-1 w-24 accent-[var(--color-accent)]"
              aria-label="Zoom"
            />
            <button
              type="button"
              onClick={() => setMarkW((w) => Math.min(14, w + 1))}
              className="text-ink-2 hover:text-ink disabled:opacity-40"
              disabled={markW >= 14}
              aria-label="Zoom in"
            >
              <Plus className="size-3.5" />
            </button>
            <span className="w-14 text-right text-[10px] tabular-nums text-ink-3">
              {markW === 1 ? '1px/rec' : `${markW}px/rec`}
            </span>
          </div>
        </div>
      </header>

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
          <KindLegend counts={counts} />
          <p className="ml-auto text-[11px] text-ink-3">
            {markW <= 2
              ? 'Zoom in to resolve individual records'
              : markW >= 9
                ? 'Each mark is one record — click to open it'
                : 'Click any mark to open that point in the session'}
          </p>
        </div>

        {/*
          Scrolls on BOTH axes, with a bounded height. `overflow-x-auto` alone was a trap:
          when one axis is not `visible`, CSS computes the other to `auto`, so the wrapper
          captured the mouse wheel, had no vertical overflow of its own, and the page
          silently would not scroll at all.
        */}
        <div className="scroll-thin max-h-[calc(100vh-12.5rem)] overflow-auto">
          <div className="min-w-full" style={{ width: Math.max(600, longest * markW) + 232 }}>
            {shown.map((session) => (
              <div
                key={session.sessionId}
                className="group flex items-center gap-3 border-b border-line/70 py-[3px] pr-4 last:border-0 hover:bg-plane"
              >
                <div className="sticky left-0 z-10 w-[13.5rem] shrink-0 bg-surface pl-3 pr-2 group-hover:bg-plane">
                  <div className="flex items-center gap-1.5">
                    {session.canOpen ? (
                      <Link
                        to={`/sessions/${session.sessionId}`}
                        className="truncate text-[11px] font-medium hover:text-accent hover:underline"
                        title={session.title ?? 'untitled'}
                      >
                        {session.title ?? <span className="text-ink-3">untitled</span>}
                      </Link>
                    ) : (
                      <span className="truncate text-[11px] text-ink-2" title="content withheld">
                        {session.title ?? 'untitled'}
                      </span>
                    )}
                    {!session.canOpen ? <DetailBadge detail={session.detail} /> : null}
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-3">
                    <span>{session.source}</span>
                    <span>·</span>
                    <span className="tabular-nums">{session.startedAt?.slice(5, 10) ?? '—'}</span>
                    <span>·</span>
                    <span className="tabular-nums">{session.marks.length}</span>
                  </div>
                </div>
                <Strip
                  marks={session.marks}
                  markW={markW}
                  onHover={(index) => setHover(index === null ? null : { session, index })}
                  onPick={(index) => {
                    if (session.canOpen) navigate(`/sessions/${session.sessionId}?seq=${index}`)
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* The hover layer: what is under the cursor, without a tooltip chasing the mouse
          across a 5,000px-wide strip. */}
      <div className="sticky bottom-3 z-20">
        <div className="rounded-[2px] border border-line bg-raised px-3 py-2 shadow-sm">
          {hover ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span
                className="size-2.5 rounded-sm"
                style={{
                  background: KIND_STYLE[CODE_KIND[hover.session.marks[hover.index]!] ?? 'event'].fill,
                  opacity: KIND_STYLE[CODE_KIND[hover.session.marks[hover.index]!] ?? 'event'].opacity,
                }}
              />
              <span className="font-medium">
                {KIND_STYLE[CODE_KIND[hover.session.marks[hover.index]!] ?? 'event'].label}
              </span>
              <span className="text-ink-3">record {hover.index}</span>
              <span className="text-ink-3">·</span>
              <span className="truncate">{hover.session.title ?? 'untitled'}</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-3">{hover.session.source}</span>
              <span className="ml-auto text-ink-3">
                {fmtUsd(hover.session.costUsd)} · {fmtCompact(hover.session.approxTokens)} tokens
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-ink-3">
              Hover a mark to inspect it. {data.withheld > 0 ? `${data.withheld} sessions withheld from this persona.` : ''}
            </p>
          )}
        </div>
      </div>

      {data.withheld > 0 ? (
        <Notice kind="warn">
          {data.withheld} session{data.withheld === 1 ? '' : 's'} are missing from this view
          entirely — withheld from this persona by grant, not filtered in the browser.
        </Notice>
      ) : null}
    </div>
  )
}
