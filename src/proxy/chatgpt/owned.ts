/**
 * owned: serve from Meridian's own ChatGPT store, with refresh authority.
 *
 * Seats come from the store (`MERIDIAN_CHATGPT_STORE_PATH`, default
 * `~/.config/meridian/chatgpt-accounts.json`), filled by the importer - never
 * from Claude's ProfileConfig, which has no place for these credentials.
 *
 * THE LEASE IS TAKEN SEPARATELY, AND LATER. Construction happens inside
 * `createProxyServer`, which tests call constantly and which no embedder
 * expects to seize a machine-wide resource. `acquire` is the explicit step the
 * owned lifecycle performs at startup, and it fails rather than degrades:
 * two processes exchanging one single-use refresh token is unrecoverable.
 * Without the lease `credentials` answers `no_authority` for every seat.
 *
 * UNDER MERIDIAN_CREDENTIALS_READONLY NO LEASE IS TAKEN. The instance serves
 * each seat's access token as the store holds it, re-read on every request, so
 * it follows the renewals of the instance that owns the store. It never
 * renews, signs in or removes a seat, and a seat whose token has run out is
 * unavailable until the owner renews it.
 */
import type { CodexPoolResult } from "../codex/pool"
import { isCredentialsReadOnly } from "../credentialsMode"
import { decodeCodexToken } from "../codex/token"
import { createChatGptCredentialStore, type ChatGptAccount, type ChatGptCredentialStore } from "./credentials"
import { acquireWriterLease, type WriterLease } from "./lease"
import { chatGptLockPath } from "./paths"
import { createChatGptRefresher, EXCHANGE_TIMEOUT_MS, type ChatGptRefresher, type RefreshOutcome, type TokenExchangeFetch } from "./refresh"
import type { ChatGptCredentialSource, ChatGptRenewalPass, ChatGptSeatView } from "./source"

/** Renew this far ahead of expiry, matching the Claude path's own margin. */
const ACCESS_TOKEN_BUFFER_MS = 5 * 60_000

/**
 * A failed exchange leaves its seat needing a sign-in, so after one the
 * provider failed, renewing ahead of expiry waits this long before costing
 * another seat the same way. A seat falls due two days before its token runs
 * out, which leaves room for several waits.
 */
const RENEWAL_PAUSE_MS = 6 * 60 * 60_000

/**
 * chatgpt.com can refuse a seat's access token while its refresh token is
 * still good, and a renewal brings the seat back. A refused token is renewed
 * at once; when the token that renewal brought is refused too, the next one
 * waits these steps after it, the last repeating for as long as the refresh
 * token is accepted. Only a refused or unverifiable refresh, which leaves the
 * seat's stamp in place, ends it at a sign-in.
 */
export const ACCESS_REFUSAL_RETRY_MS: readonly number[] = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000]

interface AccessRefusal {
  /** The latest moment chatgpt.com was seen refusing the seat's access token. */
  refusedAt: number
  /** Renewals made because of it. */
  attempts: number
  lastAttemptAt: number | null
  /** When the next renewal is due; null while waiting to see the last renewal's token accepted or refused. */
  nextAt: number | null
}

const retryStep = (attempts: number): number =>
  ACCESS_REFUSAL_RETRY_MS[Math.min(Math.max(attempts - 1, 0), ACCESS_REFUSAL_RETRY_MS.length - 1)]!

/** When the seat's current access token was issued, as far as anything says. */
function tokenIssuedAt(account: Pick<ChatGptAccount, "accessToken" | "tokenRotatedAt">): number {
  return decodeCodexToken(account.accessToken)?.issuedAt ?? account.tokenRotatedAt ?? 0
}

/**
 * When a seat's access token falls due for renewal: 80% into its life, which
 * for ChatGPT's ten-day tokens is the eighth day, the age at which the Codex
 * CLI renews its own. A token that does not say when it was issued falls due
 * when a request would renew it, five minutes before expiry: a longer fixed
 * margin would make a short-lived token due again the moment it was renewed.
 * A seat with no token or no expiry is due now.
 */
export function renewalDueAt(account: Pick<ChatGptAccount, "accessToken" | "expiresAt">): number {
  if (!account.accessToken || account.expiresAt === null) return 0
  const issuedAt = decodeCodexToken(account.accessToken)?.issuedAt ?? null
  if (issuedAt === null) return account.expiresAt - ACCESS_TOKEN_BUFFER_MS
  return Math.round(issuedAt + (account.expiresAt - issuedAt) * 0.8)
}

