/**
 * OAuth redirects, reachable through Meridian's own address.
 *
 * A provider that only accepts a loopback redirect (ChatGPT's Codex client:
 * exactly http://127.0.0.1:1455/auth/callback) sends the browser to whatever
 * listens on that port of the BROWSER's machine. Meridian listens there on its
 * own machine; a browser elsewhere lands on nothing. This module gives each
 * such listener a second door: `GET /callback/<id>/<path>?<query>` on the main
 * service is answered exactly as `<path>?<query>` on the loopback listener
 * would be. Something on the browser's machine - a relay told about the
 * listener by an `oauth.callback.listening` hook (hooks.ts) - opens the same
 * port there and forwards each request to that URL.
 *
 * ONE ID PER LISTENER, NOT PER SIGN-IN. A port can be bound once, so a relay
 * is keyed by port, and the listener behind it already serves every sign-in
 * waiting on that port, telling them apart by `state`. The id is minted when
 * the listener opens and dies when it closes - that is, when no sign-in waits
 * for the redirect any more - and a new listener gets a new one. A second
 * sign-in while it is open pushes the expiry out and announces it again.
 *
 * WHAT GUARDS THE PUBLIC DOOR. The route needs no API key, because a browser
 * redirect carries none. The 128-bit id keeps the door shut to anyone who was
 * not told about it, and it only exists while a sign-in waits. Behind it is
 * the same handler the loopback listener runs, so the provider's `state` must
 * still match a waiting sign-in and the code is still useless without the
 * PKCE verifier, which never leaves this process. An unknown, expired or
 * closed id is a 404 that changes nothing.
 *
 * The id is in the event and the URL, never the code or the state.
 *
 * Leaf module: node builtins and type imports only.
 */

import { randomBytes } from "node:crypto"
import type { HookDelivery, HookEventName } from "./hooks"

/** How long a sign-in start waits for its announcement before answering anyway. */
export const ANNOUNCE_WAIT_MS = 3_000

export type OAuthCallbackCloseReason = "completed" | "failed" | "cancelled" | "expired" | "replaced" | "shutdown"

export interface OAuthCallbackRequest {
  method: string
  /** The part after `/callback/<id>`, starting with `/`. */
  path: string
  query: URLSearchParams
}

export interface OAuthCallbackPage {
  status: number
  html: string
}

export interface OAuthCallbackSpec {
  /** Who the sign-in is with, e.g. "chatgpt". */
  provider: string
  /** Where the provider sends the browser. */
  redirect: { host: string; port: number; path: string }
  expiresAt: number
  /** Whether Meridian itself holds `redirect` on its own machine. */
  localListener: boolean
  /** The instance's public address; null leaves the public URL unannounced. */
  publicBaseUrl: string | null
  /** Answer one relayed request; null for anything the listener would not serve. */
  handle(request: OAuthCallbackRequest): Promise<OAuthCallbackPage | null>
}

export interface OAuthCallbackHandle {
  readonly id: string
  /** Push the expiry out for a sign-in that joined, and announce it again. */
  extend(expiresAt: number): Promise<HookDelivery[]>
  close(reason: OAuthCallbackCloseReason): void
}

export interface OAuthCallbackRegistry {
  /** Open the public door for a listener. `announced` settles within ANNOUNCE_WAIT_MS. */
  open(spec: OAuthCallbackSpec): { handle: OAuthCallbackHandle; announced: Promise<HookDelivery[]> }
  /** Serve `/callback/<id>/...`; null means 404. */
  dispatch(id: string, request: OAuthCallbackRequest): Promise<OAuthCallbackPage | null>
  closeAll(reason: OAuthCallbackCloseReason): void
}

export interface OAuthCallbackRegistryOptions {
  emit(event: HookEventName, payload: Record<string, unknown>, options?: { waitMs?: number }): Promise<HookDelivery[]>
  now?: () => number
  announceWaitMs?: number
}

interface Entry {
  id: string
  spec: OAuthCallbackSpec
  expiresAt: number
}

/** The public URL a relay forwards to; the redirect's path and query are appended to it. */
export function publicCallbackUrl(publicBaseUrl: string | null, id: string): string | null {
  return publicBaseUrl ? `${publicBaseUrl}/callback/${id}` : null
}

export function createOAuthCallbackRegistry(options: OAuthCallbackRegistryOptions): OAuthCallbackRegistry {
  const now = options.now ?? Date.now
  const announceWaitMs = options.announceWaitMs ?? ANNOUNCE_WAIT_MS
  const entries = new Map<string, Entry>()

  const describe = (entry: Entry) => {
    const { redirect } = entry.spec
    return {
      id: entry.id,
      provider: entry.spec.provider,
      redirect: { ...redirect, url: `http://${redirect.host}:${redirect.port}${redirect.path}` },
      url: publicCallbackUrl(entry.spec.publicBaseUrl, entry.id),
    }
  }

  const announce = (entry: Entry) => options.emit("oauth.callback.listening", {
    callback: {
      ...describe(entry),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      expiresAtMs: entry.expiresAt,
      localListener: entry.spec.localListener,
    },
  }, { waitMs: announceWaitMs })

  const close = (entry: Entry, reason: OAuthCallbackCloseReason) => {
    if (entries.get(entry.id) !== entry) return
    entries.delete(entry.id)
    void options.emit("oauth.callback.closed", { callback: { ...describe(entry), reason } })
  }

  return {
    open(spec) {
      const entry: Entry = { id: randomBytes(16).toString("base64url"), spec, expiresAt: spec.expiresAt }
      entries.set(entry.id, entry)
      const handle: OAuthCallbackHandle = {
        id: entry.id,
        extend(expiresAt) {
          if (entries.get(entry.id) !== entry) return Promise.resolve([])
          entry.expiresAt = Math.max(entry.expiresAt, expiresAt)
          return announce(entry)
        },
        close: reason => close(entry, reason),
      }
      return { handle, announced: announce(entry) }
    },

    async dispatch(id, request) {
      const entry = entries.get(id)
      if (!entry) return null
      if (entry.expiresAt <= now()) {
        close(entry, "expired")
        return null
      }
      return entry.spec.handle(request)
    },

    closeAll(reason) {
      for (const entry of [...entries.values()]) close(entry, reason)
    },
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/**
 * An operator-supplied public address, normalized: http(s), no credentials,
 * query or fragment, no trailing slash. A path prefix is kept, for an instance
 * published under one. Anything else is null.
 */
export function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/**
 * The address a request reached this instance at, as the browser saw it, or
 * null when that was loopback - a relay elsewhere cannot use it.
 *
 * `X-Forwarded-*` first, because behind a reverse proxy the request Meridian
 * sees is the proxy's. These headers are client-supplied when Meridian is
 * reached directly; the worst a forged one does is name a URL a relay refuses
 * (relays only forward to hosts they were told to trust) or one that receives
 * a code it cannot redeem without the PKCE verifier.
 */
export function requestPublicOrigin(request: { url: string; header(name: string): string | undefined }): string | null {
  const first = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined
  let fallback: URL
  try {
    fallback = new URL(request.url)
  } catch {
    return null
  }
  const proto = first(request.header("x-forwarded-proto"))
  const protocol = proto === "https" || proto === "http" ? `${proto}:` : fallback.protocol
  const host = first(request.header("x-forwarded-host")) ?? request.header("host") ?? fallback.host
  let origin: URL
  try {
    origin = new URL(`${protocol}//${host}`)
  } catch {
    return null
  }
  if (origin.pathname !== "/" || origin.username || origin.password) return null
  const hostname = origin.hostname.toLowerCase()
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) return null
  return origin.origin
}
