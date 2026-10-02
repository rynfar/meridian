import { sqliteLifecycleLeases } from "./lifecycleLeasesSql"
import { sqliteLifecyclePrepare } from "./lifecyclePrepareSql"
import { sqliteLifecycleRegister } from "./lifecycleRegisterSql"
import { sqliteLifecycleTransitions } from "./lifecycleTransitionsSql"
import { sqliteLifecyclePublication } from "./lifecyclePublicationSql"
import { sqliteLifecycleGc } from "./lifecycleGcSql"
import type { SessionLifecycleBackend } from "./lifecycleBackend"

/** Complete SQLite lifecycle backend, installed after READY initialization. */
export const sqliteLifecycleBackend = {
  ...sqliteLifecycleLeases, ...sqliteLifecyclePrepare, ...sqliteLifecycleRegister,
  ...sqliteLifecycleTransitions, ...sqliteLifecyclePublication, ...sqliteLifecycleGc,
} satisfies SessionLifecycleBackend
