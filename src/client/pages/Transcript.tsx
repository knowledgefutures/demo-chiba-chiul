/**
 * One session, read as a conversation.
 *
 * The previous version was a table of rows, which is what the data *is* and not what it
 * *means*. A session is a conversation with tool use and reasoning threaded through it, so
 * it reads as one: human on the left, model on the right, tool calls as compact cards, and
 * the runtime's own events — model changes, thinking-level changes, compactions, injected
 * rules — on a rail down the middle.
 *
 * The events matter. They are where a session's behaviour actually changed, and a
 * transcript that hides them makes the model look inconsistent for no visible reason.
 *
 * Every row opens to its full record, because the point of this whole exercise is that
 * nothing was lost: the raw v3 entry is one click away from its rendered form.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Code2, Lock, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import { ApiError, api } from '../api.ts'
import type { Detail, EntryView, SessionSummary } from '../api.ts'
import { classifyEntry, describeEntry, toolNameOf } from '../../lib/chi/kinds.ts'
import { Card, DetailBadge, fmtCompact, fmtUsd, KIND_STYLE, Notice, Spinner } from '../ui.tsx'

type DetailResponse = {
  session: SessionSummary
  detail: Detail
  availableZ: number[]
  readableZ: number[]
  links: { originSessionId: string; childSessionId: string; specialistId: string | null }[]
}

type EntriesResponse = { entries: EntryView[]; z: number; total: number; offset: number }

type Part = { type: string; text?: string; thinking?: string; arguments?: unknown; name?: string; toolName?: string }

function partsOf(entry: Record<string, unknown>): Part[] {
  const message = entry['message'] as Record<string, unknown> | undefined
  const content = message?.['content']
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Part[]) : []
}

function usageOf(entry: Record<string, unknown>) {
  const message = entry['message'] as Record<string, unknown> | undefined
  return message?.['usage'] as
    | { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } }
    | undefined
}

/**
 * A tool call or a tool result, collapsed.
 *
 * Both shapes get one component because they are two halves of the same event and should
 * look related: the model's `call` sits inside its own turn, and the `result` arrives as
 * the tool's turn. Collapsed by default — tool output is the bulk of a session by volume
 * and rarely the thing you came to read.
 */
