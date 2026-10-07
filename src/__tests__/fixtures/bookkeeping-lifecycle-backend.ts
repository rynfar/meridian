import { describe, it } from "bun:test"
import { sqliteLifecycleTest } from "./bookkeeping-lifecycle-install"
export { sqliteLifecycleTest, setupLifecycleBackend, teardownLifecycleBackend } from "./bookkeeping-lifecycle-install"

/** Keep JSON protocol assertions intact; the reason is visible in the test report. */
export function legacyLifecycleOnly(
  reason: string, name: string, test: () => void | Promise<void>, timeout?: number,
): void {
  const suite = sqliteLifecycleTest ? describe.skip : describe
  suite(`legacy-only: ${reason}`, () => { it(name, test, timeout) })
}
