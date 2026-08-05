/**
 * Full-text search with facets.
 *
 * The previous version returned a flat list and, for the default persona, nothing at all —
 * which looked broken and was actually the access model working. Two fixes: the demo now
 * opens as a persona that can read, and this page always states what it is searching and
 * why a result set is the size it is.
 *
 * Facet counts are computed over the whole match set rather than the current page, so a
 * filter tells you how much it would find before you click it.
 *
 * Gated at `full`, not `reduced`: a snippet is raw session text, so letting a
 * summaries-only persona search raw records would route around their own grant.
 */
import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, Search as SearchIcon, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { api } from '../api.ts'
import type { Detail } from '../api.ts'
import type { Kind } from '../../lib/chi/kinds.ts'
import { useDebounced } from '../useDebounced.ts'
import { Card, DetailBadge, KIND_STYLE, Notice, Spinner } from '../ui.tsx'

type Hit = {
  recordId: string
  sessionId: string
  sessionTitle: string | null
  source: string
  seq: number
  kind: string
  toolName: string | null
  timestamp: string | null
  snippet: string
}

type Response = {
  query: string
  results: Hit[]
  total: number
  facets: {
    kinds: { value: string; count: number }[]
    tools: { value: string; count: number }[]
    sessions: { value: string; title: string | null; source: string; count: number }[]
  }
  searchableSources: string[]
  detailBySource: { source: string; detail: Detail }[]
  withheldHits: number
}

/** Terms that actually return something in this corpus — searching should not be a guess. */
const SUGGESTED = ['federation', 'underlay', 'gitleaks', 'reduction', 'provenance', 'compaction']

