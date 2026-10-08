/**
 * How long Claude Code keeps the transcripts Meridian's SDK children write.
 *
 * Every query leaves a transcript, `projects/<project>/<session>.jsonl` plus
 * its sidecar files, under the child's config root. Claude Code deletes
 * transcripts that have gone untouched for `cleanupPeriodDays` (default 30) in
 * a background sweep shortly after a process starts. But it sweeps only when
 * the user settings source is enabled or an enabled source names a period, and
 * Meridian starts every child with `settingSources: []` so no CLAUDE.md, hook
 * or permission file on the proxy host leaks into a request (#490, #634). With
 * nothing enabled, Claude Code skips the sweep ("userSettings source is
 * disabled (--setting-sources) and no enabled source provides
 * cleanupPeriodDays"), so every transcript Meridian's own lifecycle GC no
 * longer tracked stayed on disk forever.
 *
 * Flag settings are always an enabled source, so handing the period over in
 * the SDK `settings` object brings the sweep back without loading any file.
 * This module decides that period:
 *
 *   1. Meridian's own period: MERIDIAN_TRANSCRIPT_RETENTION_DAYS, else
 *      `transcriptRetentionDays` in settings.json, else 30, Claude Code's own
 *      default. 0 passes nothing, which leaves the sweep off as it always was.
 *   2. When that is on, a config root whose own settings.json names a
 *      `cleanupPeriodDays` keeps it. Without profiles the root is the user's
 *      ~/.claude, shared with their interactive Claude Code, and overriding a
 *      longer retention they chose there would delete their own transcripts.
 *   3. A settings.json that cannot be read, or names a period Claude Code
 *      would reject, passes nothing: the period it means cannot be known, and
 *      Claude Code itself skips its sweep in that case rather than guess.
 *
 * Resolved on every request, like routing, so a change applies to the next
 * child.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { env } from "../env"
import { getSetting } from "../settings"

export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 30

/** Accepted Meridian-level periods, shared by the form and the validator.
 *  0 is off; ten years is the same cap telemetry retention has. */
export const TRANSCRIPT_RETENTION_LIMITS = { min: 0, max: 3650 } as const

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

export function isTranscriptRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= TRANSCRIPT_RETENTION_LIMITS.min && value <= TRANSCRIPT_RETENTION_LIMITS.max
}

/** Meridian's own period, before any config root's choice. An env value or a
 *  saved setting outside the limits is ignored rather than clamped. */
export function meridianTranscriptRetention(): TranscriptRetention {
  const raw = env("TRANSCRIPT_RETENTION_DAYS")?.trim()
  if (raw) {
    const fromEnv = Number(raw)
    if (isTranscriptRetentionDays(fromEnv)) return { days: fromEnv, source: "env" }
  }
  const saved = getSetting("transcriptRetentionDays")
  if (isTranscriptRetentionDays(saved)) return { days: saved, source: "settings" }
  return { days: DEFAULT_TRANSCRIPT_RETENTION_DAYS, source: "default" }
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
