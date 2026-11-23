/**
 * The public door to a loopback OAuth listener (proxy/oauthCallbacks.ts): what
 * a relay is told, which ids open it, and that a closed, expired or unknown id
 * is a 404 that reaches no handler.
 */
import { describe, expect, it } from "bun:test"
import type { HookDelivery, HookEventName } from "../proxy/hooks"
import {
  createOAuthCallbackRegistry,
  normalizePublicUrl,
  requestPublicOrigin,
  type OAuthCallbackRequest,
  type OAuthCallbackSpec,
} from "../proxy/oauthCallbacks"

const NOW = 1_800_000_000_000

function registry(clock = { now: NOW }) {
  const events: Array<{ event: HookEventName; payload: Record<string, unknown>; waitMs?: number }> = []
  const delivery: HookDelivery = { at: NOW, event: "oauth.callback.listening", target: "command relay", source: "env", ok: true, detail: "laptop: forwarding", ms: 5 }
  const callbacks = createOAuthCallbackRegistry({
    emit: async (event, payload, options) => {
      events.push({ event, payload, waitMs: options?.waitMs })
      return event === "oauth.callback.listening" ? [{ ...delivery, event }] : []
    },
    now: () => clock.now,
  })
  return { callbacks, events, clock }
}

function spec(handled: OAuthCallbackRequest[], overrides: Partial<OAuthCallbackSpec> = {}): OAuthCallbackSpec {
  return {
    provider: "chatgpt",
    redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback" },
    expiresAt: NOW + 600_000,
    localListener: true,
    publicBaseUrl: "https://meridian.example",
    handle: async request => {
      handled.push(request)
      return request.path === "/auth/callback" ? { status: 200, html: "connected" } : null
    },
    ...overrides,
  }
}

const get = (path: string, query = "") => ({ method: "GET", path, query: new URLSearchParams(query) })

describe("OAuth callback registry", () => {
  it("announces a listener with everything a relay needs and nothing credential-bearing", async () => {
    const { callbacks, events } = registry()
    const opened = callbacks.open(spec([]))
    expect(await opened.announced).toEqual([expect.objectContaining({ ok: true, detail: "laptop: forwarding" })])
    expect(opened.handle.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(events).toEqual([{
      event: "oauth.callback.listening",
      waitMs: 3_000,
      payload: {
        callback: {
          id: opened.handle.id,
          provider: "chatgpt",
          redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback", url: "http://127.0.0.1:1455/auth/callback" },
          url: `https://meridian.example/callback/${opened.handle.id}`,
          expiresAt: new Date(NOW + 600_000).toISOString(),
          expiresAtMs: NOW + 600_000,
          localListener: true,
        },
      },
    }])
  })

  it("serves a known id, passing the path after the id and the query through", async () => {
    const handled: OAuthCallbackRequest[] = []
    const { callbacks } = registry()
    const { handle } = callbacks.open(spec(handled))
    expect(await callbacks.dispatch(handle.id, get("/auth/callback", "code=c&state=s"))).toEqual({ status: 200, html: "connected" })
    expect(handled[0]?.path).toBe("/auth/callback")
    expect(handled[0]?.query.get("state")).toBe("s")
    expect(await callbacks.dispatch(handle.id, get("/favicon.ico"))).toBeNull()
  })

  it("answers an unknown, closed or expired id with nothing and never reaches the handler", async () => {
    const handled: OAuthCallbackRequest[] = []
    const { callbacks, events, clock } = registry()
    expect(await callbacks.dispatch("unknown-id", get("/auth/callback"))).toBeNull()

    const closed = callbacks.open(spec(handled)).handle
    closed.close("completed")
    expect(await callbacks.dispatch(closed.id, get("/auth/callback"))).toBeNull()

    const expiring = callbacks.open(spec(handled)).handle
    clock.now = NOW + 600_000
    expect(await callbacks.dispatch(expiring.id, get("/auth/callback"))).toBeNull()
    expect(handled).toEqual([])
    expect(events.filter(e => e.event === "oauth.callback.closed").map(e => (e.payload.callback as { reason: string }).reason)).toEqual(["completed", "expired"])
  })

  it("closes once, and says why", async () => {
    const { callbacks, events } = registry()
    const { handle } = callbacks.open(spec([]))
    handle.close("cancelled")
    handle.close("completed")
    const closes = events.filter(e => e.event === "oauth.callback.closed")
    expect(closes).toHaveLength(1)
    expect(closes[0]?.payload).toEqual({
      callback: {
        id: handle.id,
        provider: "chatgpt",
        redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback", url: "http://127.0.0.1:1455/auth/callback" },
        url: `https://meridian.example/callback/${handle.id}`,
        reason: "cancelled",
      },
    })
  })

  it("pushes the expiry out and re-announces when another sign-in joins, never pulling it in", async () => {
    const { callbacks, events } = registry()
    const { handle } = callbacks.open(spec([]))
    await handle.extend(NOW + 900_000)
    await handle.extend(NOW + 100_000)
    const announced = events.filter(e => e.event === "oauth.callback.listening").map(e => (e.payload.callback as { expiresAtMs: number }).expiresAtMs)
    expect(announced).toEqual([NOW + 600_000, NOW + 900_000, NOW + 900_000])
    handle.close("completed")
    expect(await handle.extend(NOW + 1_000_000)).toEqual([])
  })

  it("announces no public URL when the instance does not know its own address", async () => {
    const { callbacks, events } = registry()
    callbacks.open(spec([], { publicBaseUrl: null }))
    expect((events[0]?.payload.callback as { url: unknown }).url).toBeNull()
  })

  it("closes everything on shutdown", () => {
    const { callbacks, events } = registry()
    callbacks.open(spec([]))
    callbacks.open(spec([]))
    callbacks.closeAll("shutdown")
    expect(events.filter(e => e.event === "oauth.callback.closed")).toHaveLength(2)
  })
})

describe("public address", () => {
  it("normalizes an operator's URL and refuses what cannot be a base", () => {
    expect(normalizePublicUrl("https://meridian.example/")).toBe("https://meridian.example")
    expect(normalizePublicUrl(" https://host.example/meridian/ ")).toBe("https://host.example/meridian")
    expect(normalizePublicUrl("https://user:pw@host.example")).toBeNull()
    expect(normalizePublicUrl("https://host.example/?x=1")).toBeNull()
    expect(normalizePublicUrl("ftp://host.example")).toBeNull()
    expect(normalizePublicUrl("")).toBeNull()
  })

  it("takes the address a browser reached a reverse proxy at, and nothing on loopback", () => {
    const request = (url: string, headers: Record<string, string>) => ({ url, header: (name: string) => headers[name] })
    expect(requestPublicOrigin(request("http://meridian-gpt.example/profiles", { host: "meridian-gpt.example", "x-forwarded-proto": "https" }))).toBe("https://meridian-gpt.example")
    expect(requestPublicOrigin(request("http://127.0.0.1:3459/x", { host: "127.0.0.1:3459", "x-forwarded-host": "public.example, inner", "x-forwarded-proto": "https,http" }))).toBe("https://public.example")
    expect(requestPublicOrigin(request("http://127.0.0.1:3459/x", { host: "127.0.0.1:3459" }))).toBeNull()
    expect(requestPublicOrigin(request("http://localhost:3459/x", { host: "localhost:3459" }))).toBeNull()
    expect(requestPublicOrigin(request("http://x/", { host: "app.localhost" }))).toBeNull()
    expect(requestPublicOrigin(request("http://x/", { host: "bad host/../" }))).toBeNull()
  })
})