/** The server wraps matches in ⟦…⟧ so highlighting needs no HTML from the server. */
function Snippet({ text }: { text: string }) {
  return (
    <p className="text-[12px] leading-relaxed">
      {text.split(/(⟦[^⟧]*⟧)/g).map((chunk, i) =>
        chunk.startsWith('⟦') ? (
          <mark key={i} className="rounded bg-warn/30 px-0.5 text-ink">
            {chunk.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{chunk}</span>
        ),
      )}
    </p>
  )
}

function FacetRow({
  label,
  value,
  count,
  active,
  onToggle,
  swatch,
}: {
  label: string
  value: string
  count: number
  active: boolean
  onToggle: (value: string | null) => void
  swatch?: { fill: string; opacity: number }
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(active ? null : value)}
      className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] ${
        active ? 'bg-accent-wash text-accent' : 'hover:bg-plane'
      }`}
    >
      {swatch ? (
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ background: swatch.fill, opacity: swatch.opacity }}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-ink-3">{count.toLocaleString()}</span>
      {active ? <X className="size-3 shrink-0" /> : null}
    </button>
  )
}

export function Search() {
  const [raw, setRaw] = useState('')
  const query = useDebounced(raw, 250)
  const [kind, setKind] = useState<string | null>(null)
  const [tool, setTool] = useState<string | null>(null)
  const [session, setSession] = useState<string | null>(null)

  const params = new URLSearchParams({ q: query })
  if (kind) params.set('kind', kind)
  if (tool) params.set('tool', tool)
  if (session) params.set('session', session)

  const { data, isFetching } = useQuery({
    queryKey: ['search', query, kind, tool, session],
    queryFn: () => api.get<Response>(`/api/stats/search?${params}`),
    enabled: query.trim().length >= 2,
  })

  const hasFilters = kind !== null || tool !== null || session !== null

  return (
    <div className="space-y-2">
      <header className="border-b border-line pb-2.5">
        <h1 className="text-[15px] font-semibold leading-tight tracking-tight">Search</h1>
        <p className="mt-1 text-[11px] text-ink-2">
          Full text across every record this persona may read raw.
        </p>
      </header>

      <label className="flex items-center gap-2.5 rounded-[3px] border border-line bg-surface px-3.5 py-2.5 focus-within:border-accent">
        <SearchIcon className="size-4 shrink-0 text-ink-3" />
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Search 9,299 records…"
          autoFocus
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
        />
        {isFetching ? <Spinner /> : null}
        {raw ? (
          <button type="button" onClick={() => setRaw('')} className="text-ink-3 hover:text-ink">
            <X className="size-4" />
          </button>
        ) : null}
      </label>

      {query.trim().length < 2 ? (
        <Card title="Try one of these" subtitle="Terms that return something in this corpus">
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => setRaw(term)}
                className="flex items-center gap-1.5 rounded-[2px] border border-line px-2.5 py-1 text-[11px] hover:border-accent hover:text-accent"
              >
                {term}
                <CornerDownLeft className="size-3 text-ink-3" />
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {data ? (
        <div className="grid gap-3 lg:grid-cols-[13.5rem_1fr]">
          <div className="space-y-2">
            <Card title={`${data.total.toLocaleString()} matches`} subtitle={hasFilters ? 'filtered' : undefined}>
              {hasFilters ? (
                <button
                  type="button"
                  onClick={() => {
                    setKind(null)
                    setTool(null)
                    setSession(null)
                  }}
                  className="mb-2 flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  <X className="size-3" />
                  Clear filters
                </button>
              ) : null}

              {data.facets.kinds.length > 0 ? (
                <>
                  <p className="mb-1 text-[10px] uppercase tracking-widest text-ink-3">Kind</p>
                  {data.facets.kinds.map((f) => {
                    const style = KIND_STYLE[f.value as Kind] ?? KIND_STYLE.event
                    return (
                      <FacetRow
                        key={f.value}
                        label={style.label}
                        value={f.value}
                        count={f.count}
                        active={kind === f.value}
                        onToggle={setKind}
                        swatch={{ fill: style.fill, opacity: style.opacity }}
                      />
                    )
                  })}
                </>
              ) : null}

              {data.facets.tools.length > 0 ? (
                <>
                  <p className="mb-1 mt-3 text-[10px] uppercase tracking-widest text-ink-3">Tool</p>
                  {data.facets.tools.map((f) => (
                    <FacetRow
                      key={f.value}
                      label={f.value}
                      value={f.value}
                      count={f.count}
                      active={tool === f.value}
                      onToggle={setTool}
                    />
                  ))}
                </>
              ) : null}

              {data.facets.sessions.length > 0 ? (
                <>
                  <p className="mb-1 mt-3 text-[10px] uppercase tracking-widest text-ink-3">
                    Session
                  </p>
                  {data.facets.sessions.slice(0, 8).map((f) => (
                    <FacetRow
                      key={f.value}
                      label={f.title ?? f.value.slice(0, 8)}
                      value={f.value}
                      count={f.count}
                      active={session === f.value}
                      onToggle={setSession}
                    />
                  ))}
                </>
              ) : null}
            </Card>

            <Card title="What is searchable" subtitle="Search reads raw records">
              <ul className="space-y-1">
                {data.detailBySource.map((row) => (
                  <li key={row.source} className="flex items-center gap-1.5 text-[11px]">
                    <span className="min-w-0 flex-1 truncate">{row.source}</span>
                    <DetailBadge detail={row.detail} />
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="space-y-2">
            {data.searchableSources.length === 0 ? (
              <Notice kind="warn">
                This persona has no raw-record access to any source, so search returns nothing.
                That is the grant working, not an empty index — switch persona in the sidebar to
                compare.
              </Notice>
            ) : null}
            {data.withheldHits > 0 ? (
              <Notice kind="warn">
                {data.withheldHits} matching record{data.withheldHits === 1 ? '' : 's'} were dropped
                before reaching the browser, from sources this persona may not read raw.
              </Notice>
            ) : null}

            {data.results.length === 0 && data.searchableSources.length > 0 ? (
              <Card>
                <p className="py-6 text-center text-xs text-ink-3">No matches for “{data.query}”.</p>
              </Card>
            ) : (
              <ul className="space-y-2">
                {data.results.map((hit) => {
                  const style = KIND_STYLE[hit.kind as Kind] ?? KIND_STYLE.event
                  return (
                    <li key={hit.recordId} className="rounded-[3px] border border-line bg-surface p-3">
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-3">
                        <span
                          className="size-2 rounded-sm"
                          style={{ background: style.fill, opacity: style.opacity }}
                        />
                        <span className={style.text}>{style.label}</span>
                        {hit.toolName ? <span className="font-mono">{hit.toolName}</span> : null}
                        <Link
                          to={`/sessions/${hit.sessionId}?seq=${hit.seq}`}
                          className="truncate font-medium text-ink hover:text-accent hover:underline"
                        >
                          {hit.sessionTitle ?? hit.sessionId.slice(0, 8)}
                        </Link>
                        <span>·</span>
                        <span>{hit.source}</span>
                        <span>·</span>
                        <span className="tabular-nums">#{hit.seq}</span>
                        {hit.timestamp ? (
                          <span className="tabular-nums">{hit.timestamp.slice(0, 10)}</span>
                        ) : null}
                      </div>
                      <Snippet text={hit.snippet} />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
