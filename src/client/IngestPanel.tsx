/**
 * The write side, on the Overview page.
 *
 * This is the thing chiul actually *is*, so it sits on the first screen: point Chi at an
 * endpoint, writes land immediately, and Underlay receives one version per interval instead
 * of one per turn. Underlay versions are commits — a manifest plus a version hash — which
 * suits batches and not per-turn appends, and this is the buffer that makes that difference
 * disappear for the writer.
 *
 * Everything here is wired. The token is real and hashed at rest, the endpoint accepts real
 * Pi v3 entries, the buffer count is the Durable Object's actual row count, and Flush now
 * performs a real push. Nothing on this panel is a mock-up, because a token that did
 * nothing would be worse than no panel at all.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clock, Copy, KeyRound, Upload, X } from 'lucide-react'
import { useState } from 'react'

import { ApiError, api } from './api.ts'
import { Button, Card, Notice } from './ui.tsx'

type IngestStatus = {
  endpoint: string
  flushIntervalMinutes: number
  autoFlush: boolean
  lastFlushAt: number | null
  buffer: { pending: number; sessions: { sessionId: string; entries: number; oldest: string | null }[] }
  tokens: {
    id: string
    label: string
    prefix: string
    writes: number
    createdAt: number
    lastUsedAt: number | null
    revoked: boolean
  }[]
  canManage: boolean
  persona: string
}

const INTERVALS = [1, 5, 15, 60]

function Copyable({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      className={`group inline-flex max-w-full items-center gap-1.5 rounded-[2px] border border-line bg-plane px-1.5 py-1 font-mono text-[11px] hover:border-rule ${className}`}
      title="Copy"
    >
      <span className="truncate">{text}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-good" />
      ) : (
        <Copy className="size-3 shrink-0 text-ink-3 group-hover:text-ink-2" />
      )}
    </button>
  )
}

export function IngestPanel() {
  const queryClient = useQueryClient()
  const [minted, setMinted] = useState<{ token: string; label: string } | null>(null)
  const [label, setLabel] = useState('')

  const { data } = useQuery({
    queryKey: ['ingest'],
    queryFn: () => api.get<IngestStatus>('/api/ingest/status'),
    // The buffer count is live state; poll it slowly so the panel is honest without
    // hammering the object.
    refetchInterval: 10_000,
  })

  const mint = useMutation({
    mutationFn: (l: string) => api.post<{ token: string; label: string }>('/api/ingest/tokens', { label: l }),
    onSuccess: async (r) => {
      setMinted(r)
      setLabel('')
      await queryClient.invalidateQueries({ queryKey: ['ingest'] })
    },
  })

  const policy = useMutation({
    mutationFn: (body: { flushIntervalMinutes?: number; autoFlush?: boolean }) =>
      api.post('/api/ingest/policy', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ingest'] }),
  })

  const flush = useMutation({
    mutationFn: () => api.post<{ uploaded: number }>('/api/ingest/flush'),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  if (!data) return null

  const active = data.tokens.filter((t) => !t.revoked)

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Upload className="size-3.5 text-tool" />
          Write logs here, not to Underlay
        </span>
      }
      subtitle="Sessions write at app latency; Underlay gets one version per interval, not one per turn"
      action={
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] tabular-nums text-ink-3">
            {data.buffer.pending} buffered
          </span>
          <Button
            onClick={() => flush.mutate()}
            disabled={!data.canManage || flush.isPending || data.buffer.pending === 0}
          >
            <Upload className={`size-3.5 ${flush.isPending ? 'animate-pulse' : ''}`} />
            Flush now
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_15rem]">
        <div className="space-y-2">
          <div>
            <p className="eyebrow mb-1">Endpoint</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-[2px] border border-tool/30 bg-tool-wash px-1.5 py-1 font-mono text-[11px] text-tool">
                POST
              </span>
              <Copyable text={data.endpoint} className="min-w-0 flex-1" />
            </div>
            <pre className="scroll-thin mt-1.5 overflow-x-auto rounded-[2px] border border-line bg-plane p-2 font-mono text-[10px] leading-relaxed text-ink-2">
{`curl -X POST ${data.endpoint} \\
  -H "authorization: Bearer $CHIUL_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"sessionId":"019f…","entries":[{"entry":{"type":"message","id":"a1",…}}]}'`}
            </pre>
            <p className="mt-1 text-[10px] leading-snug text-ink-3">
              Portable Pi v3 entries, in file order. Idempotent by{' '}
              <code className="font-mono">sessionId:entryId</code>, so a replay after a reconnect
              adds nothing — which matters because Chi&apos;s duplicates come from replication, not
              concurrency.
            </p>
          </div>

          <div>
            <p className="eyebrow mb-1">Write tokens</p>
            {minted ? (
              <div className="mb-1.5 rounded-[2px] border border-good/40 bg-good-wash p-2">
                <div className="flex items-center gap-1.5">
                  <KeyRound className="size-3 shrink-0 text-good" />
                  <span className="text-[11px] font-medium">{minted.label}</span>
                  <button
                    type="button"
                    onClick={() => setMinted(null)}
                    className="ml-auto text-ink-3 hover:text-ink"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                <Copyable text={minted.token} className="mt-1.5 w-full" />
                <p className="mt-1 text-[10px] leading-snug text-ink-2">
                  Copy it now. Only the hash is stored, so this is the one and only time it can be
                  shown.
                </p>
              </div>
            ) : null}

            {active.length > 0 ? (
              <ul className="mb-1.5 space-y-1">
                {active.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-ink-3">{t.prefix}…</span>
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    <span className="font-mono tabular-nums text-ink-3">{t.writes} writes</span>
                    {data.canManage ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.post(`/api/ingest/tokens/${t.id}/revoke`)
                          await queryClient.invalidateQueries({ queryKey: ['ingest'] })
                        }}
                        className="text-ink-3 hover:text-critical"
                        title="Revoke"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {data.canManage ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (label.trim()) mint.mutate(label.trim())
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label, e.g. grisha-laptop"
                  className="min-w-0 flex-1 rounded-[2px] border border-line bg-surface px-2 py-[5px] text-[11px] outline-none focus:border-accent"
                />
                <Button type="submit" disabled={!label.trim() || mint.isPending}>
                  <KeyRound className="size-3.5" />
                  Generate
                </Button>
              </form>
            ) : (
              <p className="text-[10px] text-ink-3">
                {data.persona} may not mint a write token — it could append to any collection this
                workspace publishes.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2 lg:border-l lg:border-line lg:pl-3">
          <div>
            <p className="eyebrow mb-1">Commit interval</p>
            <div className="flex flex-wrap gap-1">
              {INTERVALS.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={!data.canManage}
                  onClick={() => policy.mutate({ flushIntervalMinutes: m })}
                  className={`rounded-[2px] border px-1.5 py-[3px] font-mono text-[11px] disabled:opacity-50 ${
                    data.flushIntervalMinutes === m
                      ? 'border-accent bg-accent-wash text-accent'
                      : 'border-line hover:border-rule'
                  }`}
                >
                  {m}m
                </button>
              ))}
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={data.autoFlush}
                disabled={!data.canManage}
                onChange={(e) => policy.mutate({ autoFlush: e.target.checked })}
                className="accent-[var(--color-accent)]"
              />
              Commit automatically
            </label>
            <p className="mt-1 flex items-start gap-1 text-[10px] leading-snug text-ink-3">
              <Clock className="mt-px size-3 shrink-0" />
              {data.lastFlushAt
                ? `Last commit ${new Date(data.lastFlushAt).toISOString().slice(0, 16).replace('T', ' ')}`
                : 'No commit yet'}
            </p>
          </div>

          {data.buffer.sessions.length > 0 ? (
            <div>
              <p className="eyebrow mb-1">Buffered</p>
              <ul className="space-y-0.5">
                {data.buffer.sessions.slice(0, 6).map((s) => (
                  <li key={s.sessionId} className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="truncate text-ink-2">{s.sessionId.slice(0, 8)}</span>
                    <span className="ml-auto tabular-nums text-ink-3">{s.entries}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[10px] leading-snug text-ink-3">
              The buffer is empty. Records written here are held until the next commit, then pushed
              — and because records are content-addressed, a commit uploads only what is new.
            </p>
          )}
        </div>
      </div>

      {flush.data ? (
        <div className="mt-2">
          <Notice>
            Committed. {flush.data.uploaded === 0
              ? 'Nothing uploaded — every record was already stored by content hash.'
              : `${flush.data.uploaded.toLocaleString()} records uploaded.`}
          </Notice>
        </div>
      ) : null}
      {flush.error instanceof ApiError ? (
        <div className="mt-2">
          <Notice kind="warn">{flush.error.message}</Notice>
        </div>
      ) : null}
      {mint.error instanceof ApiError ? (
        <div className="mt-2">
          <Notice kind="warn">{mint.error.message}</Notice>
        </div>
      ) : null}
    </Card>
  )
}
