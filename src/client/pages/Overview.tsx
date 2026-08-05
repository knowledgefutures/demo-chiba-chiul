/**
 * The dashboard.
 *
 * Information hierarchy: one hero figure, then four supporting numbers, then the charts.
 * Every chart here plots a single measure, so none of them needs a categorical palette —
 * the row labels carry identity and the bars carry magnitude. The one place that would
 * have needed four series (sessions per day, split by source) is small multiples instead,
 * which is both more readable and sidesteps a four-hue palette that would not clear the
 * all-pairs CVD floor.
 *
 * What is withheld from the current persona is always named, never silently dropped.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Database, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'

import { api } from '../api.ts'
import type { Stats, WorkspaceState } from '../api.ts'
import { IngestPanel } from '../IngestPanel.tsx'
import { Bars, Button, Card, fmtCompact, fmtUsd, Notice, PageHeader, Spinner, Stat } from '../ui.tsx'

function aggregate<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => number,
): { label: string; value: number }[] {
  const acc = new Map<string, number>()
  for (const row of rows) acc.set(key(row), (acc.get(key(row)) ?? 0) + value(row))
  return [...acc].sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: v }))
}

/**
 * One source's sessions per day. A single series, so no legend and no palette.
 *
 * Flex columns rather than an SVG viewBox: a small viewBox with
 * `preserveAspectRatio="none"` stretches horizontally to fill the container, which turned
 * 3px bars into 26px blocks and read as a bar chart of four things instead of sixteen.
 * Flex gives every day an equal share of whatever width it gets, at any size.
 */
function Sparkline({
  days,
  rows,
  max,
  tone,
}: {
  days: string[]
  rows: { day: string; sessions: number }[]
  max: number
  tone: string
}) {
  const byDay = new Map(rows.map((r) => [r.day, r.sessions]))
  return (
    <div className="flex h-6 items-end gap-px" role="img" aria-label={`Sessions per day`}>
      {days.map((day) => {
        const v = byDay.get(day) ?? 0
        return (
          <span
            key={day}
            className="flex-1 rounded-t-[2px]"
            style={{
              height: v === 0 ? 1 : `${Math.max(8, (v / max) * 100)}%`,
              background: v === 0 ? 'var(--color-line)' : tone,
            }}
            title={`${day} — ${v} session${v === 1 ? '' : 's'}`}
          />
        )
      })}
    </div>
  )
}

