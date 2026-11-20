/**
 * Where the ChatGPT backend gets its seats and access tokens.
 *
 * Two implementations, chosen once per instance:
 *
 * - `owned` (owned.ts): Meridian's own store. Meridian holds the single
 *   writer lease and is the only process that refreshes these tokens.
 * - `follow-external` (external.ts): the oc-codex-multi-auth store, read-only.
 *   Its owner refreshes; Meridian only reads access tokens and never writes
 *   the file, its locks, or the token endpoint.
 *
 * The backend never learns which one it holds beyond `mode`, which it uses
 * only to word the error a client sees when nothing can serve.
 *
 * Nothing on this interface returns a refresh token, and `seats()` returns no
 * token at all, so a view built from it cannot leak one.
 */
import type { CodexPoolResult } from "../codex/pool"
import type { RefreshOutcome } from "./refresh"

export type ChatGptCredentialMode = "owned" | "follow-external"

/** One seat, as the dashboard may see it. No credential fields. */
export interface ChatGptSeatView {
  /** `accountUserId`: the seat. `accountId` is shared between seats and never a key. */
  id: string
  email: string | null
  planType: string | null
  /** Whether the external owner (or the owned store) currently lets this seat serve. */
  eligible: boolean
  /** Why not, when `eligible` is false. */
  reason?: SeatUnavailableReason
  /** The access token's expiry, epoch ms. */
  expiresAt: number | null
  /** owned only: when Meridian renews the seat next because chatgpt.com refused its access token, epoch ms. */
  renewalRetryAt?: number | null
  /** The seat the credential owner itself would pick next. */
  active?: boolean
  /** 0-based position in the store; the owner's own account numbers are this plus one. */
  storeIndex?: number
}

export type SeatUnavailableReason =
  | "unknown"
  | "disabled"
  | "cooling_down"
  | "quota_exhausted"
  | "no_token"
  | "expired"
  | "requires_reauth"
  | "no_authority"
  /** Taken out of work routing by the operator or a supervisor (routing exclusions). */
  | "excluded"

export interface ChatGptServingAccount {
  accountUserId: string
  /** Workspace scope header value. */
  accountId: string
  accessToken: string
}

export type SeatCredential =
  | { ok: true; account: ChatGptServingAccount }
  | { ok: false; reason: SeatUnavailableReason }

export interface ChatGptCredentialSource {
  readonly mode: ChatGptCredentialMode
  /** Every seat the source knows, eligible or not. */
  seats(model?: string): ChatGptSeatView[]
  /** Seats that may serve `model` now, best first. */
  candidateSeats(model?: string): string[]
  /**
   * Seats held back ONLY because the owner recorded their plan quota as spent,
   * in the owner's order. They can still serve on purchased credits, which is
   * the backend's call to make (it knows the balances); absent when the source
   * records no such state.
   */
  reserveSeats?(model?: string): string[]
  /**
   * The seat's current access token. `reread: true` bypasses any cache - it is
   * how the backend asks "has the owner rotated this token since?" after a 401.
   * `spendCredits: true` lets a seat whose plan quota is recorded as spent
   * through, because the turn is meant to be paid for with credits.
   */
  credentials(seat: string, options?: { reread?: boolean; model?: string; spendCredits?: boolean }): Promise<SeatCredential>
  /** Whether any request could be served right now (lease held, store readable). */
  isServing(): boolean
  /** The pool as the read-only usage service expects it. */
  usagePool(): CodexPoolResult
  /** What to tell a client when every seat was unavailable for these reasons. */
  describeUnavailable(reasons: ReadonlySet<SeatUnavailableReason>): string
  /** Take whatever authority this mode needs. No-op for follow-external. */
  acquire(): Promise<void>
  release(): void
  /**
   * owned only: file a freshly signed-in seat (or a seat signed in again)
   * under the writer lease. Throws when this process does not hold it.
   */
  connectAccount?(account: ChatGptConnectedAccount): void
  /**
   * owned only: delete a seat and its credentials under the writer lease, so
   * nothing renews or serves it again. False when the store had no such seat;
   * throws when this process does not hold the lease.
   */
  removeAccount?(seat: string): boolean
  /** owned only: renew one seat's access token now, through the same single-exchange path a request uses. */
  refreshSeat?(seat: string): Promise<RefreshOutcome>
  /**
   * owned only: renew the seat most overdue for renewal (owned.ts
   * `renewalDueAt`), whether or not any work is sent to it. At most one
   * exchange per call; a call made while one runs gets that one's result.
   */
  renewDue?(): Promise<ChatGptRenewalPass>
  /**
   * owned only: chatgpt.com refused the seat's access token in a read or
   * request that started at `observedAt`. Its refresh token may still be good,
   * so the renewal pass renews the seat at once, then backs off while each
   * renewed token is refused too (owned.ts `ACCESS_REFUSAL_RETRY_MS`).
   */
  accessRefused?(seat: string, observedAt: number): void
  /** owned only: chatgpt.com accepted the seat's access token in a read that started at `observedAt`. */
  accessAccepted?(seat: string, observedAt: number): void
  /**
   * owned only: resolves once every token exchange already dispatched has
   * recorded its result. Shutdown awaits it before `release`.
   */
  settle?(): Promise<void>
}

/** What one `renewDue` call found and did. */
export interface ChatGptRenewalPass {
  /** Every seat due for renewal, most overdue first. */
  due: string[]
  /** The exchange made for the first of them, or null when none was made. */
  outcome: RefreshOutcome | null
}

/** What an interactive sign-in hands the owned store. */
export interface ChatGptConnectedAccount {
  accountUserId: string
  accountId: string
  email: string | null
  refreshToken: string
  accessToken: string
  expiresAt: number | null
}
