import { isDeepStrictEqual } from "node:util"

export interface ExecutionMessage {
  role: string
  content: string | unknown[]
}

function isExecutionMessage(value: unknown): value is ExecutionMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  return typeof message.role === "string" && message.role.length > 0
    && (typeof message.content === "string" || Array.isArray(message.content))
}

/** Execution equivalence must not inherit lineage's ignored block fields. */
export function inspectExecutionHistory(
  raw: readonly unknown[],
  returned: unknown,
): { ok: true; messages: ExecutionMessage[]; changed: boolean } | { ok: false } {
  if (!Array.isArray(returned) || returned.length === 0) return { ok: false }
  // Iteration observes sparse holes as undefined; Array.every skips them.
  for (const message of returned) {
    if (!isExecutionMessage(message)) return { ok: false }
  }
  return {
    ok: true,
    messages: returned,
    changed: returned !== raw && !isDeepStrictEqual(raw, returned),
  }
}
