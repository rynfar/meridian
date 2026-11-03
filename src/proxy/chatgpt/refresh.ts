/**
 * Exchanging a ChatGPT refresh token, as the only process allowed to.
 *
 * A refresh token is spent by being used, and its replacement exists nowhere
 * but in the response. So the failure this module is built around is not a
 * failed refresh - it is a SUCCESSFUL one whose replacement was never written
 * down. That account is then unreachable by any amount of retrying, and only
 * an interactive login brings it back.
 *
 * Three rules follow, and every branch below is one of them:
 *
 *   PROVE YOU CAN WRITE BEFORE YOU SPEND. The intent to exchange is committed
 *   to disk first. A process that cannot record the result never dispatches.
 *
 *   COMMIT BEFORE YOU RETURN. A caller can only obtain the new access token
 *   from a write that already reached disk, so there is no window in which the
 *   rotated token lives only in memory.
 *
 *   NEVER RETRY WHAT MIGHT HAVE BEEN SPENT. If a dispatched exchange's outcome
 *   cannot be established, the stamp survives and every later attempt reports
 *   the account as needing a human. Retrying is what converts "we may have
 *   lost the replacement" into a reused token and a dead account.
 *
 * The stamp is cleared only by the commit that records a result, or when the
 * provider states it declined to process the grant at all. That asymmetry is
 * deliberate: a 429 must not brand an account, and an unexplained silence must.
 */

import { WriterLeaseRequiredError, type ChatGptCredentialStore } from "./credentials"
import { WriterLeaseLostError } from "./lease"

export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token"
/** The Codex CLI's OAuth client. Logins and refreshes must use the same one. */
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
/** An exchange that has not answered by now is abandoned, so a stamp older than this belongs to no exchange still out. */
export const EXCHANGE_TIMEOUT_MS = 15_000

export type RequiresReauthReason =
  /** The provider processed the grant and refused it. */
  | "rejected"
  /** An earlier exchange was dispatched and its result never recorded. */
  | "interrupted"
  /** This exchange was dispatched and its result could not be established. */
  | "unverifiable"

export type UnavailableReason =
  | "unknown-account"
  | "no-write-authority"
  /** The provider stated it declined to process the grant, so the token is intact. */
  | "provider-unavailable"

export type RefreshOutcome =
  | { status: "refreshed"; accountUserId: string; accessToken: string; expiresAt: number }
  | {
    status: "requires-reauth"
    accountUserId: string
    reason: RequiresReauthReason
    /** Which refusal, or which failed status, in this module's words. Absent when the provider named neither. */
    cause?: string
  }
  | { status: "unavailable"; accountUserId: string; reason: UnavailableReason }

/**
 * The refusals the Codex CLI itself tells apart, keyed by the provider's code.
 * Only the value is ever emitted, so a cause cannot carry the provider's text.
 */
const REFUSAL_CAUSES = new Map([
  ["refresh_token_expired", "refresh token expired"],
  ["refresh_token_reused", "refresh token already used"],
  ["refresh_token_invalidated", "refresh token revoked"],
])

/** The cause a refusal names, read where the Codex CLI reads it: `error.code`, an `error` string, or a top-level `code`. */
function refusalCause(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined
  const { error, code } = body as Record<string, unknown>
  const nested = typeof error === "object" && error !== null ? (error as Record<string, unknown>).code : undefined
  const named = typeof error === "string" ? error : typeof nested === "string" ? nested : code
  return typeof named === "string" ? REFUSAL_CAUSES.get(named.toLowerCase()) : undefined
}

/** Narrower than `typeof fetch` so a test double is an ordinary function. */
export type TokenExchangeFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ChatGptRefresherOptions {
  /** Carries the writer lease. A store without one refuses every write, which is what stops the dispatch. */
  store: ChatGptCredentialStore
  fetchImpl?: TokenExchangeFetch
  now?: () => number
}

export interface ChatGptRefresher {
  refreshAccount(accountUserId: string): Promise<RefreshOutcome>
  /**
   * Resolves once every exchange already dispatched has recorded its result.
   * Shutdown waits for it before giving up the lease: an exchange cut off
   * after spending its refresh token leaves the seat needing a sign-in.
   */
  settle(): Promise<void>
  /** Whether an exchange for this seat is out right now, from this process. */
  exchanging(accountUserId: string): boolean
}

interface TokenExchangeResult {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}

function parseTokenResponse(value: unknown): TokenExchangeResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const accessToken = body.access_token
  const expiresIn = body.expires_in
  if (typeof accessToken !== "string" || accessToken.length === 0) return null
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null
  const rotated = body.refresh_token
  return {
    accessToken,
    // Absent means the provider kept the existing token alive, matching the
    // reference implementation's `json.refresh_token ?? refreshToken`.
    refreshToken: typeof rotated === "string" && rotated.length > 0 ? rotated : null,
    expiresIn,
  }
}