function ToolLine({
  tool,
  body,
  variant,
}: {
  tool: string
  body: string
  variant: 'call' | 'result'
}) {
  const [open, setOpen] = useState(false)
  const omitted = body.includes('[omitted:') || body.includes('[redacted:')

  return (
    <div
      className={`rounded-[2px] border ${
        variant === 'call' ? 'border-tool/20 bg-tool-wash/50' : 'border-tool/25 bg-tool-wash'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Wrench className="size-3 shrink-0 text-tool" />
        <span className="shrink-0 font-mono text-[11px] font-medium text-tool">{tool}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-3">{variant}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
          {body.slice(0, 220) || '—'}
        </span>
        {omitted ? (
          <span className="shrink-0 rounded bg-warn/25 px-1 text-[9px] text-ink-2" title="tool output was pruned before upload">
            pruned
          </span>
        ) : null}
      </button>
      {open ? (
        <pre className="scroll-thin max-h-80 overflow-auto whitespace-pre-wrap border-t border-line/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
          {body}
        </pre>
      ) : null}
    </div>
  )
}

function EntryBlock({ entry: row, anchored }: { entry: EntryView; anchored: boolean }) {
  const [showRaw, setShowRaw] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const entry = row.entry
  const kind = classifyEntry(entry)
  const parts = partsOf(entry)
  const usage = usageOf(entry)

  useEffect(() => {
    if (anchored) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [anchored])

  const meta = (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-3">
      <span className="tabular-nums">#{row.seq}</span>
      {row.timestamp ? <span className="tabular-nums">{row.timestamp.slice(11, 19)}</span> : null}
      {row.model ? <span className="font-mono">{row.model}</span> : null}
      {usage?.cost?.total ? <span className="tabular-nums">{fmtUsd(usage.cost.total)}</span> : null}
      {usage?.cacheRead ? (
        <span className="tabular-nums" title="tokens served from cache">
          ↺ {fmtCompact(usage.cacheRead)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="flex items-center gap-1 hover:text-accent"
      >
        <Code2 className="size-3" />
        {showRaw ? 'hide record' : 'record'}
      </button>
    </div>
  )

  const raw = showRaw ? (
    <pre className="scroll-thin mt-1.5 max-h-96 overflow-auto rounded-[2px] border border-line bg-plane p-2 font-mono text-[10px] leading-relaxed">
      {JSON.stringify(entry, null, 2)}
    </pre>
  ) : null

  // Session events: a thin rail down the middle, not a bubble. They are the runtime
  // talking about itself, and they read as punctuation between turns.
  if (kind === 'event') {
    return (
      <div ref={ref} className={`flex justify-center py-1 ${anchored ? 'rounded bg-accent-wash' : ''}`}>
        <div className="w-full max-w-lg">
          <div className="flex items-center gap-2">
            <span className="h-px flex-1 bg-line" />
            <span className="whitespace-nowrap rounded-[2px] border border-line bg-plane px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
              {describeEntry(entry)}
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
          {showRaw ? raw : null}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="mt-0.5 text-[9px] text-ink-3 hover:text-accent"
            >
              #{row.seq}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const isHuman = kind === 'human'
  const align = isHuman ? 'items-start' : 'items-end'
  const bubble = isHuman
    ? 'bg-human-wash border-human/25'
    : kind === 'tool'
      ? ''
      : 'bg-surface border-line'

  return (
    <div ref={ref} className={`flex flex-col gap-0.5 py-1.5 ${align} ${anchored ? 'rounded bg-accent-wash/60' : ''}`}>
      {/*
        `w-full` matters: without it this flex child shrinks to fit its content, so every
        row got a different width and the column read as ragged rather than as a thread.
      */}
      <div
        className={`flex w-full max-w-[min(48rem,94%)] flex-col ${
          isHuman ? 'items-start' : 'items-end'
        }`}
      >
        <span className={`text-[10px] font-medium ${KIND_STYLE[kind].text}`}>
          {kind === 'human' ? 'Human' : kind === 'tool' ? 'Tool' : kind === 'thinking' ? 'Thinking' : 'Model'}
        </span>

        <div className="w-full space-y-1.5">
          {kind === 'tool' ? (
            <ToolLine
              tool={toolNameOf(entry) ?? 'tool'}
              body={parts.find((p) => typeof p.text === 'string')?.text ?? ''}
              variant="result"
            />
          ) : (
            /* Parts render in order, so a turn reads the way it happened: reasoning, then
               what the model said, then what it went off and did. */
            parts.map((part, i) => {
              if (part.type === 'thinking' && typeof part.thinking === 'string') {
                return (
                  <div
                    key={i}
                    className="rounded-[2px] border border-model/15 bg-model-wash/50 px-3 py-2 text-[12px] italic leading-relaxed text-ink-2"
                  >
                    {part.thinking}
                  </div>
                )
              }
              if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
                return (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap rounded-[2px] border px-3 py-2 text-[12.5px] leading-relaxed ${bubble}`}
                  >
                    {part.text}
                  </div>
                )
              }
              if (part.type === 'toolCall') {
                return (
                  <ToolLine
                    key={i}
                    tool={part.toolName ?? part.name ?? 'tool'}
                    body={JSON.stringify(part.arguments ?? {}, null, 2)}
                    variant="call"
                  />
                )
              }
              if (part.type === 'image') {
                return (
                  <div
                    key={i}
                    className="rounded-[2px] border border-line bg-plane px-3 py-2 text-[11px] text-ink-3"
                  >
                    image omitted
                  </div>
                )
              }
              return null
            })
          )}
        </div>

        {meta}
        {raw}
      </div>
    </div>
  )
}

