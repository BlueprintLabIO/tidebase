// Library entry point: embed the Tidebase server in your own Node process.
//
//   import { createContext, createApp, reconcileTick, migrate } from '@tidebase/server'
//
//   const ctx = createContext({ connectionString })
//   await migrate(ctx.pool)
//   serve({ fetch: createApp(ctx).fetch, port })
//   setInterval(() => reconcileTick(new Date(), ctx), 5000)
//
// A context is one Tidebase instance over one Postgres database. Create many
// contexts in one process to serve many isolated databases (e.g. one per
// tenant); advisory locks, the reconciler, and migrations are all scoped to
// the context's database.
export { createContext, defaultContext } from './context.js'
export type { CreateContextOptions, ServerContext } from './context.js'
export { createApp } from './app.js'
export type { CreateAppOptions } from './app.js'
export { reconcileTick, startReconciler } from './reconciler.js'
export type { TickReport } from './reconciler.js'
export { migrate, pendingMigrations } from './db.js'
