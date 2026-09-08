/**
 * Claude Design MCP proxy — token store, auth resolution, and login flow.
 *
 * Meridian proxies https://api.anthropic.com/v1/design/* so Claude Design
 * MCP tools work through the same local endpoint as everything else. The
 * Design API needs OAuth scopes (user:design:read/write) that the standard
 * Meridian OAuth flow does not request, so a dedicated /design-login flow
 * obtains and stores a separate design token.
 *
 * Originally prototyped in #543 by @sittitep, who discovered the load-bearing
 * upstream quirks encoded here (404-for-missing-scopes, the silent GET SSE
 * stream, and the accept-encoding double-decompression hazard).
 *
 * This module holds all logic; server.ts only mounts routes.
 */
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { CredentialStore } from "./tokenRefresh"
import { isCredentialsReadOnly, refuseCredentialWrite } from "./credentialsMode"
import {
  createManualOAuthSession,
  parseAuthorizationCodeInput,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
} from "./profileCli"

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const DESIGN_SCOPES = ["user:design:read", "user:design:write"]
export const DESIGN_UPSTREAM_ORIGIN = "https://api.anthropic.com"

/** Tokens expiring within this window are treated as already stale. */
const EXPIRY_SKEW_MS = 60_000
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000

export interface DesignTokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scopes?: string[]
}

export interface DesignTokenStore {
  read(): Promise<DesignTokenData | null>
  write(data: DesignTokenData): Promise<void>
}

export function defaultDesignTokenPath(): string {
  return process.env.MERIDIAN_DESIGN_TOKEN_PATH || join(homedir(), ".config", "meridian", "design-token.json")
}

export function createFileDesignTokenStore(path: string = defaultDesignTokenPath()): DesignTokenStore {
  return {
    async read() {
      try {
        const raw = await readFile(path, "utf-8")
        const data = JSON.parse(raw) as Partial<DesignTokenData>
        if (typeof data.accessToken === "string" && typeof data.expiresAt === "number") {
          return data as DesignTokenData
        }
        return null
      } catch {
        return null
      }
    },
    async write(data) {
      // Second credential store, guarded for the same reason as the OAuth one
      // — and a live example of the call site nobody thought of.
      // `defaultDesignTokenPath()` does NOT honour MERIDIAN_CONFIG_DIR, so a
      // second instance writes the FIRST instance's design token no matter
      // how its config dir is set, and this token carries a refresh token that
      // rotates on use (see getDesignAccessToken).
      if (isCredentialsReadOnly()) {
        refuseCredentialWrite("design-token-store", path)
        return
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(data), { mode: 0o600 })
    },
  }
}

export function isDesignTokenFresh(data: DesignTokenData, now: number = Date.now()): boolean {
  return data.expiresAt > now + EXPIRY_SKEW_MS
}

/**
 * Returns a usable design access token: the stored one if fresh, otherwise
 * the result of a refresh_token grant (persisted back to the store). Null
 * when there is no token or the refresh fails — callers fall back to
 * profile credentials and the upstream tells the user to /design-login.
 */
export async function getDesignAccessToken(opts: {
  store: DesignTokenStore
  fetchFn?: FetchLike
  now?: number
}): Promise<string | null> {
  const now = opts.now ?? Date.now()
  const fetchFn = opts.fetchFn ?? fetch
  const data = await opts.store.read()
  if (!data) return null
  if (isDesignTokenFresh(data, now)) return data.accessToken
  if (!data.refreshToken) return null

  // Same hazard as the OAuth refresh: the grant below rotates the token
  // server-side, so making the call at all can invalidate the copy the other
  // instance is using. Null is this function's existing refresh-failed
  // contract — callers fall back to profile credentials.
  if (isCredentialsReadOnly()) {
    refuseCredentialWrite("design-token-refresh", "design-token")
    return null
  }

  let response: Response
  try {
    response = await fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: data.refreshToken,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  let tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; scope?: string }
  try {
    tokenData = await response.json() as typeof tokenData
  } catch {
    return null
  }
  if (!tokenData.access_token) return null

  const refreshed: DesignTokenData = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? data.refreshToken,
    expiresAt: tokenData.expires_at ?? now + (tokenData.expires_in ?? 8 * 60 * 60) * 1000,
    scopes: tokenData.scope?.split(" ").filter(Boolean) ?? data.scopes,
  }
  await opts.store.write(refreshed)
  return refreshed.accessToken
}

/**
 * Auth precedence for upstream Design API requests:
 * design token → profile API key → profile OAuth token → Max credential
 * store. The design token comes first because it is the only credential
 * guaranteed to carry the design scopes.
 */
export async function resolveDesignAuthHeaders(opts: {
  designToken: string | null
  profile: { type: string; env: Record<string, string | undefined> }
  credentialStore?: CredentialStore
  ensureFresh?: (store: CredentialStore) => Promise<unknown>
}): Promise<Record<string, string>> {
  if (opts.designToken) return { Authorization: `Bearer ${opts.designToken}` }
  const { profile } = opts
  if (profile.type === "api" && profile.env.ANTHROPIC_API_KEY) {
    return { "x-api-key": profile.env.ANTHROPIC_API_KEY }
  }
  if (profile.type === "oauth-token" && profile.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { Authorization: `Bearer ${profile.env.CLAUDE_CODE_OAUTH_TOKEN}` }
  }
  if (opts.credentialStore) {
    if (opts.ensureFresh) await opts.ensureFresh(opts.credentialStore).catch(() => {})
    const creds = await opts.credentialStore.read()
    const token = creds?.claudeAiOauth?.accessToken
    if (token) return { Authorization: `Bearer ${token}` }
  }
  return {}
}

