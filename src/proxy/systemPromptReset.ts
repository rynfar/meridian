import { LRUMap } from "../utils/lruMap"

/**
 * Opt-in system prompt reset: the next turn of a conversation replays its
 * client history into a fresh SDK session, so Claude Code renders the client's
 * current system prompt instead of resending the one its transcript recorded.
 *
 * A request asks for it with this header; a supervisor that cannot add
 * headers to the client's next request arms it for a session key with
 * `POST /v1/sessions/:key/system-prompt-reset`.
 */
export const SYSTEM_PROMPT_RESET_HEADER = "x-meridian-system-prompt-reset"

export function requestsSystemPromptReset(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

/** Resets armed by the endpoint, held until a turn of that key publishes. Process-local. */
export class PendingSystemPromptResets {
  private readonly keys = new LRUMap<string, true>(1000)

  arm(key: string): void {
    this.keys.set(key, true)
  }

  isArmed(key: string): boolean {
    return this.keys.get(key) === true
  }

  settle(key: string): void {
    this.keys.delete(key)
  }
}
