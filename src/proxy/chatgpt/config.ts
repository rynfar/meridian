/**
 * Which ChatGPT credential source an instance runs, decided once at creation.
 *
 * `MERIDIAN_CHATGPT_CREDENTIALS`:
 *   - `follow-external`: read the oc-codex-multi-auth store
 *     (`MERIDIAN_CODEX_POOL_PATH`) read-only; never refresh, never write.
 *   - `owned`: Meridian's own store with the refresh lease, taken at startup
 *     even while the store is empty. Seats are signed in through the web UI
 *     (chatgpt/login.ts); until one is, a GPT request is answered with an
 *     error saying so rather than routed to Claude.
 *   - `off`: no ChatGPT backend; GPT model names keep meaning Claude.
 *   - unset: `owned` when Meridian's own store holds accounts, else off - so
 *     an instance nobody configured for ChatGPT behaves exactly as before.
 */
import { createExternalCredentialSource } from "./external"
import { chatGptRenewalIntervals, getChatGptFeatures } from "./features"
import { createOwnedCredentialSource } from "./owned"
import { chatGptStorePath } from "./paths"
import type { ChatGptCredentialSource } from "./source"

export function resolveChatGptSource(value = process.env.MERIDIAN_CHATGPT_CREDENTIALS): ChatGptCredentialSource | undefined {
  const mode = value?.trim() || undefined
  if (mode === "off") return undefined
  if (mode === "follow-external") return createExternalCredentialSource()
  if (mode === "owned" || mode === undefined) {
    return createOwnedCredentialSource({
      storePath: chatGptStorePath(),
      allowEmpty: mode === "owned",
      renewalIntervals: () => chatGptRenewalIntervals(getChatGptFeatures()),
    })
  }
  throw new Error("MERIDIAN_CHATGPT_CREDENTIALS must be follow-external, owned or off")
}
