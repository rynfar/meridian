/**
 * Browser-completable OAuth login for claude-max profiles.
 *
 * Backs `POST /profiles/login/start`, `GET /callback`,
 * `GET /profiles/login/status` and `POST /profiles/login/complete`, so
 * re-authenticating an account does not require a terminal on the box Meridian
 * runs on. The browser only ever holds an opaque login id; the PKCE verifier
 * stays here.
 *
 * A login started from a browser ON THE MERIDIAN HOST finishes by itself:
 * Anthropic redirects to `http://127.0.0.1:<port>/callback`, this module
 * exchanges the code, and the page notices via `GET /profiles/login/status`.
 * Anthropic's published client metadata for the Claude Code client
 * (`https://claude.ai/oauth/claude-code-client-metadata`) registers
 * `http://localhost/callback` and `http://127.0.0.1/callback`, so a loopback
 * redirect is the one alternative to the code-display page that will be
 * accepted — an origin like `meridian.example.com` cannot be registered.
 *
 * That is also the flow's limit: a redirect to loopback only comes back to
 * Meridian when the browser is on the same host (directly, or through an SSH
 * port-forward, since the forward makes the same loopback address reach it).
 * A browser on another machine keeps the paste flow, which is why both
 * authorize URLs are minted from ONE PKCE challenge and either may be
 * completed — the same thing Claude Code does with its manual/automatic pair.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { randomBytes } from "node:crypto"
import { envBool } from "../env"
import {
  buildAuthorizeUrl,
  createOAuthPkce,
  exchangeAuthorizationCodeForCredentials,
  parseAuthorizationCodeInput,
  profileConfigDirFor,
  OAUTH_LOOPBACK_CALLBACK_PATH,
  OAUTH_REDIRECT_URI,
} from "./profileCli"
import { getEffectiveProfiles, resolveProfile, type ProfileConfig } from "./profiles"

/**
 * How long a started login stays completable.
 *
 * Bounded because an unfinished login holds a PKCE verifier and a `state` this
 * process would otherwise accept forever. Ten minutes covers a human signing
 * in — including a password manager and a 2FA prompt — and Anthropic's
 * authorization code expires well before it anyway.
 */
export const LOGIN_TTL_MS = 10 * 60_000

/**
 * How long a finished login's OUTCOME remains readable by the status route.
 *
 * The page polls every second or two, so this is only for a user who switched
 * tabs. Kept in a separate record that holds no verifier and no code.
 */
export const LOGIN_RESULT_TTL_MS = 5 * 60_000

/**
 * Hosts a loopback redirect may be built for.
 *
 * Exactly the two Anthropic registered. Anything else — a LAN address, a
 * tailnet name, a reverse-proxy hostname — is refused at the authorize step,
 * so offering it would produce a broken login rather than a fallback.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"])

interface PendingLogin {
  profileId: string
  claudeConfigDir: string
  codeVerifier: string
  state: string
  expiresAt: number
  /** Present only when this login was started with a usable loopback origin. */
  loopbackRedirectUri?: string
}

interface FinishedLogin {
  profileId: string
  status: "completed" | "failed"
  expiresAt: number
  failure?: { code: LoginErrorCode; message: string }
}

/**
 * Started-but-unfinished logins, keyed by the opaque id handed to the browser.
 *
 * Server-side because the verifier is half of the PKCE proof: sending it to the
 * browser would put both halves in one place that is not the one that started
 * the flow. Two logins for different profiles are two entries and cannot
 * interfere — each carries its own verifier, state and target directory.
 */
const pendingLogins = new Map<string, PendingLogin>()

/**
 * `state` → login id.
 *
 * The redirect from Anthropic carries `state` and nothing else that identifies
 * the login, so this index IS the state check on that path: an id is only
 * reached by presenting the unguessable 256-bit `state` that login was started
 * with. There is no lookup that skips it.
 */
const loginIdByState = new Map<string, string>()

/** Outcomes of finished logins, so the page can read what happened. */
const finishedLogins = new Map<string, FinishedLogin>()

export type LoginErrorCode =
  | "credentials_readonly"
  | "no_profiles"
  | "unknown_profile"
  | "unsupported_profile_type"
  | "invalid_request"
  | "expired_login"
  | "no_code"
  | "state_mismatch"
  | "login_denied"
  | "exchange_failed"
  | "write_failed"

