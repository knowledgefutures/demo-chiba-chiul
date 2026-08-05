/**
 * The shell: navigation, the team's org, and the account.
 *
 * "Viewing as" lives at the bottom as an account chip, because that is what it stands in
 * for. Opening it shows the whole roster with each persona's grants inline — the roster is
 * the demo, so it reads as an account switcher rather than a login.
 *
 * The roster is a **fixed-position popover**, not an inline block. Inline, it grew the
 * sidebar's scroll height and shoved the chip around as it opened; fixed also escapes the
 * sidebar's own `overflow-y-auto`, which would otherwise clip it.
 *
 * The `z-30` on the aside is load-bearing and non-obvious: `position: sticky` creates a
 * stacking context, so the popover's `z-50` only competes *inside* the sidebar. Without a
 * z-index on the aside itself, `<main>` paints later in DOM order and its own sticky
 * elements — the corpus page's session labels — bleed straight through the popover.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronsUpDown,
  ExternalLink,
  Layers,
  LayoutDashboard,
  ListTree,
  LogOut,
  Search as SearchIcon,
  UploadCloud,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'

import { api } from './api.ts'
import type { Detail, Me, PersonaSummary, WorkspaceState } from './api.ts'
import { DetailBadge } from './ui.tsx'

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, hint: 'Cost, models, tools' },
  { to: '/corpus', label: 'Corpus', icon: Layers, hint: '9,299 records' },
  { to: '/sessions', label: 'Sessions', icon: ListTree, hint: 'Browse and read' },
  { to: '/search', label: 'Search', icon: SearchIcon, hint: 'Full text' },
  // Named for the system it writes to, not for an abstraction ("Team") that said nothing
  // about what the page does. This is the Underlay side: collections in, versions out.
  { to: '/underlay', label: 'Underlay', icon: UploadCloud, hint: 'Collections & publishing' },
]

function initials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

function PersonaCard({
  persona,
  onChoose,
  busy,
}: {
  persona: PersonaSummary
  onChoose: (id: string) => void
  busy: boolean
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onChoose(persona.id)}
      className={`w-full rounded-[2px] border p-2 text-left transition ${
        persona.current
          ? 'border-shell-line bg-shell-raised'
          : 'border-transparent hover:border-shell-line hover:bg-shell-raised/60'
      } ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-[18px] shrink-0 place-items-center rounded-[2px] bg-shell-line font-mono text-[9px] font-semibold text-shell-ink">
          {initials(persona.label)}
        </span>
        <span className="truncate text-xs font-semibold text-shell-ink">{persona.label}</span>
        <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-shell-muted">
          {persona.kind}
        </span>
      </div>
      {persona.description ? (
        <p className="mt-1 text-[10px] leading-snug text-shell-muted">{persona.description}</p>
      ) : null}

      {/*
        One list, read top to bottom as "exceptions, then the default".

        This replaced two competing summaries: a single badge in the corner showing the
        persona's *most permissive* level, over a row of `everyone [shape only] User 1 [raw]`
        chips. The corner badge said "raw" while the row said "shape only", which read as a
        contradiction — they were the maximum and the default, and nothing labelled either.
        Specific grants come first because that is how a reader parses an exception, and the
        wildcard row is named "Everyone else" only when there is something for it to be else of.
      */}
      <dl className="mt-1.5 space-y-px border-t border-shell-line/60 pt-1.5">
        {scopeRows(persona).map((row) => (
          <div key={row.scope} className="flex items-baseline gap-2 text-[10px]">
            <dt className="min-w-0 flex-1 truncate text-shell-muted">
              {row.scope}
              {row.note ? <span className="text-shell-muted/60"> {row.note}</span> : null}
            </dt>
            {/* The marker sits before the badge so every badge aligns on the right edge —
                trailing it made rows with and without paths end at different x. */}
            <dd className="flex shrink-0 items-center justify-end gap-1">
              {row.seePrivate ? (
                <span
                  className="text-shell-muted/70"
                  title="including machine paths — the private: true fields"
                >
                  + paths
                </span>
              ) : null}
              <DetailBadge detail={row.detail} onDark />
            </dd>
          </div>
        ))}
      </dl>
    </button>
  )
}

/**
 * A persona's grants as ordered rows: every specific source first, then the fallback.
 *
 * The fallback is "Everyone" when it is the only rule and "Everyone else" when specific
 * sources precede it — which is the difference between a blanket policy and a default with
 * exceptions, and it is the whole thing this list has to communicate.
 */
function scopeRows(
  persona: PersonaSummary,
): { scope: string; note?: string; detail: Detail; seePrivate: boolean }[] {
  const specific = persona.grants.bySource.map((g) => ({
    scope: g.source,
    // Naming the persona's own source as theirs is what makes "raw" here read as
    // "their own sessions" rather than as a privilege over someone else's.
    ...(g.source === persona.sourceLabel ? { note: '(their own)' } : {}),
    detail: g.detail,
    seePrivate: g.seePrivate,
  }))

  return [
    ...specific,
    {
      scope: specific.length > 0 ? 'Everyone else' : 'Everyone',
      detail: persona.grants.wildcard.detail,
      seePrivate: persona.grants.wildcard.seePrivate,
    },
  ]
}

