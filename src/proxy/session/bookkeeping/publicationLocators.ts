import type { CanonicalTranscriptLocator, TranscriptLocator } from "./locator"
import { connectionFor, type Connection } from "./connection"

let observed: { connection: Connection; paths: ReadonlyMap<string, string> } | undefined

/** A synchronous publication carries only its own pre-BEGIN path observations into store writes. */
export function withPublicationLocators<T>(directory: string, raw: TranscriptLocator,
  canonical: CanonicalTranscriptLocator, callback: () => T): T {
  const previous = observed
  const paths = new Map([[raw.configDir, canonical.configDir]])
  if (raw.projectDir !== undefined && canonical.projectDir !== undefined)
    paths.set(raw.projectDir, canonical.projectDir)
  observed = { connection: connectionFor(directory), paths }
  try { return callback() } finally { observed = previous }
}

export function observedPublicationLocator(directory: string, locator: TranscriptLocator): TranscriptLocator {
  if (!observed) return locator
  if (connectionFor(directory) !== observed.connection) throw new Error("cross-database publication is forbidden")
  return { ...locator, configDir: observed.paths.get(locator.configDir) ?? locator.configDir,
    ...(locator.projectDir === undefined ? {} : { projectDir: observed.paths.get(locator.projectDir) ?? locator.projectDir }) }
}
