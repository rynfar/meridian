/**
 * Whether, and for how long, Claude Code's own retention cleanup runs in
 * Meridian's SDK children. Off unless the operator turns it on.
 *
 * Meridian starts every child with `settingSources: []` (#490, #634), and
 * Claude Code skips its cleanup when no enabled settings source names
 * `cleanupPeriodDays`. Flag settings are always enabled, so passing the period
 * there brings the cleanup back without loading any settings file. Rationale,
 * what the cleanup deletes and its limits: `src/proxy/SPEC.md` (Decisions) and
 * `docs/configuration.md` (Transcript retention).
 *
 *   1. Meridian's own period: MERIDIAN_TRANSCRIPT_RETENTION_DAYS, else
 *      `transcriptRetentionDays` in settings.json, else off. The env var
 *      accepts 0 to pin retention off over a saved period.
 *   2. When that is on, a config root whose own settings.json names a
 *      `cleanupPeriodDays` keeps it.
 *   3. A root settings.json that cannot be read, or names a period Claude Code
 *      would reject, passes nothing.
 *
 * Resolved on every request, so a change applies to the next child.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { env, envSource } from "../env"
import { getSetting } from "../settings"

/** Off: no period is passed and Claude Code's cleanup stays skipped, as before #1261. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 0

/** Accepted periods when retention is on. Claude Code rejects 0
 *  (`int().positive()`), so the minimum is 1; ten years is the same cap
 *  telemetry retention has. */
export const TRANSCRIPT_RETENTION_LIMITS = { min: 1, max: 3650 } as const

export type TranscriptRetentionSource =
  | "env"
  | "settings"
  | "default"
  /** The config root's own settings.json named the period. */
  | "config-dir"
  /** The config root's own settings.json could not be read, or named a
   *  period Claude Code would reject, so none is passed. */
  | "config-dir-unusable"

export interface TranscriptRetention {
  /** `cleanupPeriodDays` to pass to the child; 0 passes none. */
  days: number
  source: TranscriptRetentionSource
}

/** A period that turns retention on: an integer within the limits. */
export function isTranscriptRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= TRANSCRIPT_RETENTION_LIMITS.min && value <= TRANSCRIPT_RETENTION_LIMITS.max
}

/** The env value as a period, 0 for an explicit off, or undefined when it is
 *  unset or unusable (then resolution goes on as though it were unset). */
function envTranscriptRetentionDays(): number | undefined {
  const raw = env("TRANSCRIPT_RETENTION_DAYS")?.trim()
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const days = Number(raw)
  return days === 0 || isTranscriptRetentionDays(days) ? days : undefined
}

/** Meridian's own period, before any config root's choice. An env value or a
 *  saved setting outside the limits is ignored rather than clamped. */
export function meridianTranscriptRetention(): TranscriptRetention {
  const fromEnv = envTranscriptRetentionDays()
  if (fromEnv !== undefined) return { days: fromEnv, source: "env" }
  const saved = getSetting("transcriptRetentionDays")
  if (isTranscriptRetentionDays(saved)) return { days: saved, source: "settings" }
  return { days: DEFAULT_TRANSCRIPT_RETENTION_DAYS, source: "default" }
}

/** The env var for the settings page's override line, with how resolution
 *  used it (`EnvSourceView.use` in telemetry/settingRow.ts). */
export function transcriptRetentionEnvSource(): { name: string; value: string | null; secret: boolean; use: "value" | "ignored" } | null {
  const source = envSource("TRANSCRIPT_RETENTION_DAYS")
  if (source === null) return null
  return { ...source, use: envTranscriptRetentionDays() === undefined ? "ignored" : "value" }
}

/** The period to hand a child whose config root is `configDir`. */
export function resolveTranscriptRetention(configDir: string): TranscriptRetention {
  const meridian = meridianTranscriptRetention()
  if (meridian.days === 0) return meridian
  const own = configRootPeriod(configDir)
  if (own === undefined) return meridian
  return own === null
    ? { days: 0, source: "config-dir-unusable" }
    : { days: own, source: "config-dir" }
}

/** The root's own `cleanupPeriodDays`: undefined when its settings.json names
 *  none, null when what it names cannot be used. Claude Code requires a
 *  positive integer; 0 fails its validation. */
function configRootPeriod(configDir: string): number | null | undefined {
  let text: string
  try {
    text = readFileSync(join(configDir, "settings.json"), "utf-8")
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? undefined : null
  }
  if (text.trim() === "") return undefined
  const errors: ParseError[] = []
  const settings: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || settings === null || typeof settings !== "object" || Array.isArray(settings)) return null
  if (!("cleanupPeriodDays" in settings)) return undefined
  const period = settings.cleanupPeriodDays
  return typeof period === "number" && Number.isSafeInteger(period) && period > 0 ? period : null
}