export interface LoginFailure {
  ok: false
  code: LoginErrorCode
  status: number
  message: string
  /**
   * The login is still open — paste again, no second sign-in.
   *
   * Set exactly when the paste was rejected locally, before any code reached
   * Anthropic. The client reads this instead of matching on `code`, because
   * only this module knows whether the session survived the attempt; a client
   * re-deriving it from the code list would drift the moment a code is added.
   */
  retryable?: true
}

/** How the browser is expected to finish this login. */
export type LoginMode = "redirect" | "paste"

export interface StartLoginSuccess {
  ok: true
  profileId: string
  loginId: string
  mode: LoginMode
  /** The URL to open. Redirects back here in `redirect` mode. */
  authorizeUrl: string
  /**
   * Authorize URL whose sign-in ends on Anthropic's code-display page.
   *
   * Always present, even in `redirect` mode, so the page can offer "paste it
   * instead" without starting a second login: both URLs carry the same
   * challenge and `state`, and whichever is completed first wins.
   */
  pasteAuthorizeUrl: string
  /**
   * Authorize URL that redirects to this instance on loopback, when one can be
   * built at all. In `redirect` mode this is `authorizeUrl`; in `paste` mode it
   * is the upgrade the page may take if `loopbackProbeUrl` answers.
   */
  loopbackAuthorizeUrl?: string
  /**
   * Status URL for THIS login on the loopback origin, for the page to probe.
   *
   * Deliberately the status route rather than something like `/health`: a 200
   * from it proves the browser can reach loopback AND that what answers there
   * is the same instance holding this login. Anything else on that port
   * answers 410 and the page keeps the paste flow.
   */
  loopbackProbeUrl?: string
  expiresAt: number
}

export interface CompleteLoginSuccess {
  ok: true
  profileId: string
}

export interface StartLoginParams {
  profiles: ProfileConfig[] | undefined
  profileId: string
  /**
   * The request's own `Host` header — the origin the user is actually on,
   * which decides whether a loopback redirect can reach this instance.
   */
  hostHeader?: string
  /** Port this instance listens on, used to offer a loopback candidate when
   *  `hostHeader` is some other name. */
  serverPort?: number
  now?: number
}

export interface CompleteLoginParams {
  loginId: string
  input: string
  now?: number
  fetchFn?: typeof fetch
}

export interface CallbackParams {
  state?: string
  code?: string
  /** `error` / `error_description` as Anthropic sends them on a refusal. */
  error?: string
  errorDescription?: string
  now?: number
  fetchFn?: typeof fetch
}

export interface LoginStatusReport {
  status: "waiting" | "completed" | "failed"
  profileId: string
  error?: string
  code?: LoginErrorCode
}

function prune(now: number): void {
  for (const [id, login] of pendingLogins) {
    if (login.expiresAt <= now) {
      pendingLogins.delete(id)
      loginIdByState.delete(login.state)
    }
  }
  for (const [id, finished] of finishedLogins) {
    if (finished.expiresAt <= now) finishedLogins.delete(id)
  }
}

/** Take a login out of play. Returns it, or undefined if it was not open. */
function consume(loginId: string): PendingLogin | undefined {
  const pending = pendingLogins.get(loginId)
  if (!pending) return undefined
  pendingLogins.delete(loginId)
  loginIdByState.delete(pending.state)
  return pending
}

function restore(loginId: string, pending: PendingLogin): void {
  pendingLogins.set(loginId, pending)
  loginIdByState.set(pending.state, loginId)
}

function finish(loginId: string, profileId: string, now: number, failure?: LoginFailure): void {
  finishedLogins.set(loginId, {
    profileId,
    status: failure ? "failed" : "completed",
    expiresAt: now + LOGIN_RESULT_TTL_MS,
    ...(failure ? { failure: { code: failure.code, message: failure.message } } : {}),
  })
}

/**
 * The loopback URL Anthropic should redirect to, or undefined when this
 * browser cannot be redirected back.
 *
 * Derived from the request's own `Host` header rather than from configuration
 * because that header IS the address the user reached this instance on — which
 * is the address a redirect has to come back to. It also makes an SSH
 * port-forward work unchanged: the browser is on `localhost:<forwarded port>`,
 * so that is what gets built, and the forward carries it back.
 *
 * SECURITY. `Host` is client-supplied, so this deliberately does not echo it:
 * the value is parsed, the hostname must be one of the two Anthropic
 * registered, and the URL is REBUILT from the parsed host with a fixed path.
 * The only reachable abuse is aiming the redirect at a different port on the
 * user's own loopback, which needs a forged `Host` (browsers set it from the
 * address bar) and still yields nothing: the code is bound by PKCE to a
 * verifier held only here, and the `state` needed to redeem it never left this
 * process.
 */
