/**
 * The session list, and the clearest place the access model shows.
 *
 * A row a persona may not open still appears with its grant level and the reason, because
 * "you can see that 20 sessions exist and not what is in them" is a real and useful state.
 * Sessions withheld entirely are counted, not listed — and the count is stated.
 */
import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { Link } from 'react-router'

import { api } from '../api.ts'
import type { SessionSummary, Visibility } from '../api.ts'
import { Card, DetailBadge, fmtCompact, fmtUsd, Notice, Spinner } from '../ui.tsx'

type Response = { sessions: SessionSummary[]; visibility: Visibility }

export function Sessions() {
  const { data } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<Response>('/api/sessions'),
  })

  if (!data) return <Spinner label="Loading sessions…" />
  const { sessions, visibility } = data

  return (
    <div className="space-y-2">
      <Card
        title={`${visibility.visible} of ${visibility.total} sessions`}
        subtitle={`As ${visibility.persona}`}
      >
        <ul className="space-y-1.5">
          {visibility.bySource.map((row) => (
            <li key={row.source} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-28 shrink-0 font-medium">{row.source}</span>
              <span className="text-ink-3 tabular-nums">{row.sessions}</span>
              <DetailBadge detail={row.detail} />
              <span className="text-ink-3">{row.explanation}</span>
            </li>
          ))}
        </ul>
        {visibility.withheld > 0 ? (
          <Notice kind="warn">
            {visibility.withheld} session{visibility.withheld === 1 ? '' : 's'} withheld from this
            persona entirely — not sent to the browser, not hidden in it.
          </Notice>
        ) : null}
      </Card>

      <div className="overflow-x-auto rounded-[2px] border border-line bg-raised">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-3 py-2 font-medium">Session</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 text-right font-medium">Records</th>
              <th className="px-3 py-2 text-right font-medium">Tokens</th>
              <th className="px-3 py-2 text-right font-medium">Spend</th>
              <th className="px-3 py-2 font-medium">Access</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId} className="border-b border-line/60 last:border-0">
                <td className="max-w-md px-3 py-2">
                  {s.canOpen ? (
                    <Link
                      to={`/sessions/${s.sessionId}`}
                      className="font-medium hover:text-accent hover:underline"
                    >
                      {s.title ?? <span className="text-ink-3">untitled</span>}
                    </Link>
                  ) : (
                    <span className="flex items-center gap-1.5 text-ink-3">
                      <Lock className="size-3" />
                      {s.title ?? 'content withheld'}
                    </span>
                  )}
                  {s.cwd ? (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">
                      {s.cwd}
                    </div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{s.source}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-ink-3">
                  {s.startedAt?.slice(0, 10) ?? '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{s.entryCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(s.approxTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(s.costUsd)}</td>
                <td className="px-3 py-2">
                  <DetailBadge detail={s.detail} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-snug text-ink-3">
        Machine paths appear only where the persona&apos;s grant allows private fields. They are
        marked <code className="font-mono">private: true</code> in the published schema, so the
        collection and this surface agree on what private means.
      </p>
    </div>
  )
}
