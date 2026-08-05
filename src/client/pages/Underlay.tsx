/**
 * The Underlay side: the org, its collections, and publishing.
 *
 * Called "Underlay" rather than "Team" because that is what it is — the page where this
 * workspace writes to and reads from a specific Underlay org. "Team" named an abstraction
 * and said nothing about what the page does.
 *
 * Provisioning here is a real push through the negotiate protocol, not a mock — which is
 * why the headline result is `0 uploaded`. A collection is the unit of access control,
 * versioning and identity; it is not a storage bucket. Records live once, globally,
 * keyed by hash. So publishing the same 65 sessions under a second layout costs one
 * manifest and no record bytes, and you can watch that happen.
 *
 * The button is gated on a persona with full read access, because provisioning copies
 * every source's records into a new collection. A persona that cannot read a source must
 * not be able to launder it into one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Key, Layers, RefreshCw, Users } from 'lucide-react'
import { useState } from 'react'

import { ApiError, api } from '../api.ts'
import { Button, Card, fmtCompact, Notice, Spinner } from '../ui.tsx'

type TeamState = {
  org: { slug: string; underlayUrl: string; hasKey: boolean }
  collections: {
    slug: string
    layout: string
    version: string | null
    ark: string | null
    recordCount: number
    isPrimary: boolean
  }[]
  upstream: { slug: string; recordCount: number; latestVersion: string | null; public: boolean }[]
  upstreamError: string | null
  commits: {
    slug: string
    semver: string | null
    uploaded: number
    outcome: string
    detail: string | null
    at: number
  }[]
  canManage: boolean
  persona: string
}

type ProvisionResult = {
  layout: string
  results: {
    slug: string
    semver: string
    records: number
    uploaded: number
    unchanged?: boolean
    error?: string
  }[]
  totalUploaded: number
  totalRecords: number
  allUnchanged: boolean
}

const LAYOUTS = [
  {
    id: 'person' as const,
    icon: Users,
    title: 'One collection per person',
    body: 'One collection per source. This is the unit access is granted and revoked on.',
  },
  {
    id: 'repo' as const,
    icon: Layers,
    title: 'One collection per repo',
    body: 'Every session for a repo in one collection. Same records as above, so publishing both costs one extra manifest.',
  },
]

export function UnderlayPage() {
  const queryClient = useQueryClient()
  const [last, setLast] = useState<ProvisionResult | null>(null)

  const { data } = useQuery({ queryKey: ['team'], queryFn: () => api.get<TeamState>('/api/team') })

  const provision = useMutation({
    mutationFn: (layout: 'person' | 'repo') =>
      api.post<ProvisionResult>('/api/team/provision', { layout }),
    onSuccess: async (result) => {
      setLast(result)
      await queryClient.invalidateQueries({ queryKey: ['team'] })
    },
  })

  if (!data) return <Spinner label="Loading the org…" />

  const base = data.org.underlayUrl.replace(/\/+$/, '')
  const orgUrl = `${base}/${data.org.slug}`

  return (
    <div className="space-y-2">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2.5">
        <div>
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">Underlay</h1>
          <p className="mt-1 text-[11px] text-ink-2">
            Collections in this org, and how sessions are grouped into them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={orgUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-[2px] border border-line bg-surface px-2.5 py-1.5 text-[11px] hover:border-accent hover:text-accent"
          >
            <span className="font-mono font-medium">{data.org.slug}</span>
            <span className="text-ink-3">on {new URL(data.org.underlayUrl).host}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
          <span
            className={`flex items-center gap-1.5 rounded-[2px] border px-2.5 py-1.5 text-[11px] ${
              data.org.hasKey ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10'
            }`}
            title={
              data.org.hasKey
                ? 'A write-scoped Underlay API key is configured for this deployment. Publishing needs it, and so does reading these private collections.'
                : 'No Underlay API key is configured, so this deployment cannot publish or read private collections.'
            }
          >
            <Key className="size-3.5" />
            {data.org.hasKey ? 'can publish' : 'no key — cannot publish'}
          </span>
        </div>
      </header>

      {!data.canManage ? (
        <Notice kind="warn">
          <strong>{data.persona}</strong> cannot publish. Publishing copies every source&apos;s
          records, so it requires read access to all of them. Switch to <strong>Chi core</strong>{' '}
          in the sidebar.
        </Notice>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {LAYOUTS.map(({ id, icon: Icon, title, body }) => (
          <Card key={id} title={<span className="flex items-center gap-2"><Icon className="size-4 text-ink-3" />{title}</span>}>
            <p className="text-[11px] leading-relaxed text-ink-2">{body}</p>
            <div className="mt-3">
              <Button
                variant="primary"
                disabled={!data.canManage || !data.org.hasKey || provision.isPending}
                onClick={() => provision.mutate(id)}
              >
                <RefreshCw
                  className={`size-3.5 ${
                    provision.isPending && provision.variables === id ? 'animate-spin' : ''
                  }`}
                />
                Publish this layout
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {provision.error instanceof ApiError ? (
        <Notice kind="warn">
          <strong>{provision.error.message}</strong>
          {typeof provision.error.body['hint'] === 'string' ? (
            <div className="mt-1">{provision.error.body['hint']}</div>
          ) : null}
        </Notice>
      ) : null}

      {last ? (
        <Card
          title={`Published ${last.layout === 'person' ? 'per-person' : 'per-repo'} layout`}
          subtitle={`${last.totalRecords.toLocaleString()} records in the manifests`}
        >
          {last.allUnchanged ? (
            <div className="mb-3 flex items-start gap-2 rounded-[2px] border border-good/40 bg-good/10 px-3 py-2">
              <Check className="mt-0.5 size-4 shrink-0 text-good" />
              <p className="text-[11px] leading-relaxed">
                <strong>No new version — content identical.</strong> Underlay hashed the{' '}
                {last.totalRecords.toLocaleString()} records sent and found them identical to the
                version already stored, so there was nothing to commit.
              </p>
            </div>
          ) : last.totalUploaded === 0 ? (
            <div className="mb-3 flex items-start gap-2 rounded-[2px] border border-good/40 bg-good/10 px-3 py-2">
              <Check className="mt-0.5 size-4 shrink-0 text-good" />
              <p className="text-[11px] leading-relaxed">
                <strong>No records uploaded.</strong> Underlay already held every record by content
                hash, so only a new manifest was written.
              </p>
            </div>
          ) : (
            <p className="mb-3 text-[11px] text-ink-2">
              {last.totalUploaded.toLocaleString()} records uploaded — these were new to the store.
            </p>
          )}

          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="pb-1.5 font-medium">Collection</th>
                <th className="pb-1.5 text-right font-medium">Version</th>
                <th className="pb-1.5 text-right font-medium">Records</th>
                <th className="pb-1.5 text-right font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {last.results.map((r) => (
                <tr key={r.slug} className="border-b border-line/50 last:border-0">
                  <td className="py-1.5">
                    <a
                      href={`${orgUrl}/${r.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex items-center gap-1 font-mono hover:text-accent"
                    >
                      {r.slug}
                      <ExternalLink className="size-3 shrink-0 text-ink-3 group-hover:text-accent" />
                    </a>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r.semver}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.records.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.error ? (
                      <span className="text-critical" title={r.error}>
                        failed
                      </span>
                    ) : r.unchanged ? (
                      <span className="text-good">identical</span>
                    ) : r.uploaded === 0 ? (
                      <span className="text-good">0</span>
                    ) : (
                      r.uploaded.toLocaleString()
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card
        title="Collections in this org"
        subtitle={
          data.upstreamError
            ? 'Local catalog only — could not reach Underlay'
            : `${data.upstream.length} live on ${new URL(data.org.underlayUrl).host}, all private`
        }
      >
        {data.upstreamError ? <Notice kind="warn">{data.upstreamError}</Notice> : null}
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              <th className="pb-1.5 font-medium">Collection</th>
              <th className="pb-1.5 font-medium">Visibility</th>
              <th className="pb-1.5 text-right font-medium">Version</th>
              <th className="pb-1.5 text-right font-medium">Records</th>
            </tr>
          </thead>
          <tbody>
            {(data.upstream.length > 0 ? data.upstream : data.collections).map((row) => (
              <tr key={row.slug} className="border-b border-line/50 last:border-0">
                <td className="py-1.5">
                  <a
                    href={`${orgUrl}/${row.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-1 font-mono hover:text-accent"
                  >
                    {row.slug}
                    <ExternalLink className="size-3 shrink-0 text-ink-3 group-hover:text-accent" />
                  </a>
                </td>
                <td className="py-1.5">
                  {'public' in row ? (
                    <span
                      className={`rounded border px-1 py-px text-[10px] ${
                        row.public
                          ? 'border-critical/40 bg-critical/10 text-critical'
                          : 'border-good/40 bg-good/10 text-ink-2'
                      }`}
                    >
                      {row.public ? 'PUBLIC' : 'private'}
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {'latestVersion' in row ? (row.latestVersion ?? '—') : (row.version ?? '—')}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {fmtCompact(row.recordCount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] leading-snug text-ink-3">
          All collections are private. Privacy is per collection over shared records, so one public
          layout would expose the records in the private ones. These links open only for someone
          signed in to {new URL(data.org.underlayUrl).host} with access to the org.
        </p>
      </Card>

      {data.commits.length > 0 ? (
        <Card title="Publish history">
          <ul className="space-y-1">
            {data.commits.map((commit, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-2 text-[11px]">
                <a
                  href={`${orgUrl}/${commit.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:text-accent hover:underline"
                >
                  {commit.slug}
                </a>
                <span className="tabular-nums text-ink-3">{commit.semver}</span>
                <span
                  className={
                    commit.outcome === 'error' ? 'text-critical' : 'text-ink-2'
                  }
                >
                  {commit.outcome === 'unchanged'
                    ? 'identical — no new version'
                    : commit.outcome === 'ok'
                      ? `${commit.uploaded.toLocaleString()} uploaded`
                      : (commit.detail ?? 'failed')}
                </span>
                <span className="ml-auto tabular-nums text-ink-3">
                  {new Date(commit.at).toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
