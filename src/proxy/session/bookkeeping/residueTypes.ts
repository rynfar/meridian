import { isUuidV4 } from "./uuid"
import { privateName } from "./privateNames"

export type ResidueVerdict = "dead-incarnation" | "live" | "unknown"
export interface Residue { path: string; verdict: ResidueVerdict; kind?: "incomplete-candidate" | "bootstrap-alias"; digest?: string; bytes?: number }
export interface ArchivedResidue extends Residue {
  digest: string; bytes: number; dev: number; ino: number; archiveName?: string
}

export function isResiduePath(path: string): boolean {
  return /^(session-gc|sessions)\.json\.lock[^/]*\.candidate-[^/]+$/.test(path)
    || /^(deletion-gates|sdk-process-gates)\/[^/]+$/.test(path) && !path.endsWith("/..")
    || isLegacyTemporaryName(path)
}

export function isLegacyTemporaryName(path: string): boolean {
  const prefix = /^(session-gc|sessions)\.json\.tmp-\d+-/.exec(path)?.[0]
  return prefix !== undefined && isUuidV4(path.slice(prefix.length))
}

function validArchiveName(source: string, value: string): boolean {
  const suffix = value.slice(-73), id = suffix.slice(0, 36)
  if (!isUuidV4(id) || suffix[36] !== "-" || !isUuidV4(suffix.slice(37))) return false
  try { privateName(source + ".residue", id, value); return true } catch { return false }
}
export function validResidues(value: unknown): value is ArchivedResidue[] {
  return Array.isArray(value) && new Set(value.map((row) => row?.path)).size === value.length
    && value.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false
      const row = entry as Record<string, unknown>
      return typeof row.path === "string" && isResiduePath(row.path) && !row.path.endsWith("/.")
        && ["dead-incarnation", "unknown"].includes(String(row.verdict))
        && (row.kind === undefined || row.kind === "incomplete-candidate" && row.verdict === "unknown")
        && (row.archiveName === undefined || row.kind === "incomplete-candidate"
          && typeof row.archiveName === "string" && validArchiveName(String(row.path), row.archiveName))
        && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)
        && [row.bytes, row.dev, row.ino].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    })
}
