/** Typed fetch wrappers. One place that knows the API's error shape. */

export type Detail = 'none' | 'metrics' | 'reduced' | 'full'

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>

  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(res.status, (body['error'] as string) ?? `HTTP ${res.status}`, body)
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
}

// --- Shapes ---

export type GateState = { configured: boolean; unlocked: boolean }

export type PersonaGrants = {
  wildcard: { detail: Detail; seePrivate: boolean }
  bySource: { source: string; detail: Detail; seePrivate: boolean }[]
}

export type PersonaSummary = {
  id: string
  label: string
  kind: 'member' | 'steward' | 'outsider'
  sourceLabel: string | null
  description: string | null
  current: boolean
  grants: PersonaGrants
}

export type Me = {
  persona: { id: string; label: string; kind: string; sourceLabel: string | null }
  personas: PersonaSummary[]
  disclaimer: string
}

export type WorkspaceState = {
  workspace: { id: string; name: string; underlayUrl: string; orgSlug: string }
  status: string
  statusDetail: string | null
  recordsRead: number
  sessions: number
  entries: number
  hydratedAt: string | null
}

export type SessionSummary = {
  sessionId: string
  title: string | null
  source: string
  repo: string | null
  cwd?: string | null
  startedAt: string | null
  lastAt: string | null
  entryCount: number
  messageCount: number
  approxTokens: number
  costUsd: number
  models: string[]
  detail: Detail
  canOpen: boolean
}

export type Visibility = {
  total: number
  visible: number
  withheld: number
  persona: string
  bySource: { source: string; detail: Detail; explanation: string; sessions: number }[]
}

export type Stats = {
  totals: { sessions: number; costUsd: number; entries: number; tokens: number }
  bySource: { source: string; sessions: number; costUsd: number; tokens: number; entries: number }[]
  byModel: { source: string; model: string; entries: number }[]
  byTool: { source: string; toolName: string; calls: number }[]
  byDay: { source: string; day: string; sessions: number; costUsd: number }[]
  cacheTokens: { source: string; input: number; cacheRead: number; output: number }[]
  links: number
  withheldSources: string[]
}

export type EntryView = {
  recordId: string
  seq: number
  z: number
  entryType: string
  role: string | null
  toolName: string | null
  model: string | null
  timestamp: string | null
  entry: Record<string, unknown>
}
