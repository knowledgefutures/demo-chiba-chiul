import type { Context } from 'hono'

import type * as schema from '../db/schema.ts'
import type { Access } from './grants.ts'

export type WorkspaceRow = typeof schema.workspaces.$inferSelect
export type PersonaRow = typeof schema.personas.$inferSelect
export type CollectionRow = typeof schema.collections.$inferSelect

/**
 * `access` is set by middleware rather than resolved per handler, so a route can read
 * `c.get('access')` knowing the persona's grants have already been folded — and so
 * there is exactly one place where visibility is decided.
 */
export interface AppEnv {
  Bindings: Env
  Variables: {
    workspace: WorkspaceRow
    access: Access
  }
}

export type AppContext = Context<AppEnv>
