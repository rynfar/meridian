/**
 * Shared reader for the session JSONL the CLI writes behind Meridian.
 *
 * The passthrough probes all answer the same question — what would
 * resumeSessionAt keep? — so they read the transcript the same way, from one
 * copy.
 *
 * A denial is whatever src/proxy/passthroughTranscript.ts says it is: the
 * proxy's own detector, imported rather than restated, so the probes and the
 * repair can never disagree about which rows are the hook's denials. That
 * matters after a repair: a delivered result that was itself an error is
 * rewritten in place with is_error still set, and a reader keyed on is_error
 * alone would count it as a surviving denial.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isForwardedDenial } from "../../src/proxy/passthroughTranscript.ts"

const PROJECTS_ROOT = join(homedir(), ".claude", "projects")

/** Locate the session JSONL the CLI wrote for a session id, whatever the cwd slug. */
export function findSessionFile(sessionId) {
  if (!existsSync(PROJECTS_ROOT)) return null
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const candidate = join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every session JSONL on disk with its mtime, for before/after diffing. */
export function snapshotSessionFiles() {
  const seen = new Map()
  if (!existsSync(PROJECTS_ROOT)) return seen
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const full = join(PROJECTS_ROOT, dir)
    let entries
    try { entries = readdirSync(full) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue
      const p = join(full, f)
      try { seen.set(p, statSync(p).mtimeMs) } catch { /* raced with a write */ }
    }
  }
  return seen
}

export function readRows(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

export const blocksOf = row => (Array.isArray(row?.message?.content) ? row.message.content : [])

/** Flatten a tool_result's content to text, whichever shape it arrived in. */
export function toolResultText(block) {
  if (typeof block?.content === "string") return block.content
  if (Array.isArray(block?.content)) return block.content.map(c => c?.text ?? "").join("")
  return ""
}

/** A synthetic denial: the CLI's answer to a call the hook refused. */
export const isDenyResult = isForwardedDenial

/**
 * Guard against a silent detection failure: a turn that forwarded calls must
 * have produced denials, so finding none means the reader is broken, not that
 * the transcript is clean. Returns a warning string, or null when all is well.
 */
export function denyDetectionWarning({ forwardedCalls, denyResults }) {
  if (forwardedCalls === 0 || denyResults.length > 0) return null
  return `${forwardedCalls} call(s) were forwarded but NO deny tool_result was found — ` +
    `treat every "clean" result below as unproven; the reader, not the transcript, is probably wrong`
}
