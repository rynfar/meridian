import type { Context } from "hono"
import type { AgentIdentity } from "../adapter"

/** The account-routing key: the declared conversation root, else this request's key. */
export function rootSessionIdOf(
  adapter: Pick<AgentIdentity, "getSessionId" | "getRootSessionId">,
  c: Context,
  body?: unknown,
): string | undefined {
  return adapter.getRootSessionId?.(c, body) ?? adapter.getSessionId(c, body)
}