async function discardBody(response: Response): Promise<void> {
  // Drained so the connection can be reused, and deliberately not read into
  // any message: an OAuth error body quotes the token back at us.
  try {
    await response.text()
  } catch (error) {
    console.error("[chatgpt] draining a token-endpoint response failed:", (error as Error).message)
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function createChatGptRefresher(options: ChatGptRefresherOptions): ChatGptRefresher {
  const { store } = options
  const exchangeFetch: TokenExchangeFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const inflight = new Map<string, Promise<RefreshOutcome>>()

  const reportUnrefreshable = (
    accountUserId: string,
    reason: RequiresReauthReason,
    cause?: string,
  ): RefreshOutcome => {
    // Said out loud on purpose. An account that can no longer be refreshed is
    // a thing only a person can fix, and an instance that keeps it to itself
    // goes on serving until the access token expires and then falls over. The
    // reason is this module's own vocabulary, never the provider's wording.
    const detail = cause ? `${reason}: ${cause}` : reason
    console.error(`[chatgpt] account ${accountUserId} needs an interactive login (${detail})`)
    return { status: "requires-reauth", accountUserId, reason, ...(cause ? { cause } : {}) }
  }

  const stampExchange = (accountUserId: string, startedAt: number | null): boolean => {
    try {
      store.commitAccount(accountUserId, current => {
        if (!current) throw new Error(`[chatgpt] account ${accountUserId} disappeared mid-exchange`)
        return { ...current, exchangeStartedAt: startedAt }
      })
      return true
    } catch (error) {
      if (error instanceof WriterLeaseRequiredError || error instanceof WriterLeaseLostError) return false
      throw error
    }
  }

  const exchangeOnce = async (accountUserId: string): Promise<RefreshOutcome> => {
    const account = store.readAccount(accountUserId)
    if (!account) return { status: "unavailable", accountUserId, reason: "unknown-account" }
    if (account.exchangeStartedAt !== null) return reportUnrefreshable(accountUserId, "interrupted")

    // Write authority is proven before the token leaves this process. Spending
    // one and only then discovering the replacement cannot be recorded loses
    // the account just as completely as deleting the file would.
    if (!stampExchange(accountUserId, now())) {
      return { status: "unavailable", accountUserId, reason: "no-write-authority" }
    }

    let response: Response
    try {
      response = await exchangeFetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
        }).toString(),
        // A refresh token must never be replayed to a redirect target.
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      })
    } catch {
      return reportUnrefreshable(accountUserId, "unverifiable")
    }

    if (response.status === 429 || response.status >= 500) {
      // A gateway/status failure does not prove the grant was unconsumed.
      // Keep durable intent so neither this process nor its successor replays it.
      await discardBody(response)
      return reportUnrefreshable(accountUserId, "unverifiable", `HTTP ${response.status}`)
    }

    if (!response.ok) {
      return reportUnrefreshable(accountUserId, "rejected", refusalCause(await readJson(response)))
    }

    const parsed = parseTokenResponse(await readJson(response))
    if (!parsed) return reportUnrefreshable(accountUserId, "unverifiable")

    const accessToken = parsed.accessToken
    const expiresAt = now() + parsed.expiresIn * 1000
    let superseded = false
    const committed = store.commitAccount(accountUserId, current => {
      if (!current) throw new Error(`[chatgpt] account ${accountUserId} disappeared mid-exchange`)
      // A sign-in finished while this exchange was out and replaced the chain
      // it spent from. That login is the newer one, so this result is dropped
      // rather than written over it.
      if (current.refreshToken !== account.refreshToken) {
        superseded = true
        return current
      }
      return {
        ...current,
        refreshToken: parsed.refreshToken ?? current.refreshToken,
        accessToken,
        expiresAt,
        tokenRotatedAt: parsed.refreshToken ? now() : current.tokenRotatedAt,
        exchangeStartedAt: null,
      }
    })
    if (superseded) {
      console.log(`[chatgpt] account ${accountUserId} was signed in again while it was being renewed; keeping the new sign-in`)
      return committed.accessToken && committed.expiresAt !== null
        ? { status: "refreshed", accountUserId, accessToken: committed.accessToken, expiresAt: committed.expiresAt }
        : { status: "unavailable", accountUserId, reason: "unknown-account" }
    }
    // One line per renewal, so the operator can see a refresh happen. The
    // seat id is an identity, not a credential.
    console.log(`[chatgpt] account ${accountUserId} refreshed${parsed.refreshToken ? " (refresh token rotated)" : ""}; access token valid until ${new Date(expiresAt).toISOString()}`)
    return { status: "refreshed", accountUserId, accessToken, expiresAt }
  }

  return {
    refreshAccount(accountUserId) {
      // Two callers noticing one expiry must produce ONE exchange. This is the
      // same shape as tokenRefresh.ts's in-process map, and it is only sound
      // here because the store underneath it holds a cross-process lease -
      // that map alone protects nothing against a second process.
      const existing = inflight.get(accountUserId)
      if (existing) return existing
      const attempt = exchangeOnce(accountUserId).finally(() => { inflight.delete(accountUserId) })
      inflight.set(accountUserId, attempt)
      return attempt
    },

    async settle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()])
    },

    exchanging(accountUserId) {
      return inflight.has(accountUserId)
    },
  }
}
