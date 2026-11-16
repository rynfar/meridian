/**
 * What renaming or removing a ChatGPT seat writes to Meridian's settings, in
 * one place, so the server's routes and `meridian profile ...` change exactly
 * the same keys. Settings are re-read from disk on every request, so a write
 * from the CLI reaches a running instance as soon as it lands, as a Claude
 * profile's does.
 */
import { getSetting, saveSettings, setSetting } from "../../settings"
import { CHATGPT_CREDITS_INHERIT, getChatGptFeatures, updateChatGptFeatures } from "./features"
import { chatGptRemovalSettings, type ChatGptProfile, type ChatGptRenamePlan } from "./profiles"
import { createChatGptProfileSurface } from "./profileSurface"
import type { ChatGptCredentialSource } from "./source"

/**
 * The profile surface as settings and the store describe it, with no usage
 * reading and no observed limits: what a process that is not serving - the
 * CLI - can know about the seats.
 */
export function storedChatGptSurface(source: ChatGptCredentialSource, reserved: ReadonlySet<string>) {
  return createChatGptProfileSurface({
    source,
    observed: () => new Map(),
    usage: () => null,
    reserved: () => reserved,
    names: () => getSetting("chatGptProfileNames"),
    aliases: () => getSetting("chatGptProfileAliases"),
    activeSeat: () => getSetting("chatGptActiveSeat"),
    order: () => getSetting("profileOrder"),
    spent: () => undefined,
    freeSeatOrder: () => getChatGptFeatures().freeSeatOrder,
    renewalHours: (seat) => getChatGptFeatures().seatRenewalHours[seat] ?? null,
  })
}

export function applyChatGptRename(plan: Extract<ChatGptRenamePlan, { ok: true }>): void {
  saveSettings({ chatGptProfileNames: plan.names, chatGptProfileAliases: plan.aliasesBySeat })
  const order = getSetting("profileOrder")
  if (order?.includes(plan.from)) setSetting("profileOrder", order.map(id => (id === plan.from ? plan.to : id)))
}

/**
 * Every setting keyed on a removed seat, written without it, and the active
 * pointer moved to `pointer.to` when it named the seat.
 */
export function applyChatGptRemoval(
  seat: Pick<ChatGptProfile, "id" | "seat" | "aliases">,
  pointer: { moves: boolean; to: string | undefined },
): void {
  saveSettings(chatGptRemovalSettings(seat, {
    chatGptProfileNames: getSetting("chatGptProfileNames"),
    chatGptProfileAliases: getSetting("chatGptProfileAliases"),
    profileOrder: getSetting("profileOrder"),
  }))
  if (getChatGptFeatures().seatCreditsPolicy[seat.seat]) updateChatGptFeatures({ seatCreditsPolicy: { [seat.seat]: CHATGPT_CREDITS_INHERIT } })
  if (getChatGptFeatures().seatRenewalHours[seat.seat]) updateChatGptFeatures({ seatRenewalHours: { [seat.seat]: null } })
  if (pointer.moves) setSetting("chatGptActiveSeat", pointer.to)
}
