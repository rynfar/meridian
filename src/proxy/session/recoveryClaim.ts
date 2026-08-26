import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import {
  captureProcessIncarnation,
  parseProcessIncarnation,
  processIncarnationIsDead,
  type ProcessIncarnation,
} from "./processIncarnation"

export const RECOVERY_CLAIM_VERSION = 2

export interface RecoveryClaimOwner {
  version: typeof RECOVERY_CLAIM_VERSION
  generation: string
  token: string
  pid: number
  hostname: string
  createdAt: number
  incarnation: ProcessIncarnation
}

export function createRecoveryClaimOwner(generation: string): RecoveryClaimOwner {
  if (!generation) throw new TypeError("recovery generation must not be empty")
  const incarnation = captureProcessIncarnation()
  if (!incarnation) throw new Error("cannot capture recovery owner process incarnation")
  return {
    version: RECOVERY_CLAIM_VERSION,
    generation,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
    incarnation,
  }
}

export function parseRecoveryClaimOwner(value: unknown): RecoveryClaimOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const owner = value as Record<string, unknown>
  if (
    owner.version !== RECOVERY_CLAIM_VERSION
    || typeof owner.generation !== "string"
    || owner.generation.length === 0
    || typeof owner.token !== "string"
    || owner.token.length === 0
    || typeof owner.pid !== "number"
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.hostname !== "string"
    || owner.hostname.length === 0
    || typeof owner.createdAt !== "number"
    || !Number.isFinite(owner.createdAt)
    || !parseProcessIncarnation(owner.incarnation)
  ) return undefined
  return owner as unknown as RecoveryClaimOwner
}

export function parseRecoveryClaimOwnerJson(raw: string): RecoveryClaimOwner | undefined {
  try {
    return parseRecoveryClaimOwner(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

/** Only an authoritative OS incarnation mismatch proves that an owner is dead. */
export function recoveryClaimOwnerIsDead(
  owner: RecoveryClaimOwner,
  probe: (incarnation: ProcessIncarnation) => boolean = processIncarnationIsDead,
): boolean {
  return probe(owner.incarnation)
}

export function getRecoveryClaimPath(lockPath: string, generation: string): string {
  const digest = createHash("sha256").update(generation).digest("hex")
  return `${lockPath}.recover-${digest}`
}

export function getRecoveryClaimTombstonePath(claimPath: string, claimToken: string): string {
  const digest = createHash("sha256").update(claimToken).digest("hex")
  return `${claimPath}.orphan-${digest}`
}