/**
 * Looks for a seat due for renewal at once and then every `intervalMs`, until
 * stopped. `stop` resolves once a renewal still out has settled: it may have
 * spent its seat's refresh token, and only the lease still held can record the
 * token that replaced it.
 */
export function startRenewalSchedule(renewDue: () => Promise<unknown>, intervalMs = 60_000): { stop(): Promise<void> } {
  let settled: Promise<void> = Promise.resolve()
  const look = () => {
    settled = renewDue().then(() => undefined, error => {
      console.error(`[chatgpt] renewing a seat ahead of expiry failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  look()
  const timer = setInterval(look, intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      return settled
    },
  }
}

export interface OwnedSourceOptions {
  storePath: string
  leaseWaitMs?: number
  staleMs?: number
  heartbeatMs?: number
  /** Token-endpoint fetch, injectable for tests. */
  fetchImpl?: TokenExchangeFetch
  now?: () => number
  /**
   * Build the source even over an empty store. Set when the operator asked for
   * `owned` explicitly: the instance then takes the lease at startup and waits
   * for a seat to be signed in through its web UI.
   */
  allowEmpty?: boolean
  /** Serve without refresh authority (MERIDIAN_CREDENTIALS_READONLY); read from the environment when absent. */
  readOnly?: boolean
}

const READ_ONLY_MESSAGE = "MERIDIAN_CREDENTIALS_READONLY=1 — this instance may not modify credentials."

export const CHATGPT_NO_ACCOUNT_MESSAGE = "No ChatGPT account is connected to this Meridian. "
  + "Connect one in its web UI: open /profiles, name the profile under \"Add a profile\", then choose \"Connect with ChatGPT\"."

/** Undefined when the store holds no accounts and `allowEmpty` is unset: nothing to own, nothing to serve. */
export function createOwnedCredentialSource(options: OwnedSourceOptions): ChatGptCredentialSource | undefined {
  const { storePath } = options
  // A store that exists but cannot be read throws here and stops startup.
  // Guessing it is empty would silently turn an owning instance into one that
  // routes GPT names back to Claude.
  const empty = createChatGptCredentialStore({ path: storePath }).readAccounts().length === 0
  if (empty && !options.allowEmpty) return undefined

  const now = options.now ?? Date.now
  const readOnly = options.readOnly ?? isCredentialsReadOnly()
  const reader = createChatGptCredentialStore({ path: storePath })
  let lease: WriterLease | undefined
  let store: ChatGptCredentialStore | undefined
  let refresher: ChatGptRefresher | undefined
  let renewal: Promise<ChatGptRenewalPass> | undefined
  let renewalPausedUntil = 0
  const accessRefusals = new Map<string, AccessRefusal>()

  const holdsLease = (): boolean => {
    if (!lease) return false
    try {
      lease.assertValid()
      return true
    } catch {
      return false
    }
  }

  // A seat's refusal as it stands. A token renewed since the last refusal by
  // any path - a request near expiry, Renew now - counts as the attempt.
  const refusalOf = (account: ChatGptAccount): AccessRefusal | undefined => {
    const known = accessRefusals.get(account.accountUserId)
    if (!known) return undefined
    const issuedAt = tokenIssuedAt(account)
    if (known.nextAt !== null && issuedAt > known.refusedAt) {
      known.attempts++
      known.lastAttemptAt = issuedAt
      known.nextAt = null
    }
    return known
  }

  const afterRefusalRenewal = (seat: string, outcome: RefreshOutcome): void => {
    const known = accessRefusals.get(seat)
    if (!known) return
    if (outcome.status === "requires-reauth" || (outcome.status === "unavailable" && outcome.reason === "unknown-account")) {
      accessRefusals.delete(seat)
      return
    }
    known.attempts++
    known.lastAttemptAt = now()
    known.nextAt = outcome.status === "refreshed" ? null : now() + retryStep(known.attempts)
  }

  // One exchange per pass, for the seat most overdue, so renewals never go out
  // as a burst and a provider failure costs one seat its sign-in, not every
  // seat that happened to be due with it.
  const renewMostOverdue = async (): Promise<ChatGptRenewalPass> => {
    const renewer = refresher
    if (!renewer || !holdsLease() || now() < renewalPausedUntil) return { due: [], outcome: null }
    const due = reader.readAccounts()
      .filter(account => account.exchangeStartedAt === null)
      .map(account => {
        const scheduled = renewalDueAt(account)
        const refusal = refusalOf(account)
        const retry = refusal?.nextAt ?? Infinity
        return { seat: account.accountUserId, at: Math.min(scheduled, retry), refusal: retry <= now() ? refusal : undefined }
      })
      .filter(candidate => candidate.at <= now())
      .sort((a, b) => a.at - b.at)
    const next = due[0]
    if (!next) return { due: [], outcome: null }
    if (next.refusal) {
      console.log(`[chatgpt] renewing account ${next.seat}: chatgpt.com refused its access token (attempt ${next.refusal.attempts + 1}; ${due.length - 1} more due)`)
    } else {
      console.log(`[chatgpt] renewing account ${next.seat} ahead of expiry (due since ${new Date(next.at).toISOString()}; ${due.length - 1} more due)`)
    }
    const outcome = await renewer.refreshAccount(next.seat)
    afterRefusalRenewal(next.seat, outcome)
    if (outcome.status === "requires-reauth" && outcome.reason === "unverifiable") {
      renewalPausedUntil = now() + RENEWAL_PAUSE_MS
      console.error(`[chatgpt] renewing ahead of expiry paused until ${new Date(renewalPausedUntil).toISOString()}: the provider failed an exchange`)
    }
    return { due: due.map(candidate => candidate.seat), outcome }
  }

  // A stamp marks an exchange that went out. While it is still out the seat is
  // as it was before - its token unchanged - and only a stamp no exchange will
  // clear means the seat needs a sign-in. The holder of the lease knows which
  // exchanges it has out; any other reader (a read-only instance) can tell
  // only by the stamp's age, as no exchange outlives its timeout.
  const exchangeOut = (account: ChatGptAccount): boolean => {
    if (account.exchangeStartedAt === null) return false
    if (refresher && holdsLease()) return refresher.exchanging(account.accountUserId)
    // A stamp from the future (another host's clock ahead of ours) is not
    // trusted to be in flight.
    const age = now() - account.exchangeStartedAt
    return age >= 0 && age < EXCHANGE_TIMEOUT_MS + 5_000
  }

  return {
    mode: "owned",

    seats() {
      return reader.readAccounts().map((account, index): ChatGptSeatView => {
        const pending = account.exchangeStartedAt !== null && !exchangeOut(account)
        const retryAt = pending ? null : refusalOf(account)?.nextAt ?? null
        return {
          id: account.accountUserId,
          email: account.email,
          planType: decodeCodexToken(account.accessToken)?.planType ?? null,
          eligible: !pending,
          ...(pending ? { reason: "requires_reauth" as const } : {}),
          expiresAt: account.expiresAt,
          ...(retryAt !== null ? { renewalRetryAt: retryAt } : {}),
          active: index === 0,
          storeIndex: index,
        }
      })
    },

    candidateSeats() {
      return reader.readAccounts().map(account => account.accountUserId)
    },

    async credentials(seat) {
      if (readOnly) {
        const account = reader.readAccount(seat)
        if (!account) return { ok: false, reason: "unknown" }
        if (account.accessToken && account.expiresAt !== null && account.expiresAt - now() > ACCESS_TOKEN_BUFFER_MS) {
          return { ok: true, account: { accountUserId: seat, accountId: account.accountId, accessToken: account.accessToken } }
        }
        return { ok: false, reason: "no_authority" }
      }
      // Checked here rather than only at acquisition: a holder can be
      // displaced after a crash-recovery window, and the moment before a token
      // is spent is the only one at which discovering that is still useful.
      if (!store || !refresher || !holdsLease()) return { ok: false, reason: "no_authority" }
      const account = store.readAccount(seat)
      if (!account) return { ok: false, reason: "unknown" }
      if (account.accessToken && account.expiresAt !== null && account.expiresAt - now() > ACCESS_TOKEN_BUFFER_MS) {
        return { ok: true, account: { accountUserId: seat, accountId: account.accountId, accessToken: account.accessToken } }
      }
      const outcome = await refresher.refreshAccount(seat)
      if (outcome.status === "refreshed") {
        return { ok: true, account: { accountUserId: seat, accountId: account.accountId, accessToken: outcome.accessToken } }
      }
      return { ok: false, reason: outcome.status === "requires-reauth" ? "requires_reauth" : "no_authority" }
    },

    isServing: () => readOnly || holdsLease(),

    usagePool(): CodexPoolResult {
      // Read-only, and re-read so the dashboard observes token rotation.
      return {
        error: null,
        pool: {
          path: storePath,
          accounts: reader.readAccounts().map(account => ({
            accountUserId: account.accountUserId,
            accountId: account.accountId,
            email: account.email,
            accessToken: account.accessToken,
            expiresAt: account.expiresAt,
            organizationId: null,
            accountLabel: null,
            planType: decodeCodexToken(account.accessToken)?.planType ?? null,
            enabled: true,
          })),
        },
      }
    },

    describeUnavailable(reasons) {
      if (reader.readAccounts().length === 0) return CHATGPT_NO_ACCOUNT_MESSAGE
      if (readOnly && reasons.has("no_authority")) {
        return "This Meridian is read-only (MERIDIAN_CREDENTIALS_READONLY=1): it serves its ChatGPT accounts' access tokens "
          + "but never renews them, and the instance that owns its store has not renewed these."
      }
      if (reasons.has("no_authority")) return "This Meridian does not hold refresh authority for its ChatGPT accounts."
      if (reasons.has("requires_reauth")) return "Every ChatGPT account this Meridian owns needs an interactive login."
      return "Every ChatGPT account this Meridian owns is spent or unavailable."
    },

    async acquire() {
      if (lease || readOnly) return
      const acquired = await acquireWriterLease({
        lockPath: chatGptLockPath(storePath),
        ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        waitMs: options.leaseWaitMs ?? 0,
      })
      lease = acquired
      store = createChatGptCredentialStore({ path: storePath, lease: acquired })
      refresher = createChatGptRefresher({ store, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now })
    },

    release() {
      const held = lease
      lease = undefined
      store = undefined
      refresher = undefined
      held?.release()
    },

    connectAccount(account) {
      if (readOnly) throw new Error(READ_ONLY_MESSAGE)
      if (!store || !holdsLease()) {
        throw new Error("This Meridian does not hold the writer lease for its ChatGPT store, so it cannot save a sign-in.")
      }
      // A seat signed in again replaces its whole credential chain, and with
      // it any interrupted-exchange stamp: the new refresh token was issued by
      // this login and has never been spent.
      store.commitAccount(account.accountUserId, current => ({
        accountUserId: account.accountUserId,
        accountId: account.accountId,
        email: account.email ?? current?.email ?? null,
        refreshToken: account.refreshToken,
        accessToken: account.accessToken,
        expiresAt: account.expiresAt,
        tokenRotatedAt: now(),
        exchangeStartedAt: null,
      }))
    },

    removeAccount(seat) {
      if (readOnly) throw new Error(READ_ONLY_MESSAGE)
      if (!store || !holdsLease()) {
        throw new Error("This Meridian does not hold the writer lease for its ChatGPT store, so it cannot remove a seat.")
      }
      return store.removeAccounts([seat]).length > 0
    },

    async refreshSeat(seat) {
      if (!refresher || !holdsLease()) return { status: "unavailable", accountUserId: seat, reason: "no-write-authority" }
      return refresher.refreshAccount(seat)
    },

    renewDue() {
      renewal ??= renewMostOverdue().finally(() => { renewal = undefined })
      return renewal
    },

    accessRefused(seat, observedAt) {
      if (readOnly) return
      const account = reader.readAccount(seat)
      // A stamped seat needs a sign-in or is being renewed; a refusal read
      // before its current token was issued was about one since replaced.
      if (!account || account.exchangeStartedAt !== null || observedAt < tokenIssuedAt(account)) return
      const known = refusalOf(account)
      if (!known) {
        accessRefusals.set(seat, { refusedAt: observedAt, attempts: 0, lastAttemptAt: null, nextAt: now() })
        console.log(`[chatgpt] chatgpt.com refused account ${seat}'s access token; renewing it`)
        return
      }
      known.refusedAt = Math.max(known.refusedAt, observedAt)
      if (known.nextAt !== null) return
      known.nextAt = Math.max(now(), (known.lastAttemptAt ?? now()) + retryStep(known.attempts))
      console.log(`[chatgpt] chatgpt.com refused account ${seat}'s renewed access token too; renewing again at ${new Date(known.nextAt).toISOString()}`)
    },

    accessAccepted(seat, observedAt) {
      const known = accessRefusals.get(seat)
      if (!known || observedAt <= (known.lastAttemptAt ?? known.refusedAt)) return
      accessRefusals.delete(seat)
      if (known.attempts > 0) console.log(`[chatgpt] chatgpt.com accepts account ${seat}'s access token again`)
    },

    async settle() {
      await refresher?.settle()
    },
  }
}