/**
 * Headers forwarded upstream. accept-encoding is pinned to identity:
 * Node's fetch auto-decompresses gzip but keeps the content-encoding
 * header, so MCP SDK clients receiving the re-served body would try to
 * decompress it a second time and fail to parse.
 */
export function buildDesignForwardHeaders(
  getHeader: (name: string) => string | undefined,
  authHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "anthropic-version": getHeader("anthropic-version") || "2023-06-01",
    "accept-encoding": "identity",
    ...authHeaders,
  }
  for (const name of ["content-type", "anthropic-beta", "mcp-session-id"]) {
    const value = getHeader(name)
    if (value) headers[name] = value
  }
  return headers
}

const HOP_BY_HOP = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
])

/** Forward all upstream headers (including mcp-session-id) minus hop-by-hop. */
export function filterUpstreamResponseHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value
  }
  return out
}

// NOTE: agent-specific — the Design API returns 404 (not 401) for OAuth
// tokens that lack user:design:read/write scopes. Both statuses mean the
// user needs to run /design-login.
export function isDesignAuthFailure(status: number): boolean {
  return status === 401 || status === 404
}

export interface DesignLoginResult {
  status: number
  body: unknown
}

export interface DesignLogin {
  /** Start a login session; returns the JSON body for GET /design-login. */
  start(): { authorizeUrl: string; instructions: string }
  /** Like start() but also exposes the state, for tests. */
  startRaw(): { authorizeUrl: string; state: string }
  /** Handle POST /design-login: exchange the pasted code for a token. */
  exchange(body: unknown): Promise<DesignLoginResult>
}

export function createDesignLogin(deps: {
  store: DesignTokenStore
  createSession?: (scopes: string[]) => { authorizeUrl: string; codeVerifier: string; state: string }
  fetchFn?: FetchLike
  now?: () => number
}): DesignLogin {
  const createSession = deps.createSession ?? createManualOAuthSession
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  const sessions = new Map<string, { codeVerifier: string; expiresAt: number }>()

  const startRaw = () => {
    for (const [state, session] of sessions) {
      if (session.expiresAt < now()) sessions.delete(state)
    }
    const session = createSession(DESIGN_SCOPES)
    sessions.set(session.state, { codeVerifier: session.codeVerifier, expiresAt: now() + LOGIN_SESSION_TTL_MS })
    return { authorizeUrl: session.authorizeUrl, state: session.state }
  }

  return {
    startRaw,

    start() {
      const { authorizeUrl } = startRaw()
      return {
        authorizeUrl,
        instructions:
          'Open the URL in your browser. After authorizing, POST the code to /design-login with body { "code": "<paste-code-here>" }',
      }
    },

    async exchange(rawBody) {
      const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as { code?: string; state?: string }
      const parsed = body.code ? parseAuthorizationCodeInput(body.code) : null
      if (!parsed) {
        return { status: 400, body: { type: "error", error: { type: "invalid_request", message: "Missing or invalid 'code' field." } } }
      }

      const stateKey = parsed.state ?? body.state
      const stored = stateKey ? sessions.get(stateKey) : undefined
      if (!stateKey || !stored || stored.expiresAt < now()) {
        return {
          status: 400,
          body: { type: "error", error: { type: "session_expired", message: "OAuth session expired or not found. Call GET /design-login to start a new session." } },
        }
      }
      sessions.delete(stateKey)

      let response: Response
      try {
        response = await fetchFn(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: OAUTH_CLIENT_ID,
            code: parsed.code,
            redirect_uri: OAUTH_REDIRECT_URI,
            code_verifier: stored.codeVerifier,
            state: stateKey,
          }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        return { status: 502, body: { type: "error", error: { type: "upstream_error", message: err instanceof Error ? err.message : String(err) } } }
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        return {
          status: 502,
          body: { type: "error", error: { type: "token_exchange_failed", message: `Token exchange failed (${response.status}): ${text.slice(0, 200)}` } },
        }
      }

      const tokenData = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; scope?: string }
      if (!tokenData.access_token) {
        return { status: 502, body: { type: "error", error: { type: "token_exchange_failed", message: "Token response missing access_token." } } }
      }

      const expiresAt = tokenData.expires_at ?? now() + (tokenData.expires_in ?? 8 * 60 * 60) * 1000
      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? DESIGN_SCOPES

      try {
        await deps.store.write({ accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token, expiresAt, scopes })
      } catch (err) {
        return { status: 500, body: { type: "error", error: { type: "storage_error", message: `Failed to store design token: ${err instanceof Error ? err.message : String(err)}` } } }
      }

      return { status: 200, body: { success: true, scopes } }
    },
  }
}
