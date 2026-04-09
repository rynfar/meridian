/**
 * Per-block content sanitizer for orchestration wrapper leakage.
 *
 * Agent harnesses (OpenCode, Droid, ForgeCode, oh-my-opencode, etc.) inject
 * internal markup into message content — `<system-reminder>`, `<env>`,
 * `<task_metadata>`, and similar tags. When the proxy flattens messages into
 * a text prompt for the Agent SDK, these tags become model-visible text that
 * can confuse the model or cause it to echo them back ("talking to itself").
 *
 * This module strips known orchestration tags from **individual text blocks**
 * before flattening — not from the final concatenated string. Operating
 * per-block eliminates the cross-message regex risk that makes full-string
 * sanitization fragile.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

// ---------------------------------------------------------------------------
// Exact tag names known to be orchestration-only.
// These are NOT prefix patterns — each entry is a specific tag name that
// harnesses inject and that never appears in legitimate user content.
// ---------------------------------------------------------------------------

const ORCHESTRATION_TAGS = [
  // Droid: CWD + env info injected into first user message
  "system-reminder",
  // OpenCode / Crush: environment context blocks
  "env",
  // ForgeCode: system info wrapper and children
  "system_information",
  "current_working_directory",
  "operating_system",
  "default_shell",
  "home_directory",
  // OpenCode: task/tool/skill orchestration
  "task_metadata",
  "tool_exec",
  "tool_output",
  "skill_content",
  "skill_files",
  // OpenCode: context injection blocks
  "directories",
  "available_skills",
  // Leaked thinking tags (NOT the structured content block type —
  // these are raw XML tags that appear in text content on replay)
  "thinking",
]

// Build regex for paired tags: <tagname ...>...</tagname>
// Each tag gets its own regex to avoid cross-tag matching.
const PAIRED_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
)

// Self-closing variants: <tagname ... />
const SELF_CLOSING_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*\\/>`, "gi")
)

// Non-XML orchestration markers (unique, branded — zero false-positive risk)
const NON_XML_PATTERNS: RegExp[] = [
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
  // Meridian's own file change summary leaking back into conversation
  /\n?---\nFiles changed:[^\n]*(?:\n(?:  [-•*] [^\n]*))*\n?/g,
]

const ALL_PATTERNS = [
  ...PAIRED_TAG_PATTERNS,
  ...SELF_CLOSING_TAG_PATTERNS,
  ...NON_XML_PATTERNS,
]

/**
 * Strip orchestration wrappers from a single text string.
 *
 * Designed to be called on individual content blocks (not concatenated
 * prompt strings) to eliminate cross-block regex matching risk.
 */
export function sanitizeTextContent(text: string): string {
  let result = text
  for (const pattern of ALL_PATTERNS) {
    // Reset lastIndex for stateful regexes (those with 'g' flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // Collapse runs of 3+ newlines into 2 (avoids large gaps where tags were)
  result = result.replace(/\n{3,}/g, "\n\n")
  return result.trim()
}
