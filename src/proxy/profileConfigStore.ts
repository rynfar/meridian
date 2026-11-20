/** Profile configuration writers share one lock and publish complete snapshots.
 * Leaf module: no server/session imports. The lock and snapshot rules live in
 * lockedFile.ts.
 */
import { existsSync, readFileSync } from "node:fs"
import { publishFileSnapshot, withFileLock, withFileLockSync } from "./lockedFile"
import type { ProfileConfig } from "./profiles"

const BUSY = "Profile configuration is locked by another writer; retry after that writer finishes. An interrupted writer's lock requires cleanup while all writers are stopped."

/** CLI-only waiting; HTTP account creation uses the nonblocking async form. */
export function withProfileConfigLockSync<T>(file: string, operation: () => T): T {
  return withFileLockSync(file, BUSY, operation)
}

export async function withProfileConfigLock<T>(file: string, operation: () => T): Promise<T> {
  return withFileLock(file, BUSY, operation)
}

function isProfile(value: unknown): value is ProfileConfig {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id.length > 0
}

/** Writers must never turn a malformed existing file into an empty list. */
export function readProfileConfigForUpdate(file: string): ProfileConfig[] {
  if (!existsSync(file)) return []
  const decoded: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(decoded)) throw new Error("Profile configuration must contain an array")
  const entries: unknown[] = decoded
  if (!entries.every(isProfile)) throw new Error("Profile configuration contains an invalid profile")
  return entries
}

/** Call under the writer lock; readers see the old or complete new snapshot. */
export function publishProfileConfig(file: string, profiles: ProfileConfig[]): void {
  publishFileSnapshot(file, `${JSON.stringify(profiles, null, 2)}\n`)
}
