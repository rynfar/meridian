/**
 * Envelope integrity checks.
 *
 * Every #552-family bug (red reads, beheaded parallel calls, lost tool
 * inputs) manifested as a wire-contract violation that was visible at
 * response time — but only to the CLIENT, so we learned about each one from
 * user transcripts weeks later. These checks make the proxy assert its own
 * output contract on every response:
 *
 *   - dangling_block:        a content block left open at stream close
 *                            (recorded at the flush site in server.ts)
 *   - undelivered_tool_use:  a hook-captured call that never reached the client
 *   - empty_tool_input:      a delivered tool_use with no arguments where the
 *                            tool's schema requires them (the client-visible
 *                            shape of a beheaded call)
 *
 * Violations are logged (envelope.violation) and counted on /telemetry so
 * the next regression in this family fires a tripwire in OUR logs instead
 * of waiting for a user report.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 */

export interface EnvelopeViolation {
  type: "dangling_block" | "undelivered_tool_use" | "empty_tool_input"
  detail: string
}

interface ToolSchema {
  name: string
  input_schema?: { required?: unknown; [key: string]: unknown }
}

/**
 * Flag delivered tool_use blocks whose input is empty/missing even though
 * the tool's schema declares required fields. A legit no-arg tool (empty
 * `required`) never flags; unknown tools are skipped (nothing to judge by).
 */
export function checkEmptyToolInputs(
  contentBlocks: Array<Record<string, unknown>>,
  tools: ToolSchema[] | undefined,
): EnvelopeViolation[] {
  if (!tools || tools.length === 0 || contentBlocks.length === 0) return []
  const requiredByName = new Map<string, boolean>()
  for (const t of tools) {
    const req = t.input_schema?.required
    requiredByName.set(t.name, Array.isArray(req) && req.length > 0)
  }
  const violations: EnvelopeViolation[] = []
  for (const b of contentBlocks) {
    if (b.type !== "tool_use" || typeof b.name !== "string") continue
    if (!requiredByName.get(b.name)) continue
    const input = b.input
    const empty = input == null || (typeof input === "object" && Object.keys(input as object).length === 0)
    if (empty) {
      violations.push({
        type: "empty_tool_input",
        detail: `tool_use ${b.name} (${String(b.id ?? "?")}) delivered with empty input but schema requires arguments`,
      })
    }
  }
  return violations
}

/**
 * Flag hook-captured tool calls that never reached the client — the
 * proxy promised the model "forwarded to the client" for these, so a
 * missing delivery diverges the model's view from reality (#552 family).
 */
export function checkUndeliveredToolUses(
  captured: Array<{ id: string; name: string }>,
  deliveredIds: ReadonlySet<string>,
): EnvelopeViolation[] {
  const violations: EnvelopeViolation[] = []
  for (const c of captured) {
    if (!deliveredIds.has(c.id)) {
      violations.push({
        type: "undelivered_tool_use",
        detail: `captured tool_use ${c.name} (${c.id}) was never delivered to the client`,
      })
    }
  }
  return violations
}
