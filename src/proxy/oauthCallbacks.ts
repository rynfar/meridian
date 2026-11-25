/**
 * OAuth redirects, reachable through Meridian's own address.
 *
 * A provider that only accepts a loopback redirect (ChatGPT's Codex client:
 * exactly http://127.0.0.1:1455/auth/callback) sends the browser to whatever
 * listens on that port of the BROWSER's machine. Meridian listens there on its
 * own machine; a browser elsewhere lands on nothing. This module gives each
 * such listener a second door: `GET /callback/<id>/<path>?<query>` on the main
 * service is answered exactly as `<path>?<query>` on the loopback listener
 * would be. Something on the browser's machine - a relay that polls the open
 * callbacks (`GET /profiles/chatgpt/connect/callbacks`) - opens the same port
 * there and forwards each request to that door. Meridian runs nothing for it.
 *
 * ONE ID PER LISTENER, NOT PER SIGN-IN. A port can be bound once, so a relay
 * is keyed by port, and the listener behind it already serves every sign-in
 * waiting on that port, telling them apart by `state`. The id is minted when
 * the listener opens and dies when it closes - that is, when no sign-in waits
 * for the redirect any more - and a new listener gets a new one. A second
 * sign-in while it is open pushes the expiry out.
 *
 * WHAT GUARDS THE PUBLIC DOOR. The route needs no API key, because a browser
 * redirect carries none. The 128-bit id keeps the door shut to anyone who was
 * not told about it, and it only exists while a sign-in waits. Behind it is
 * the same handler the loopback listener runs, so the provider's `state` must
 * still match a waiting sign-in and the code is still useless without the
 * PKCE verifier, which never leaves this process. An unknown, expired or
 * closed id is a 404 that changes nothing.
 *
 * The id is in the listing and the URL, never the code or the state.
 *
 * Leaf module: node builtins only.
 */

import { randomBytes } from "node:crypto"

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
  /** Answer one relayed request; null for anything the listener would not serve. */
  handle(request: OAuthCallbackRequest): Promise<OAuthCallbackPage | null>
}

/** What a relay is told about one open listener. */
export interface OAuthCallbackView {
  id: string
  provider: string
  redirect: { host: string; port: number; path: string; url: string }
  /** `/callback/<id>`: the relay appends it to the address it reaches Meridian at. */
  path: string
  expiresAt: string
  expiresAtMs: number
  localListener: boolean
}

export interface OAuthCallbackHandle {
  readonly id: string
  /** Push the expiry out for a sign-in that joined. */
  extend(expiresAt: number): void
  close(): void
}

export interface OAuthCallbackRegistry {
  /** Open the public door for a listener. */
  open(spec: OAuthCallbackSpec): OAuthCallbackHandle
  /** Serve `/callback/<id>/...`; null means 404. */
  dispatch(id: string, request: OAuthCallbackRequest): Promise<OAuthCallbackPage | null>
  /** Every listener a relay could forward to now, soonest to expire first. */
  list(): OAuthCallbackView[]
  closeAll(): void
}

export interface OAuthCallbackRegistryOptions {
  now?: () => number
}

interface Entry {
  id: string
  spec: OAuthCallbackSpec
  expiresAt: number
}

export function createOAuthCallbackRegistry(options: OAuthCallbackRegistryOptions = {}): OAuthCallbackRegistry {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()

  const describe = (entry: Entry): OAuthCallbackView => {
    const { redirect } = entry.spec
    return {
      id: entry.id,
      provider: entry.spec.provider,
      redirect: { ...redirect, url: `http://${redirect.host}:${redirect.port}${redirect.path}` },
      path: `/callback/${entry.id}`,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      expiresAtMs: entry.expiresAt,
      localListener: entry.spec.localListener,
    }
  }

  // An expired entry is dropped where it is noticed, so neither the listing
  // nor the door outlives the sign-in it was opened for.
  const live = (entry: Entry) => {
    if (entry.expiresAt > now()) return true
    entries.delete(entry.id)
    return false
  }

  return {
    open(spec) {
      const entry: Entry = { id: randomBytes(16).toString("base64url"), spec, expiresAt: spec.expiresAt }
      entries.set(entry.id, entry)
      return {
        id: entry.id,
        extend(expiresAt) {
          if (entries.get(entry.id) === entry) entry.expiresAt = Math.max(entry.expiresAt, expiresAt)
        },
        close() {
          if (entries.get(entry.id) === entry) entries.delete(entry.id)
        },
      }
    },

    async dispatch(id, request) {
      const entry = entries.get(id)
      if (!entry || !live(entry)) return null
      return entry.spec.handle(request)
    },

    list() {
      return [...entries.values()].filter(live).sort((a, b) => a.expiresAt - b.expiresAt).map(describe)
    },

    closeAll() {
      entries.clear()
    },
  }
}
