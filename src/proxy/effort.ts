/**
 * Reasoning effort levels and normalization.
 *
 * The Claude Code SDK `--effort` flag accepts a fixed vocabulary. Clients send
 * the effort under several keys (`effort`, `x-opencode-effort`, the standard
 * OpenAI `reasoning_effort`, or an Anthropic-style `output_config.effort`), and
 * not every value they send is valid for Claude — OpenAI notably offers
 * `"minimal"`, which the SDK rejects. normalizeEffort gates the value so an
 * unknown effort falls back to the model default (undefined) rather than
 * erroring the whole request at the SDK boundary.
 *
 * Pure module — no I/O, no imports from server/session.
 */

export const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type Effort = (typeof VALID_EFFORTS)[number]

/**
 * Return the value if it is a valid Claude effort level, else undefined.
 * Case-sensitive: the SDK expects lowercase.
 */
export function normalizeEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (VALID_EFFORTS as readonly string[]).includes(value)
    ? (value as Effort)
    : undefined
}
