import { createHash } from "node:crypto"

/** One instruction file as the client's system prompt carries it, header line included. */
export interface InstructionSection {
  /** Stable identity of the section within a conversation, e.g. the file path. */
  key: string
  text: string
}

/**
 * Digests of a conversation's instruction sections, published with its SDK
 * mapping. Keys and values are sha256 hex of the section key and text, so the
 * store holds no prompt text or paths.
 */
export interface InstructionSectionState {
  /** The sections the resumed transcript's model has been given most recently. */
  seen: Record<string, string>
}

const DIGEST = /^[a-f0-9]{64}$/

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function hashInstructionSections(sections: readonly InstructionSection[]): Record<string, string> {
  return Object.fromEntries(sections.map(section => [sha256(section.key), sha256(section.text)]))
}

/** The state of a session whose system prompt was rendered from `sections`. */
export function instructionSectionState(sections: readonly InstructionSection[]): InstructionSectionState {
  return { seen: hashInstructionSections(sections) }
}

function isDigestMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, digest]) => DIGEST.test(key) && typeof digest === "string" && DIGEST.test(digest))
}

export function isInstructionSectionState(value: unknown): value is InstructionSectionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === "seen" && isDigestMap((value as { seen: unknown }).seen)
}

export interface InstructionSectionChange {
  /** Current sections that are new or differ from the stored digests. */
  changed: InstructionSection[]
  /** Number of stored sections the client no longer sends. */
  removed: number
}

/** Sections of `sections` that differ from `seen`, and how many `seen` holds that are gone. */
export function diffInstructionSections(
  seen: Record<string, string>,
  sections: readonly InstructionSection[],
): InstructionSectionChange {
  const current = new Set<string>()
  const changed = sections.filter(section => {
    const key = sha256(section.key)
    current.add(key)
    return seen[key] !== sha256(section.text)
  })
  return { changed, removed: Object.keys(seen).filter(key => !current.has(key)).length }
}

/**
 * The state to publish for a turn, and what changed relative to the stored one.
 *
 * A fresh SDK session renders the current system prompt natively, so its
 * state is the current sections. A resumed transcript keeps the prompt its
 * first turn recorded (Claude Code's prompt snapshot), so resuming does not
 * advance what its model has seen. A mapping published before this state
 * existed is adopted as the baseline: what it pinned is unknown.
 */
export function planInstructionSections(
  stored: InstructionSectionState | undefined,
  sections: readonly InstructionSection[],
  resumed: boolean,
): { state: InstructionSectionState; change: InstructionSectionChange } {
  const current = instructionSectionState(sections)
  if (!resumed || !stored) return { state: current, change: { changed: [], removed: 0 } }
  return { state: stored, change: diffInstructionSections(stored.seen, sections) }
}
