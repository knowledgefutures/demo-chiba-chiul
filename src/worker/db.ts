/** Drizzle handle over the D1 control-plane binding. */
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '../db/schema.ts'

export const db = (c: { env: Env }) => drizzle(c.env.DB, { schema })

export type Db = ReturnType<typeof db>