function HydrateCard({ state }: { state: WorkspaceState }) {
  const queryClient = useQueryClient()
  const hydrate = useMutation({
    mutationFn: () => api.post('/api/workspace/hydrate'),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  return (
    <Card title="Nothing hydrated yet">
      <p className="text-[11px] leading-relaxed text-ink-2">
        This workspace reads from the <code className="font-mono">{state.workspace.orgSlug}</code> org
        on <code className="font-mono">{new URL(state.workspace.underlayUrl).host}</code>. It pulls
        the collections through the ordinary paged read API — the same one any other consumer would
        use — so what you see here is a working copy of what was published, not a second read of the
        source files.
      </p>
      <div className="mt-3">
        <Button variant="primary" onClick={() => hydrate.mutate()} disabled={hydrate.isPending}>
          {hydrate.isPending ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : (
            <Database className="size-3.5" />
          )}
          {hydrate.isPending ? 'Reading ~9,400 records…' : 'Hydrate from Underlay'}
        </Button>
      </div>
    </Card>
  )
}

export function Overview() {
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceState>('/api/workspace'),
  })
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats') })

  if (workspace.data && workspace.data.sessions === 0) return <HydrateCard state={workspace.data} />
  if (!stats.data) return <Spinner label="Loading…" />

  const s = stats.data
  const cache = s.cacheTokens.reduce(
    (acc, r) => ({
      input: acc.input + r.input,
      cacheRead: acc.cacheRead + r.cacheRead,
      output: acc.output + r.output,
    }),
    { input: 0, cacheRead: 0, output: 0 },
  )
  const ratio = cache.input > 0 ? cache.cacheRead / cache.input : 0
  const days = [...new Set(s.byDay.map((d) => d.day))].sort()
  // One scale across every source. Per-row maxima would make 1 session and 9 sessions
  // draw the same height, which is the classic small-multiples mistake.
  const dayMax = Math.max(1, ...s.byDay.map((d) => d.sessions))

  return (
    <div className="space-y-2">
      <PageHeader
        title={`${s.totals.sessions} sessions of real agent work`}
        subtitle={`Recorded across ${s.bySource.length} sources over ${days.length} days, published as content-addressed Underlay collections.`}
        action={
          <Link
            to="/corpus"
            className="inline-flex items-center gap-1.5 rounded-[2px] border border-line bg-surface px-2 py-[5px] text-[11px] font-medium hover:border-rule hover:bg-plane"
          >
            See every record at once
            <ArrowRight className="size-3.5" />
          </Link>
        }
      />

      {s.withheldSources.length > 0 ? (
        <Notice kind="warn">
          These figures exclude {s.withheldSources.join(', ')} — withheld from this persona by
          grant. Every number below is a partial picture, deliberately.
        </Notice>
      ) : null}

      {/* One hero figure, then the supporting cast. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Recorded model spend"
          value={fmtUsd(s.totals.costUsd)}
          hint="itemised per assistant message"
          tone="model"
        />
        <Stat label="Records" value={fmtCompact(s.totals.entries)} hint="Pi v3 entries" tone="human" />
        <Stat
          label="Tool invocations"
          value={fmtCompact(s.byTool.reduce((n, r) => n + r.calls, 0))}
          hint="from the published Metrics records"
          tone="tool"
        />
        <Stat
          label="Cache leverage"
          value={`${ratio.toFixed(0)}×`}
          hint={`${fmtCompact(cache.cacheRead)} cached vs ${fmtCompact(cache.input)} fresh`}
        />
      </div>

      <IngestPanel />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card
          title="When the work happened"
          subtitle={`Sessions per day, shared scale · peak ${dayMax} in one day`}
        >
          <div className="space-y-1.5">
            {s.bySource.map((source) => (
              <div key={source.source}>
                <div className="mb-1 flex items-baseline justify-between text-[11px]">
                  <span className="font-medium">{source.source}</span>
                  <span className="font-mono tabular-nums text-ink-3">
                    {source.sessions} sessions · {fmtUsd(source.costUsd)}
                  </span>
                </div>
                <Sparkline
                  days={days}
                  rows={s.byDay.filter((d) => d.source === source.source)}
                  max={dayMax}
                  tone="var(--color-human)"
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-snug text-ink-3">
            A source is a recording machine, not a person: one root is a shared environment, and 29
            of the 65 sessions carry no working directory at all.
          </p>
        </Card>

        <Card title="Tool mix" subtitle="What the agents actually spent their calls on">
          <Bars
            rows={aggregate(s.byTool, (r) => r.toolName, (r) => r.calls).slice(0, 11)}
            tone="var(--color-tool)"
          />
        </Card>

        <Card title="Models" subtitle="Assistant messages by the model that produced them">
          <Bars
            rows={aggregate(s.byModel, (r) => r.model, (r) => r.entries)}
            format={(n) => `${n.toLocaleString()}`}
            tone="var(--color-model)"
          />
        </Card>

        <Card title="By source" subtitle="Sessions, records and spend per machine">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="pb-1.5 font-medium">Source</th>
                <th className="pb-1.5 text-right font-medium">Sessions</th>
                <th className="pb-1.5 text-right font-medium">Records</th>
                <th className="pb-1.5 text-right font-medium">Tokens</th>
                <th className="pb-1.5 text-right font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {s.bySource.map((row) => (
                <tr key={row.source} className="border-b border-line/50 last:border-0">
                  <td className="py-1.5">{row.source}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.sessions}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.entries.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtCompact(row.tokens)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  )
}