export function resolveLoopbackRedirectUri(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined
  let parsed: URL
  try {
    parsed = new URL(`http://${hostHeader}`)
  } catch {
    return undefined
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return undefined
  return `http://${parsed.host}${OAUTH_LOOPBACK_CALLBACK_PATH}`
}

/**
 * A loopback redirect this instance MIGHT be reachable at, for a browser that
 * reached it under some other name.
 *
 * `Host` proves a loopback redirect will work; its absence proves nothing. A
 * user browsing `https://meridian.example.net` from the very machine Meridian
 * runs on can still be redirected to `http://127.0.0.1:<port>/callback` — the
 * browser is on that host, it simply did not say so. Measured in Chromium: a
 * page on an HTTPS origin may both `fetch` and be navigated to loopback, since
 * `127.0.0.1` is a potentially-trustworthy origin and so is exempt from
 * mixed-content blocking.
 *
 * So this returns a CANDIDATE, offered alongside the paste URL rather than
 * used in its place. The page probes it (see `loopbackProbeUrl`) and upgrades
 * only when the probe answers; a browser on another machine never reaches it,
 * the probe fails, and the paste flow stands.
 */
export function loopbackRedirectUriForPort(port: number | undefined): string | undefined {
  if (!port || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return `http://127.0.0.1:${port}${OAUTH_LOOPBACK_CALLBACK_PATH}`
}

/**
 * Refuse when this instance must not write credential files.
 *
 * `MERIDIAN_CREDENTIALS_READONLY=1` marks an instance that shares another
 * instance's credential files — a standby beside the one that owns them. Such
 * an instance can still serve this page, so the button is there to be clicked;
 * refusing at the START is the whole point. A user who signs in and is refused
 * afterwards has burned a one-time authorization code for nothing.
 */
function readonlyRefusal(profileId: string): LoginFailure | null {
  if (!envBool("CREDENTIALS_READONLY")) return null
  return {
    ok: false,
    code: "credentials_readonly",
    status: 409,
    message:
      "This Meridian instance runs with MERIDIAN_CREDENTIALS_READONLY=1 and must not write credential files, "
      + "so it cannot complete a login. Use the instance that owns these credentials, "
      + `or a terminal on the box that holds them: meridian profile login ${profileId}`,
  }
}

/**
 * Create a login: resolve the profile, mint one PKCE challenge, and return the
 * authorize URL for whichever completion this browser can manage. Every
 * refusal happens here, before the user is sent to Anthropic to sign in.
 */
export function startProfileLogin(params: StartLoginParams): StartLoginSuccess | LoginFailure {
  const now = params.now ?? Date.now()
  const profileId = params.profileId.trim()
  if (!profileId) {
    return { ok: false, code: "invalid_request", status: 400, message: "Missing 'profile' in request body" }
  }

  const readonly = readonlyRefusal(profileId)
  if (readonly) return readonly

  const effective = getEffectiveProfiles(params.profiles)
  if (effective.length === 0) {
    return { ok: false, code: "no_profiles", status: 400, message: "No profiles configured" }
  }

  // Unknown ids are refused rather than created. `meridian profile add` is the
  // one place a profile comes into existence, and this surface is reachable by
  // anyone who can reach the page — creating an account slot from it is a
  // different decision than re-authenticating one that exists.
  if (!effective.some(p => p.id === profileId)) {
    return {
      ok: false,
      code: "unknown_profile",
      status: 404,
      message: `Unknown profile: ${profileId}. Available: ${effective.map(p => p.id).join(", ")}`,
    }
  }

  // Reuse the request-path resolver so the type inference and the config-dir
  // choice are the ones every request already gets, not a second reading of
  // the same fields.
  const resolved = resolveProfile(params.profiles, undefined, profileId)
  if (resolved.type !== "claude-max") {
    return {
      ok: false,
      code: "unsupported_profile_type",
      status: 400,
      message: `Profile "${profileId}" is an ${resolved.type} profile, which has no OAuth login flow. `
        + (resolved.type === "oauth-token"
          ? `Replace its token instead: meridian profile remove ${profileId} && meridian profile add ${profileId} --oauth-token`
          : "Edit its API key in ~/.config/meridian/profiles.json instead."),
    }
  }

  const pkce = createOAuthPkce()
  // Two questions, not one: whether a loopback redirect is CERTAIN (the browser
  // said it reached us on loopback) and whether one is POSSIBLE (it may be on
  // this host under another name). The first picks the mode; the second is
  // offered for the page to probe.
  const certainLoopbackUri = resolveLoopbackRedirectUri(params.hostHeader)
  const loopbackRedirectUri = certainLoopbackUri ?? loopbackRedirectUriForPort(params.serverPort)
  const pasteAuthorizeUrl = buildAuthorizeUrl({
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
    redirectUri: OAUTH_REDIRECT_URI,
  })
  const loopbackAuthorizeUrl = loopbackRedirectUri
    ? buildAuthorizeUrl({
        codeChallenge: pkce.codeChallenge,
        state: pkce.state,
        redirectUri: loopbackRedirectUri,
      })
    : undefined
  const authorizeUrl = certainLoopbackUri ? loopbackAuthorizeUrl! : pasteAuthorizeUrl

  const loginId = randomBytes(16).toString("base64url")
  const expiresAt = now + LOGIN_TTL_MS
  prune(now)
  restore(loginId, {
    profileId,
    claudeConfigDir: resolved.env.CLAUDE_CONFIG_DIR ?? profileConfigDirFor(profileId),
    codeVerifier: pkce.codeVerifier,
    state: pkce.state,
    expiresAt,
    loopbackRedirectUri,
  })

  return {
    ok: true,
    profileId,
    loginId,
    mode: certainLoopbackUri ? "redirect" : "paste",
    authorizeUrl,
    pasteAuthorizeUrl,
    ...(loopbackAuthorizeUrl ? { loopbackAuthorizeUrl } : {}),
    ...(loopbackRedirectUri
      ? { loopbackProbeUrl: `${new URL(loopbackRedirectUri).origin}/profiles/login/status?loginId=${encodeURIComponent(loginId)}` }
      : {}),
    expiresAt,
  }
}

/**
 * Finish a login from what the user pasted — a bare code, or the whole callback
 * URL from the browser's address bar.
 */
export async function completeProfileLogin(params: CompleteLoginParams): Promise<CompleteLoginSuccess | LoginFailure> {
  const now = params.now ?? Date.now()
  prune(now)

  const pending = pendingLogins.get(params.loginId)
  if (!pending) {
    return {
      ok: false,
      code: "expired_login",
      status: 410,
      message: "This login is no longer open — it expired, or it was already completed. Start it again.",
    }
  }

  // Parsed before the session is consumed: a mistyped paste should not force
  // the user back through Anthropic's sign-in. The session is single-use from
  // the moment a code is actually sent, which is the exchange below.
  const parsed = parseAuthorizationCodeInput(params.input)
  if (!parsed) {
    return {
      ok: false,
      code: "no_code",
      status: 400,
      retryable: true,
      message: "No authorization code found in that paste. Paste the code Claude showed you, or the whole callback URL.",
    }
  }

  // Consumed BEFORE the exchange, not after: taking it out of both indexes
  // first is what makes single-use hold against two completions racing the
  // same login id.
  consume(params.loginId)

  // A pasted code always comes from the code-display page, so it is bound to
  // THAT redirect_uri — even when this login also issued a loopback URL the
  // user chose not to use.
  const result = await exchangeAuthorizationCodeForCredentials({
    code: parsed.code,
    returnedState: parsed.state,
    sessionState: pending.state,
    codeVerifier: pending.codeVerifier,
    claudeConfigDir: pending.claudeConfigDir,
    redirectUri: OAUTH_REDIRECT_URI,
    fetchFn: params.fetchFn,
  })

  if (result.ok) {
    finish(params.loginId, pending.profileId, now)
    return { ok: true, profileId: pending.profileId }
  }

  if (result.reason === "state_mismatch") {
    // Rejected locally — the code never reached Anthropic, so nothing was
    // spent and this login is still good. Put it back: pasting the wrong
    // browser tab should cost a second paste, not a second sign-in.
    restore(params.loginId, pending)
    return {
      ok: false,
      code: "state_mismatch",
      status: 400,
      retryable: true,
      message: "OAuth state did not match this login. Paste the code from the tab this login opened.",
    }
  }

  const failure = exchangeFailure(result, pending.profileId)
  finish(params.loginId, pending.profileId, now, failure)
  return failure
}

/**
 * Finish a login from Anthropic's redirect back to `/callback`.
 *
 * Addressed by `state` alone, because that is all the redirect carries that
 * identifies the login — and being unguessable is exactly what makes it
 * sufficient. A `state` with no open login is indistinguishable from an
 * expired one and gets the same answer.
 */
export async function completeProfileLoginFromCallback(
  params: CallbackParams,
): Promise<CompleteLoginSuccess | LoginFailure> {
  const now = params.now ?? Date.now()
  prune(now)

  const loginId = params.state ? loginIdByState.get(params.state) : undefined
  const pending = loginId ? pendingLogins.get(loginId) : undefined
  if (!loginId || !pending) {
    return {
      ok: false,
      code: "expired_login",
      status: 410,
      message: "No login is waiting for this sign-in — it expired, or it was already completed. Start it again from the Profiles page.",
    }
  }

  if (params.error) {
    const failure: LoginFailure = {
      ok: false,
      code: "login_denied",
      status: 400,
      message: `Claude did not authorize this login (${params.error}${params.errorDescription ? `: ${params.errorDescription}` : ""}).`,
    }
    consume(loginId)
    finish(loginId, pending.profileId, now, failure)
    return failure
  }

  // Only a login that issued a loopback URL can be finished by a redirect;
  // anything else means a `state` arriving on a path it was never minted for.
  if (!params.code || !pending.loopbackRedirectUri) {
    const failure: LoginFailure = {
      ok: false,
      code: "no_code",
      status: 400,
      message: "That sign-in came back without an authorization code. Start the login again.",
    }
    consume(loginId)
    finish(loginId, pending.profileId, now, failure)
    return failure
  }

  consume(loginId)

  const result = await exchangeAuthorizationCodeForCredentials({
    code: params.code,
    returnedState: params.state,
    sessionState: pending.state,
    codeVerifier: pending.codeVerifier,
    claudeConfigDir: pending.claudeConfigDir,
    redirectUri: pending.loopbackRedirectUri,
    fetchFn: params.fetchFn,
  })

  if (result.ok) {
    finish(loginId, pending.profileId, now)
    return { ok: true, profileId: pending.profileId }
  }

  const failure = exchangeFailure(result, pending.profileId)
  finish(loginId, pending.profileId, now, failure)
  return failure
}

function exchangeFailure(
  result: Extract<Awaited<ReturnType<typeof exchangeAuthorizationCodeForCredentials>>, { ok: false }>,
  profileId: string,
): LoginFailure {
  if (result.reason === "state_mismatch") {
    return {
      ok: false,
      code: "state_mismatch",
      status: 400,
      message: "OAuth state did not match this login. Start the login again.",
    }
  }
  if (result.reason === "write_failed") {
    return {
      ok: false,
      code: "write_failed",
      status: 500,
      message: `Signed in, but the credentials for "${profileId}" could not be written.`,
    }
  }
  // The token endpoint's own error body is deliberately not forwarded — it is
  // one-time-credential-adjacent and belongs nowhere near a rendered page.
  return {
    ok: false,
    code: "exchange_failed",
    status: 502,
    message: result.status
      ? `Anthropic rejected the authorization code (HTTP ${result.status}). Codes expire quickly — start the login again.`
      : "Could not reach Anthropic to exchange the authorization code. Start the login again.",
  }
}

/**
 * What became of a login. `null` once nothing is known about the id — either it
 * was never issued, or both its TTLs have passed.
 */
export function getProfileLoginStatus(loginId: string, now: number = Date.now()): LoginStatusReport | null {
  prune(now)
  const pending = pendingLogins.get(loginId)
  if (pending) return { status: "waiting", profileId: pending.profileId }
  const finished = finishedLogins.get(loginId)
  if (!finished) return null
  if (finished.status === "completed") return { status: "completed", profileId: finished.profileId }
  return {
    status: "failed",
    profileId: finished.profileId,
    error: finished.failure?.message,
    code: finished.failure?.code,
  }
}

export function pendingLoginCount(): number {
  return pendingLogins.size
}

/** Drop all pending logins — for testing only. */
export function resetPendingLogins(): void {
  pendingLogins.clear()
  loginIdByState.clear()
  finishedLogins.clear()
}