export function Sidebar() {
  const location = useLocation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me') })
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceState>('/api/workspace'),
  })

  const current = me.data?.personas.find((p) => p.current)

  // Escape closes it, like any other popover.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function choose(personaId: string) {
    setBusy(true)
    try {
      await api.post('/api/me/persona', { personaId })
      // Every response is persona-scoped server-side, so the whole cache is stale.
      await queryClient.invalidateQueries()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  async function lock() {
    await api.post('/api/gate/lock')
    await queryClient.invalidateQueries()
  }

  const orgUrl = workspace.data
    ? `${workspace.data.workspace.underlayUrl.replace(/\/+$/, '')}/${workspace.data.workspace.orgSlug}`
    : null

  return (
    <aside className="scroll-thin sticky top-0 z-30 flex h-screen w-[13.5rem] shrink-0 flex-col overflow-y-auto border-r border-shell-line bg-shell text-shell-ink">
      <div className="px-4 pb-3 pt-4">
        <Link to="/" className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold tracking-tight">chiul</span>
          <span className="text-[10px] uppercase tracking-widest text-shell-muted">demo</span>
        </Link>
        <p className="mt-1 text-[11px] leading-snug text-shell-muted">
          Chi sessions, published to Underlay
        </p>
      </div>

      <nav className="px-2">
        {NAV.map(({ to, label, icon: Icon, hint }) => {
          const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
          return (
            <Link
              key={to}
              to={to}
              className={`group flex items-center gap-2.5 rounded-[2px] px-2 py-[7px] transition ${
                active
                  ? 'bg-shell-raised shadow-[inset_2px_0_0_var(--color-human)]'
                  : 'hover:bg-shell-raised/60'
              }`}
            >
              <Icon className={`size-4 shrink-0 ${active ? 'text-shell-ink' : 'text-shell-muted'}`} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{label}</span>
                <span className="block truncate text-[10px] text-shell-muted">{hint}</span>
              </span>
            </Link>
          )
        })}
      </nav>

      {/* The org, linked out to Underlay so it is a place rather than a label. */}
      {workspace.data && orgUrl ? (
        <div className="mx-2 mt-4 rounded-[2px] border border-shell-line p-2">
          <a
            href={orgUrl}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-1.5"
          >
            <span className="truncate text-[11px] font-semibold group-hover:underline">
              {workspace.data.workspace.orgSlug}
            </span>
            <ExternalLink className="size-3 shrink-0 text-shell-muted" />
          </a>
          <dl className="mt-1.5 space-y-0.5 text-[10px] text-shell-muted">
            <div className="flex justify-between gap-2">
              <dt>sessions</dt>
              <dd className="font-mono tabular-nums text-shell-ink">{workspace.data.sessions}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>records</dt>
              <dd className="font-mono tabular-nums text-shell-ink">
                {workspace.data.entries.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>instance</dt>
              <dd className="truncate font-mono text-shell-ink" title={workspace.data.workspace.underlayUrl}>
                {new URL(workspace.data.workspace.underlayUrl).host}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="flex-1" />

      {/* Account. */}
      <div className="p-2">
        {/*
          Opens rather than toggles. The backdrop, Escape and picking a persona all close
          it, so a toggle here would only add a second way to close that fights the
          backdrop sitting on top of this button.
        */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex w-full items-center gap-2.5 rounded-[2px] border border-shell-line/60 px-2.5 py-2 text-left hover:bg-shell-raised"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-[2px] bg-human font-mono text-[10px] font-semibold text-white">
            {initials(current?.label ?? me.data?.persona.label ?? '?')}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {current?.label ?? me.data?.persona.label ?? '…'}
            </span>
            <span className="block truncate text-[10px] capitalize text-shell-muted">
              {current?.kind ?? ''}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-shell-muted" />
        </button>
      </div>

      {open && me.data ? (
        <>
          {/* Backdrop: click-away, and it keeps the popover from feeling attached to the page. */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-shell/20"
          />
          <div className="scroll-thin fixed bottom-16 left-2 z-50 max-h-[calc(100vh-6rem)] w-[19rem] space-y-1 overflow-y-auto rounded-[3px] border border-shell-line bg-shell p-1.5 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.5)]">
            <p className="eyebrow px-1.5 pb-1.5 pt-1">View the team as</p>
            {me.data.personas.map((persona) => (
              <PersonaCard key={persona.id} persona={persona} onChoose={choose} busy={busy} />
            ))}
            <p className="px-1.5 pb-1 pt-1 text-[10px] leading-snug text-shell-muted">
              Access is enforced on the server for whichever persona is selected — but the
              selection is a choice, not an identity. This is a demo.
            </p>
            <button
              type="button"
              onClick={lock}
              className="flex w-full items-center gap-2 rounded-[2px] px-2.5 py-2 text-[11px] text-shell-muted hover:bg-shell-raised hover:text-shell-ink"
            >
              <LogOut className="size-3.5" />
              Lock this demo
            </button>
          </div>
        </>
      ) : null}
    </aside>
  )
}
