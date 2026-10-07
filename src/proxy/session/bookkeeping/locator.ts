import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

export interface TranscriptLocator {
  /** Physical Claude transcript session ID, not a client conversation key. */
  sessionId: string
  /** Absolute profile config directory; canonical SQL writers resolve realpath before admission. */
  configDir: string
  /** Optional absolute project directory used by the transcript locator. */
  projectDir?: string
  /** Exact lifecycle generation; absent means a conservative pin across generations. */
  lifecycleGeneration?: string
}

declare const canonical: unique symbol
export type CanonicalTranscriptLocator = TranscriptLocator & { readonly [canonical]: true }

export function validateLocator(locator: TranscriptLocator): void {
  if (!locator || typeof locator.sessionId !== "string" || locator.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string")
  }
  if (typeof locator.configDir !== "string" || !isAbsolute(locator.configDir)) {
    throw new TypeError("configDir must be an absolute path")
  }
  if (
    locator.projectDir !== undefined &&
    (typeof locator.projectDir !== "string" || !isAbsolute(locator.projectDir))
  ) {
    throw new TypeError("projectDir must be an absolute path when provided")
  }
  if (
    locator.lifecycleGeneration !== undefined &&
    (typeof locator.lifecycleGeneration !== "string" || locator.lifecycleGeneration.length === 0)
  ) {
    throw new TypeError("lifecycleGeneration must be a non-empty string when provided")
  }
}

/** Preserve the legacy key algorithm; canonicalize before runtime SQL writes. */
export function resourceKey(locator: TranscriptLocator): string {
  validateLocator(locator)
  return createHash("sha256").update(locator.configDir).update("\0").update(locator.sessionId).digest("hex")
}

/** Filesystem work: call before entering a transaction. Cache is caller/batch-owned. */
export function canonicalizeLocator(
  locator: TranscriptLocator,
  realpaths?: Map<string, string>,
): CanonicalTranscriptLocator {
  validateLocator(locator)
  const path = (value: string): string => {
    const lexical = resolve(value)
    const cached = realpaths?.get(lexical)
    if (cached !== undefined) return cached
    let result: string
    try {
      result = realpathSync.native(lexical)
    } catch (error) {
      if (!(typeof error === "object" && error !== null && !Array.isArray(error)
        && "code" in error && error.code === "ENOENT")) throw error
      result = lexical
    }
    realpaths?.set(lexical, result)
    return result
  }
  return Object.freeze({
    sessionId: locator.sessionId,
    configDir: path(locator.configDir),
    ...(locator.projectDir ? { projectDir: path(locator.projectDir) } : {}),
    ...(locator.lifecycleGeneration ? { lifecycleGeneration: locator.lifecycleGeneration } : {}),
  }) as CanonicalTranscriptLocator
}

/** Decode already-canonical persisted metadata; realpath drift requires offline recanonicalize. */
export function persistedCanonicalLocator(locator: TranscriptLocator): CanonicalTranscriptLocator {
  validateLocator(locator)
  if (
    resolve(locator.configDir) !== locator.configDir ||
    (locator.projectDir !== undefined && resolve(locator.projectDir) !== locator.projectDir)
  ) {
    throw new TypeError("noncanonical persisted locator")
  }
  return Object.freeze({ ...locator }) as CanonicalTranscriptLocator
}
