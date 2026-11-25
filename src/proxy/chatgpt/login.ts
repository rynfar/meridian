/**
 * Signing a ChatGPT seat into Meridian's own store, from the web UI.
 *
 * Both flows are the Codex CLI's own, with its client id, endpoints and
 * parameters, so a sign-in through Meridian is indistinguishable from
 * `codex login` to the provider. Meridian never invents a redirect of its own:
 * a redirect to Meridian's public address would say exactly which client this
 * is not.
 *
 * DEVICE CODE (`codex login --device-auth`) is the path for a browser that is
 * not on this host, which is the normal case behind a vhost. Meridian asks
 * auth.openai.com for a one-time code, the page shows it with a link to
 * auth.openai.com/codex/device, and Meridian polls until the person has
 * entered it, then exchanges the authorization code it is handed.
 *
 * BROWSER REDIRECT (`codex login`) works only for a browser on this host: the
 * client's registered redirect is http://127.0.0.1:1455/auth/callback, so
 * while such a sign-in is open this process listens there and nowhere else,
 * and stops the moment none is open. A browser elsewhere ends on an address
 * that cannot load; pasting that address back into the page finishes the
 * sign-in, because it carries the one-time code and the state that binds the
 * code to the sign-in that asked for it.
 *
 * WHY THE SERVER, AND NOT A CLI. The store is written only under the writer
 * lease, and the running instance holds that lease for as long as it runs. A
 * separate login command could only write while the instance is stopped, and
 * one that wrote anyway would be the second writer this whole design forbids.
 *
 * A BROWSER ON ANOTHER MACHINE CAN STILL COME BACK BY ITSELF when something
 * there relays its 1455 to this instance: while the listener is open it is
 * also registered as a public callback (oauthCallbacks.ts), listed for relays
 * and served at `/callback/<id>/auth/callback`.
 *
 * Nothing here logs a code, a verifier, a user code or a token. The exchange's
 * result goes straight into `connect`, which commits it under the lease.
 */

import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { decodeCodexToken } from "../codex/token"
import type { OAuthCallbackHandle, OAuthCallbackRegistry, OAuthCallbackRequest } from "../oauthCallbacks"
import { CHATGPT_OAUTH_CLIENT_ID, CHATGPT_TOKEN_URL, type TokenExchangeFetch } from "./refresh"
import type { ChatGptConnectedAccount } from "./source"

const ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const DEVICE_USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`
export const CHATGPT_DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
export const CHATGPT_LOGIN_CALLBACK_PORT = 1455
export const CHATGPT_LOGIN_CALLBACK_PATH = "/auth/callback"
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"
const ORIGINATOR = "codex_cli_rs"
const LOGIN_TTL_MS = 10 * 60_000
/** The CLI gives up on a device code after fifteen minutes; so does the code. */
const DEVICE_TTL_MS = 15 * 60_000
const DEVICE_MIN_INTERVAL_MS = 1_000
const DEVICE_DEFAULT_INTERVAL_MS = 5_000
const MAX_OPEN_LOGINS = 4
const EXCHANGE_TIMEOUT_MS = 15_000

export type ChatGptLoginState =
  | { status: "waiting"; expiresAt: number }
  | { status: "exchanging"; expiresAt: number }
  | { status: "completed"; accountUserId: string; email: string | null }
  | { status: "failed"; message: string }

export type ChatGptLoginCompletion =
  | { ok: true; accountUserId: string; email: string | null }
  | { ok: false; status: number; code: string; message: string; retryable?: boolean }

export interface ChatGptLoginStart {
  connectId: string
  authorizeUrl: string
  /** Whether this process is listening for the redirect; false means the address must be pasted back. */
  loopback: boolean
  expiresAt: number
}

export type ChatGptDeviceStart =
  | { ok: true; connectId: string; userCode: string; verificationUrl: string; expiresAt: number }
  | { ok: false; status: number; code: string; message: string }

/** A started loopback listener. */
export interface LoopbackListener {
  close(): void
}

export type LoopbackHandler = (query: URLSearchParams) => Promise<{ status: number; html: string }>

/** What the caller attached to a sign-in when starting it, handed back with the account. */
export interface ChatGptLoginContext {
  name: string | null
  /** The seat this sign-in renews, when it was started from that seat's card; null for a new seat. */
  seat: string | null
}

/**
 * The seat a sign-in must come back as. A re-login started from a seat's card
 * is refused when ChatGPT hands back a different account or workspace, so the
 * person who picked the wrong account learns that instead of finding a second
 * seat filed under the wrong name.
 */
export interface ChatGptExpectedSeat {
  seat: string
  /** How the page names the seat, for the refusal. */
  label: string
}

export interface ChatGptLoginOptions {
  /** Commits the seat under the writer lease; throws when that is impossible. */
  connect(account: ChatGptConnectedAccount, context: ChatGptLoginContext): void
  /** Renders the page the loopback redirect lands on. */
  renderPage(result: { ok: true; email: string | null; returnTo: string | null } | { ok: false; message: string; returnTo: string | null }): string
  fetchImpl?: TokenExchangeFetch
  now?: () => number
  /** Binds the redirect listener. Resolves null when the port cannot be bound. */
  listen?: (handler: LoopbackHandler) => Promise<LoopbackListener | null>
  /** Schedules the next device-code poll; tests drive it by hand. */
  schedule?: (run: () => void, ms: number) => { cancel(): void }
  log?: (line: string) => void
  /** Publishes the redirect listener at `/callback/<id>/...` for a relay. */
  callbacks?: OAuthCallbackRegistry
}

export interface ChatGptLogin {
  start(options?: { returnTo?: string | null; name?: string | null; expect?: ChatGptExpectedSeat | null }): Promise<ChatGptLoginStart>
  startDevice(options?: { name?: string | null; expect?: ChatGptExpectedSeat | null }): Promise<ChatGptDeviceStart>
  status(connectId: string): ChatGptLoginState | undefined
  /** Finish a browser-redirect sign-in from the address the browser landed on, pasted into the page. */
  complete(connectId: string, pasted: string): Promise<ChatGptLoginCompletion>
  /** Abandon a sign-in now: stop polling, and close the redirect listener if nothing else needs it. */
  cancel(connectId: string): boolean
  /**
   * Stop every sign-in and close the redirect listener. Resolves once a code
   * exchange already under way has saved its seat or failed, so shutdown can
   * keep the writer lease until then.
   */
  close(): Promise<void>
}

interface PendingLogin {
  id: string
  kind: "redirect" | "device"
  state: string
  verifier: string
  expiresAt: number
  returnTo: string | null
  name: string | null
  expect: ChatGptExpectedSeat | null
  outcome: ChatGptLoginState
  stopPolling?: () => void
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

/** The listener the real server uses: loopback only, and only the callback path. */
export function listenOnLoopback(handler: LoopbackHandler, port = CHATGPT_LOGIN_CALLBACK_PORT): Promise<LoopbackListener | null> {
  return new Promise(resolve => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method !== "GET" || url.pathname !== CHATGPT_LOGIN_CALLBACK_PATH) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found")
        return
      }
      handler(url.searchParams).then(
        page => { response.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page.html) },
        (error: unknown) => {
          console.error("[chatgpt] sign-in callback failed:", (error as Error).message)
          response.writeHead(500, { "content-type": "text/plain" }).end("Sign-in failed")
        },
      )
    })
    server.once("error", (error: Error) => {
      console.error(`[chatgpt] cannot listen for the sign-in redirect on 127.0.0.1:${port} (${(error as NodeJS.ErrnoException).code ?? error.message}); the address must be pasted back here unless a relay brings it back`)
      resolve(null)
    })
    server.listen(port, "127.0.0.1", () => {
      server.unref()
      resolve({ close: () => { server.close(); server.closeAllConnections?.() } })
    })
  })
}

/** The `code` and `state` from a pasted callback address, or from its query string alone. */
export function parseCallbackInput(pasted: string): URLSearchParams | null {
  const text = pasted.trim()
  if (!text) return null
  let query: URLSearchParams
  try {
    query = text.includes("://") ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ""))
  } catch {
    return null
  }
  return query.has("code") || query.has("error") ? query : null
}

function emailFrom(idToken: string | undefined, accessToken: string): string | null {
  for (const token of [idToken, accessToken]) {
    const payload = token?.split(".")[1]
    if (!payload) continue
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
      const profile = claims["https://api.openai.com/profile"] as Record<string, unknown> | undefined
      const email = typeof claims.email === "string" ? claims.email : profile?.email
      if (typeof email === "string" && email) return email
    } catch {
      continue
    }
  }
  return null
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

let listenOverride: ((handler: LoopbackHandler) => Promise<LoopbackListener | null>) | null = null

/** Tests only: stand in for the real 127.0.0.1:1455 listener, which a test must never bind. */
export function __setChatGptLoginListenOverride(listen: typeof listenOverride): void {
  listenOverride = listen
}

let redirectPortOverride: number | null = null

/**
 * Tests only: redirect to another loopback port, so an end-to-end run with a
 * fake provider never touches 1455. Read when a login is created.
 */
export function __setChatGptLoginRedirectPortOverride(port: number | null): void {
  redirectPortOverride = port
}

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** setTimeout's ceiling; a longer delay fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

export function createChatGptLogin(options: ChatGptLoginOptions): ChatGptLogin {
  const now = options.now ?? Date.now
  const exchangeFetch: TokenExchangeFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const redirectPort = redirectPortOverride ?? CHATGPT_LOGIN_CALLBACK_PORT
  const redirectUri = `http://127.0.0.1:${redirectPort}${CHATGPT_LOGIN_CALLBACK_PATH}`
  const listen = options.listen ?? ((handler: LoopbackHandler) => (listenOverride ? listenOverride(handler) : listenOnLoopback(handler, redirectPort)))
  const schedule = options.schedule ?? defaultSchedule
  const log = options.log ?? ((line: string) => console.log(line))
  const logins = new Map<string, PendingLogin>()
  let listener: Promise<LoopbackListener | null> | undefined
  let callback: OAuthCallbackHandle | undefined
  let sweepTimer: ReturnType<typeof setTimeout> | undefined

  const waiting = (login: PendingLogin) => login.outcome.status === "waiting" || login.outcome.status === "exchanging"
  const redirectWaiting = () => [...logins.values()].filter(login => login.kind === "redirect" && waiting(login))

  const settle = (login: PendingLogin, outcome: ChatGptLoginState) => {
    login.outcome = outcome
    login.stopPolling?.()
    login.stopPolling = undefined
  }

  // Expiry is otherwise noticed only when the page polls; a closed tab would
  // keep the listener, its public callback and every relay open past it.
  const armSweep = () => {
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = undefined
    const earliest = Math.min(...redirectWaiting().map(login => login.expiresAt))
    if (!Number.isFinite(earliest)) return
    sweepTimer = setTimeout(sweep, Math.min(MAX_TIMER_MS, Math.max(0, earliest - now()) + 1_000))
    sweepTimer.unref?.()
  }

  const sweep = () => {
    const at = now()
    for (const [id, login] of logins) {
      if (waiting(login) && login.expiresAt <= at) settle(login, { status: "failed", message: "This sign-in expired. Start it again." })
      // A finished login is kept long enough for the page's poll to read it.
      if (!waiting(login) && login.expiresAt + LOGIN_TTL_MS <= at) logins.delete(id)
    }
    const stillWaiting = redirectWaiting().length > 0
    if (listener && !stillWaiting) {
      const closing = listener
      listener = undefined
      void closing.then(open => open?.close())
    }
    if (callback && !stillWaiting) {
      callback.close()
      callback = undefined
    }
    armSweep()
  }

  const exchanges = new Set<Promise<ChatGptLoginCompletion>>()
  const exchange = (login: PendingLogin, code: string, grant: { redirectUri: string; verifier: string }): Promise<ChatGptLoginCompletion> => {
    const running = exchangeCode(login, code, grant)
    exchanges.add(running)
    const done = () => { exchanges.delete(running) }
    running.then(done, done)
    return running
  }

  const exchangeCode = async (login: PendingLogin, code: string, grant: { redirectUri: string; verifier: string }): Promise<ChatGptLoginCompletion> => {
    login.outcome = { status: "exchanging", expiresAt: login.expiresAt }
    const fail = (status: number, codeName: string, message: string): ChatGptLoginCompletion => {
      settle(login, { status: "failed", message })
      log(`[chatgpt] sign-in failed: ${codeName}`)
      return { ok: false, status, code: codeName, message }
    }
    let response: Response
    try {
      response = await exchangeFetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: grant.redirectUri,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
          code_verifier: grant.verifier,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      })
    } catch {
      return fail(502, "exchange_unreachable", "Could not reach auth.openai.com to finish the sign-in. Start it again.")
    }
    const body = await readJsonObject(response)
    if (!response.ok) return fail(400, "exchange_refused", `ChatGPT refused the sign-in code (HTTP ${response.status}). Start the sign-in again.`)
    const accessToken = typeof body?.access_token === "string" ? body.access_token : ""
    const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : ""
    const idToken = typeof body?.id_token === "string" ? body.id_token : undefined
    if (!accessToken || !refreshToken) return fail(502, "exchange_incomplete", "ChatGPT's answer carried no refresh token, so Meridian could not keep this seat signed in.")
    const claims = decodeCodexToken(accessToken)
    const idClaims = decodeCodexToken(idToken)
    const accountUserId = claims?.accountUserId ?? idClaims?.accountUserId
    const accountId = claims?.accountId ?? idClaims?.accountId
    if (!accountUserId || !accountId) return fail(502, "no_chatgpt_seat", "This sign-in carries no ChatGPT workspace seat. Sign in with an account that has a ChatGPT plan.")
    const expiresIn = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null
    const email = emailFrom(idToken, accessToken)
    // The new tokens are dropped, never filed: saving them would add a seat
    // the person did not ask for, under the account they picked by mistake.
    if (login.expect && login.expect.seat !== accountUserId) {
      return fail(409, "wrong_account",
        `You signed in as ${email ?? "a different account"} (workspace id:${accountUserId.slice(-6)}), not as ${login.expect.label}. `
        + "Nothing was saved. Sign in again with the ChatGPT account and workspace this seat belongs to.")
    }
    try {
      options.connect({
        accountUserId,
        accountId,
        email,
        refreshToken,
        accessToken,
        expiresAt: claims?.expiresAt ?? (expiresIn === null ? null : now() + expiresIn * 1000),
      }, { name: login.name, seat: login.expect?.seat ?? null })
    } catch (error) {
      console.error("[chatgpt] could not save a signed-in seat:", (error as Error).message)
      return fail(500, "store_write_failed", `Meridian could not save the sign-in: ${(error as Error).message}`)
    }
    settle(login, { status: "completed", accountUserId, email })
    log(`[chatgpt] account ${accountUserId} signed in${email ? ` as ${email}` : ""} (${login.kind === "device" ? "device code" : "browser redirect"})`)
    return { ok: true, accountUserId, email }
  }

  const finish = async (login: PendingLogin, query: URLSearchParams): Promise<ChatGptLoginCompletion> => {
    if (login.outcome.status !== "waiting") {
      return { ok: false, status: 409, code: "already_used", message: "This sign-in has already been finished or has failed. Start it again." }
    }
    const error = query.get("error")
    if (error) {
      const message = `ChatGPT did not complete the sign-in (${error}). Start it again.`
      settle(login, { status: "failed", message })
      return { ok: false, status: 400, code: "authorization_denied", message }
    }
    const code = query.get("code")
    if (!code) return { ok: false, status: 400, code: "invalid_request", message: "That address carries no sign-in code.", retryable: true }
    return exchange(login, code, { redirectUri, verifier: login.verifier })
  }

  const handleCallback: LoopbackHandler = async query => {
    sweep()
    const state = query.get("state")
    const login = state ? [...logins.values()].find(entry => entry.kind === "redirect" && entry.state === state) : undefined
    if (!login) {
      return { status: 400, html: options.renderPage({ ok: false, message: "This sign-in is not open any more. Start it again from Meridian's Profiles page.", returnTo: null }) }
    }
    const result = await finish(login, query)
    sweep()
    return result.ok
      ? { status: 200, html: options.renderPage({ ok: true, email: result.email, returnTo: login.returnTo }) }
      : { status: result.status, html: options.renderPage({ ok: false, message: result.message, returnTo: login.returnTo }) }
  }

  // The public door opens exactly what the loopback listener serves.
  const handleRelayed = (request: OAuthCallbackRequest) =>
    request.method === "GET" && request.path === CHATGPT_LOGIN_CALLBACK_PATH ? handleCallback(request.query) : Promise.resolve(null)

  const publish = (expiresAt: number, loopback: boolean) => {
    if (!options.callbacks) return
    if (callback) {
      callback.extend(expiresAt)
      return
    }
    callback = options.callbacks.open({
      provider: "chatgpt",
      redirect: { host: "127.0.0.1", port: redirectPort, path: CHATGPT_LOGIN_CALLBACK_PATH },
      expiresAt,
      localListener: loopback,
      handle: handleRelayed,
    })
  }

  const retireOldest = () => {
    const open = [...logins.values()].filter(waiting)
    for (const stale of open.slice(0, Math.max(0, open.length - MAX_OPEN_LOGINS + 1))) {
      settle(stale, { status: "failed", message: "A newer sign-in replaced this one." })
    }
  }

  // One poll of the device-code token endpoint. 403 and 404 mean the person
  // has not entered the code yet, exactly as the CLI reads them; anything else
  // ends the sign-in, since a code that failed cannot succeed later.
  const pollDevice = async (login: PendingLogin, deviceAuthId: string, userCode: string, intervalMs: number): Promise<void> => {
    login.stopPolling = undefined
    if (login.outcome.status !== "waiting") return
    if (login.expiresAt <= now()) { sweep(); return }
    const again = () => {
      if (login.outcome.status === "waiting") login.stopPolling = schedule(() => { void pollDevice(login, deviceAuthId, userCode, intervalMs) }, intervalMs).cancel
    }
    let response: Response
    try {
      response = await exchangeFetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      })
    } catch {
      // A transport failure spends nothing: the code is still unredeemed.
      again()
      return
    }
    if (login.outcome.status !== "waiting") { await response.body?.cancel().catch(() => {}); return }
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel().catch(() => {})
      again()
      return
    }
    const body = await readJsonObject(response)
    if (!response.ok) {
      settle(login, { status: "failed", message: `ChatGPT ended the device sign-in (HTTP ${response.status}). Start it again.` })
      log(`[chatgpt] device sign-in failed: HTTP ${response.status}`)
      return
    }
    const authorizationCode = typeof body?.authorization_code === "string" ? body.authorization_code : ""
    const verifier = typeof body?.code_verifier === "string" ? body.code_verifier : ""
    if (!authorizationCode || !verifier) {
      settle(login, { status: "failed", message: "ChatGPT's answer to the device sign-in was incomplete. Start it again." })
      log("[chatgpt] device sign-in failed: incomplete answer")
      return
    }
    await exchange(login, authorizationCode, { redirectUri: DEVICE_REDIRECT_URI, verifier })
  }

  return {
    async start(startOptions) {
      sweep()
      retireOldest()
      const verifier = base64url(randomBytes(64))
      const expiresAt = now() + LOGIN_TTL_MS
      const login: PendingLogin = {
        id: base64url(randomBytes(16)),
        kind: "redirect",
        state: base64url(randomBytes(32)),
        verifier,
        expiresAt,
        returnTo: startOptions?.returnTo ?? null,
        name: startOptions?.name ?? null,
        expect: startOptions?.expect ?? null,
        outcome: { status: "waiting", expiresAt },
      }
      logins.set(login.id, login)
      listener ??= listen(handleCallback)
      const loopback = (await listener) !== null
      if (!loopback) listener = undefined
      publish(expiresAt, loopback)
      armSweep()
      const authorize = new URL(AUTHORIZE_URL)
      authorize.search = new URLSearchParams({
        response_type: "code",
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state: login.state,
        originator: ORIGINATOR,
      }).toString()
      return { connectId: login.id, authorizeUrl: authorize.toString(), loopback, expiresAt }
    },

    async startDevice(startOptions) {
      sweep()
      let response: Response
      try {
        response = await exchangeFetch(DEVICE_USERCODE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
          redirect: "error",
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        })
      } catch {
        return { ok: false, status: 502, code: "device_unreachable", message: "Could not reach auth.openai.com to start a device sign-in." }
      }
      const body = await readJsonObject(response)
      if (response.status === 404) {
        return { ok: false, status: 502, code: "device_unavailable", message: "auth.openai.com does not offer device sign-in right now. Use the browser sign-in instead." }
      }
      const deviceAuthId = typeof body?.device_auth_id === "string" ? body.device_auth_id : ""
      const userCodeValue = body?.user_code ?? body?.usercode
      const userCode = typeof userCodeValue === "string" ? userCodeValue : ""
      if (!response.ok || !deviceAuthId || !userCode) {
        return { ok: false, status: 502, code: "device_refused", message: `auth.openai.com refused to start a device sign-in (HTTP ${response.status}).` }
      }
      const intervalSeconds = Number.parseInt(String(body?.interval ?? ""), 10)
      const intervalMs = Number.isFinite(intervalSeconds) ? Math.max(DEVICE_MIN_INTERVAL_MS, intervalSeconds * 1000) : DEVICE_DEFAULT_INTERVAL_MS
      retireOldest()
      const expiresAt = now() + DEVICE_TTL_MS
      const login: PendingLogin = {
        id: base64url(randomBytes(16)),
        kind: "device",
        state: "",
        verifier: "",
        expiresAt,
        returnTo: null,
        name: startOptions?.name ?? null,
        expect: startOptions?.expect ?? null,
        outcome: { status: "waiting", expiresAt },
      }
      logins.set(login.id, login)
      login.stopPolling = schedule(() => { void pollDevice(login, deviceAuthId, userCode, intervalMs) }, intervalMs).cancel
      return { ok: true, connectId: login.id, userCode, verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL, expiresAt }
    },

    status(connectId) {
      sweep()
      return logins.get(connectId)?.outcome
    },

    async complete(connectId, pasted) {
      sweep()
      const login = logins.get(connectId)
      if (!login) return { ok: false, status: 410, code: "expired_login", message: "This sign-in is no longer open. Start it again." }
      if (login.kind !== "redirect") return { ok: false, status: 400, code: "invalid_request", message: "This is a device-code sign-in; it finishes by itself once the code is entered." }
      const query = parseCallbackInput(pasted)
      if (!query) {
        return { ok: false, status: 400, code: "invalid_request", message: "Paste the whole address the sign-in tab ended on (it starts with http://127.0.0.1:1455/auth/callback?code=).", retryable: true }
      }
      if (query.get("state") !== login.state) {
        return { ok: false, status: 400, code: "state_mismatch", message: "That address belongs to a different sign-in. Paste the one from the tab this sign-in opened.", retryable: true }
      }
      const result = await finish(login, query)
      sweep()
      return result
    },

    cancel(connectId) {
      const login = logins.get(connectId)
      if (!login || login.outcome.status !== "waiting") return false
      settle(login, { status: "failed", message: "This sign-in was cancelled." })
      sweep()
      return true
    },

    close() {
      for (const login of logins.values()) login.stopPolling?.()
      logins.clear()
      if (sweepTimer) clearTimeout(sweepTimer)
      sweepTimer = undefined
      const closing = listener
      listener = undefined
      void closing?.then(open => open?.close())
      callback?.close()
      callback = undefined
      return Promise.allSettled([...exchanges]).then(() => undefined)
    },
  }
}
