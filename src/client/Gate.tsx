/**
 * The password screen.
 *
 * States plainly what this is and is not. A demo that presents a curtain as a security
 * boundary teaches the wrong thing about the product behind it — and these are real
 * working transcripts belonging to two people, so being straight about it matters.
 */
import { useState } from 'react'

import { ApiError, api } from './api.ts'

export function Gate({ configured, onUnlock }: { configured: boolean; onUnlock: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/gate', { password })
      onUnlock()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-[15px] font-semibold leading-tight tracking-tight">chiul</h1>
      <p className="mt-1 text-sm text-ink-3">
        Chi session logs, published to Underlay collections.
      </p>

      {configured ? (
        <form onSubmit={submit} className="mt-6 space-y-2">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Shared password"
            autoFocus
            className="w-full rounded-[2px] border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="w-full rounded-[2px] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Enter'}
          </button>
          {error ? <p className="text-xs text-warn">{error}</p> : null}
        </form>
      ) : (
        <p className="mt-6 rounded-[2px] border border-warn/35 bg-warn-wash px-3 py-2 text-xs text-warn">
          This deployment has no <code className="font-mono">DEMO_PASSWORD</code> set, so nobody can
          enter. The gate fails closed on purpose: an unconfigured environment is locked, never open.
        </p>
      )}

      <div className="mt-8 space-y-2 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-3">
        <p>
          <strong className="font-medium text-ink">This is a demo, not a product.</strong> One shared
          password gates the whole site, and anyone inside may view the data as any persona. Access
          rules are genuinely enforced server-side per persona — but the persona is a choice, not an
          identity.
        </p>
        <p>
          The sessions are real working logs, shared for this collaboration and not for
          redistribution. The Underlay collections behind this site are private. Please don&apos;t
          pass the link on.
        </p>
      </div>
    </main>
  )
}
