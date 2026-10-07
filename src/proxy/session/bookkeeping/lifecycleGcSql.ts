import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { runDeletionPhase } from "./lifecycleDeletionSql"
import { retryDeferredLeaseReleases } from "./lifecycleLeasesSql"
import { reconcile } from "./lifecycleReconcileSql"
import type { TranscriptLocator } from "./types"

export async function runGc(pins: readonly TranscriptLocator[], options: SessionLifecycleOptions = {}) {
  await retryDeferredLeaseReleases(options)
  await reconcile(pins, options)
  return runDeletionPhase(pins, options)
}

export const sqliteLifecycleGc = { reconcile, runGc }
