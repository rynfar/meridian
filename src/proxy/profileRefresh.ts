/**
 * What a profile card's Refresh says about each part of the profile it
 * re-read: its login and its usage. The route
 * (`POST /profiles/:id/refresh`, server.ts) does the reads; this decides each
 * part's state and words. Policy: profiles-routing.spec.md, "Refreshing a
 * profile".
 *
 * Leaf module: type imports only.
 */

import type { StoredCredentialPresence } from "./tokenRefresh"
import type { ChatGptTokenState } from "./chatgpt/profiles"

/**
 * `fresh`: read just now. `rate_limited`: turned away by the provider or by
 * the part's own budget. `failed`: the read did not land, or what it found
 * needs the user. `skipped`: not tried, because the login it needs is gone.
 * `unavailable`: nothing Meridian can read for this part of this profile.
 */
export type RefreshPartState = "fresh" | "rate_limited" | "failed" | "skipped" | "unavailable"

export interface RefreshPart {
  readonly state: RefreshPartState
  readonly note: string
  readonly retryAfterMs?: number
}

/** What a login check found, as `/profiles/list` reads `loggedIn` (needs_login) or could not tell (unverified). */
export type LoginState = "authenticated" | "needs_login" | "unverified"

export function tooSoonPart(label: string, retryAfterMs: number): RefreshPart {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return { state: "rate_limited", note: `${label} was re-read moments ago; the next re-read opens in ${seconds}s.`, retryAfterMs }
}

export const SKIPPED_WITHOUT_LOGIN: RefreshPart = { state: "skipped", note: "Not read: this profile has no usable login." }

export function claudeLoginPart(input: {
  readonly state: LoginState
  /** The check itself failed (no answer from Claude Code), rather than answering. */
  readonly checkFailed: boolean
  /** Claude Code has answered for this profile before, so an earlier answer stands. */
  readonly everAnswered: boolean
  readonly presence: StoredCredentialPresence
  readonly email: string | null
  /** The login now holds another account than the one recorded before. */
  readonly accountChanged: boolean
}): RefreshPart {
  if (input.state === "needs_login") {
    return {
      state: "failed",
      note: input.presence === "absent"
        ? "The stored login has no access token. Sign this profile in again."
        : "Claude Code says this profile is not signed in. Sign this profile in again.",
    }
  }
  if (input.checkFailed || input.state === "unverified") {
    return {
      state: "failed",
      note: input.everAnswered
        ? "Claude Code did not answer the login check; its last answer stays."
        : "Claude Code did not answer the login check, and has not answered for this profile before.",
    }
  }
  const who = input.email ? `Signed in as ${input.email}.` : "Signed in."
  return {
    state: "fresh",
    note: input.accountChanged
      ? `${who} The login now holds another account than before; what Meridian knew about the previous one was dropped and is read afresh.`
      : who,
  }
}

/** A ChatGPT seat's login, as the usage read that just ran found its token. */
export function seatLoginPart(input: { readonly loggedIn: boolean; readonly tokenState: ChatGptTokenState; readonly email: string | null }): RefreshPart {
  if (input.loggedIn) return { state: "fresh", note: input.email ? `Signed in as ${input.email}.` : "Signed in." }
  switch (input.tokenState) {
    case "refused": return { state: "failed", note: "ChatGPT refused this seat's token. Sign the seat in again." }
    case "expired": return { state: "failed", note: "This seat's token expired. Sign the seat in again." }
    case "no_token": return { state: "failed", note: "This seat has no token. Sign it in again." }
    case "requires_reauth": return { state: "failed", note: "ChatGPT asks for this seat to sign in again." }
    default: return { state: "failed", note: "Meridian could not tell whether this seat is signed in." }
  }
}

/** True only when both records name an account and they differ: an unread account proves nothing. */
export function accountChanged(
  before: { readonly accountUuid?: string | null } | undefined,
  after: { readonly accountUuid?: string | null } | null,
): boolean {
  return !!before?.accountUuid && !!after?.accountUuid && before.accountUuid !== after.accountUuid
}