export function Transcript() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [z, setZ] = useState(0)
  const anchorSeq = params.get('seq') ? Number(params.get('seq')) : null
  const [page, setPage] = useState(0)
  const PAGE = 200

  const detail = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.get<DetailResponse>(`/api/sessions/${id}`),
    retry: false,
  })

  // If arriving from the corpus map with ?seq=, open the page that contains it.
  useEffect(() => {
    if (anchorSeq !== null) setPage(Math.floor(anchorSeq / PAGE))
  }, [anchorSeq])

  const entries = useQuery({
    queryKey: ['session', id, 'entries', z, page],
    queryFn: () =>
      api.get<EntriesResponse>(`/api/sessions/${id}/entries?z=${z}&limit=${PAGE}&offset=${page * PAGE}`),
    enabled: detail.data !== undefined && detail.data.readableZ.includes(z),
    retry: false,
  })

  const pageCount = useMemo(
    () => (entries.data ? Math.ceil(entries.data.total / PAGE) : 1),
    [entries.data],
  )

  if (detail.error instanceof ApiError) {
    return (
      <div className="space-y-2">
        <Back />
        <Notice kind="warn">
          <strong>{detail.error.message}</strong>
          {typeof detail.error.body['hint'] === 'string' ? (
            <div className="mt-1">{detail.error.body['hint']}</div>
          ) : null}
        </Notice>
        <p className="text-[11px] text-ink-3">
          That refusal came from the server, not from the interface declining to draw. Switch
          persona in the sidebar to compare.
        </p>
      </div>
    )
  }

  if (!detail.data) return <Spinner label="Loading session…" />
  const { session, availableZ, readableZ, links } = detail.data

  return (
    <div className="space-y-2">
      <Back />

      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2.5">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">
            {session.title ?? <span className="text-ink-3">untitled session</span>}
          </h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-3">
            {session.sessionId}
            {session.repo ? ` · ${session.repo}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <Figure label="Records" value={String(session.entryCount)} />
          <Figure label="Tokens" value={fmtCompact(session.approxTokens)} />
          <Figure label="Spend" value={fmtUsd(session.costUsd)} />
          <Figure label="Source" value={session.source} />
        </div>
      </header>

      {session.cwd ? (
        <p className="rounded-[2px] border border-human/25 bg-human-wash px-3 py-1.5 font-mono text-[11px] text-ink-2">
          {session.cwd}
          <span className="ml-2 font-sans text-ink-3">
            — a <code>private: true</code> field, released because this persona&apos;s grant allows it
          </span>
        </p>
      ) : null}

      {links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-ink-3">Subagents:</span>
          {links.map((l) => {
            const other = l.originSessionId === session.sessionId ? l.childSessionId : l.originSessionId
            const spawned = l.originSessionId === session.sessionId
            return (
              <Link
                key={`${l.originSessionId}-${l.childSessionId}`}
                to={`/sessions/${other}`}
                className="rounded-[2px] border border-model/30 bg-model-wash px-1.5 py-0.5 font-mono text-[10px] text-model hover:underline"
                title={l.specialistId ?? undefined}
              >
                {spawned ? '↳' : '↰'} {other.slice(0, 8)}
              </Link>
            )
          })}
        </div>
      ) : null}

      <Card
        title="Reduction level"
        subtitle="z=0 is the raw records; z≥1 are reductions. Chi's address is (sessionId, strategy, z, range)."
      >
        <div className="flex flex-wrap items-center gap-2">
          {availableZ.map((level) => {
            const readable = readableZ.includes(level)
            return (
              <button
                key={level}
                type="button"
                disabled={!readable}
                onClick={() => setZ(level)}
                className={`flex items-center gap-1.5 rounded-[2px] border px-2.5 py-1 text-[11px] font-medium ${
                  z === level && readable
                    ? 'border-accent bg-accent-wash text-accent'
                    : readable
                      ? 'border-line hover:border-accent'
                      : 'cursor-not-allowed border-line bg-line/30 text-ink-3'
                }`}
                title={readable ? undefined : 'This persona’s grant does not reach this level'}
              >
                {!readable ? <Lock className="size-3" /> : null}z={level}
              </button>
            )
          })}
          <DetailBadge detail={detail.data.detail} />
          {availableZ.length === 1 && availableZ[0] === 0 ? (
            <p className="ml-2 text-[11px] text-ink-3">
              Only z=0 exists yet — generating real reductions costs model calls and is the next
              phase. The selector will show them when they exist rather than faking them.
            </p>
          ) : null}
        </div>
      </Card>

      {entries.error instanceof ApiError ? (
        <Notice kind="warn">{entries.error.message}</Notice>
      ) : entries.data ? (
        <>
          <div className="rounded-[3px] border border-line bg-surface px-4 py-2 sm:px-8">
            {entries.data.entries.map((entry) => (
              <EntryBlock
                key={entry.recordId}
                entry={entry}
                anchored={anchorSeq === entry.seq}
              />
            ))}
          </div>

          {pageCount > 1 ? (
            <div className="flex items-center justify-center gap-3 text-[11px]">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => {
                  setPage((p) => Math.max(0, p - 1))
                  setParams({})
                }}
                className="flex items-center gap-1 rounded-[2px] border border-line bg-surface px-2 py-1 disabled:opacity-40"
              >
                <ChevronLeft className="size-3" />
                Earlier
              </button>
              <span className="tabular-nums text-ink-2">
                records {page * PAGE + 1}–{Math.min((page + 1) * PAGE, entries.data.total)} of{' '}
                {entries.data.total}
              </span>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => {
                  setPage((p) => p + 1)
                  setParams({})
                }}
                className="flex items-center gap-1 rounded-[2px] border border-line bg-surface px-2 py-1 disabled:opacity-40"
              >
                Later
                <ChevronRight className="size-3" />
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <Spinner label="Loading records…" />
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="eyebrow">{label}</div>
      <div className="font-mono text-[12px] font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Back() {
  return (
    <Link
      to="/corpus"
      className="inline-flex items-center gap-1 text-[11px] text-ink-2 hover:text-accent"
    >
      <ChevronLeft className="size-3" />
      Back to the corpus
    </Link>
  )
}
