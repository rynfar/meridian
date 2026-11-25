/**
 * The public door to a loopback OAuth listener (proxy/oauthCallbacks.ts): what
 * a relay is told, which ids open it, and that a closed, expired or unknown id
 * is a 404 that reaches no handler.
 */
import { describe, expect, it } from "bun:test"
import { createOAuthCallbackRegistry, type OAuthCallbackRequest, type OAuthCallbackSpec } from "../proxy/oauthCallbacks"

const NOW = 1_800_000_000_000

function registry(clock = { now: NOW }) {
  return { callbacks: createOAuthCallbackRegistry({ now: () => clock.now }), clock }
}

function spec(handled: OAuthCallbackRequest[], overrides: Partial<OAuthCallbackSpec> = {}): OAuthCallbackSpec {
  return {
    provider: "chatgpt",
    redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback" },
    expiresAt: NOW + 600_000,
    localListener: true,
    handle: async request => {
      handled.push(request)
      return request.path === "/auth/callback" ? { status: 200, html: "connected" } : null
    },
    ...overrides,
  }
}

const get = (path: string, query = "") => ({ method: "GET", path, query: new URLSearchParams(query) })

describe("OAuth callback registry", () => {
  it("lists a listener with everything a relay needs", () => {
    const { callbacks } = registry()
    const handle = callbacks.open(spec([]))
    expect(handle.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(callbacks.list()).toEqual([{
      id: handle.id,
      provider: "chatgpt",
      redirect: { host: "127.0.0.1", port: 1455, path: "/auth/callback", url: "http://127.0.0.1:1455/auth/callback" },
      path: `/callback/${handle.id}`,
      expiresAt: new Date(NOW + 600_000).toISOString(),
      expiresAtMs: NOW + 600_000,
      localListener: true,
    }])
  })

  it("serves a known id, passing the path after the id and the query through", async () => {
    const handled: OAuthCallbackRequest[] = []
    const { callbacks } = registry()
    const handle = callbacks.open(spec(handled))
    expect(await callbacks.dispatch(handle.id, get("/auth/callback", "code=c&state=s"))).toEqual({ status: 200, html: "connected" })
    expect(handled[0]?.path).toBe("/auth/callback")
    expect(handled[0]?.query.get("state")).toBe("s")
    expect(await callbacks.dispatch(handle.id, get("/favicon.ico"))).toBeNull()
  })

  it("answers an unknown, closed or expired id with nothing and never reaches the handler", async () => {
    const handled: OAuthCallbackRequest[] = []
    const { callbacks, clock } = registry()
    expect(await callbacks.dispatch("unknown-id", get("/auth/callback"))).toBeNull()

    const closed = callbacks.open(spec(handled))
    closed.close()
    expect(await callbacks.dispatch(closed.id, get("/auth/callback"))).toBeNull()

    const expiring = callbacks.open(spec(handled))
    clock.now = NOW + 600_000
    expect(await callbacks.dispatch(expiring.id, get("/auth/callback"))).toBeNull()
    expect(handled).toEqual([])
    expect(callbacks.list()).toEqual([])
  })

  it("pushes the expiry out when another sign-in joins, never pulling it in", () => {
    const { callbacks } = registry()
    const handle = callbacks.open(spec([]))
    handle.extend(NOW + 900_000)
    handle.extend(NOW + 100_000)
    expect(callbacks.list()[0]?.expiresAtMs).toBe(NOW + 900_000)
    handle.close()
    handle.extend(NOW + 1_000_000)
    expect(callbacks.list()).toEqual([])
  })

  it("lists soonest-expiring first and drops expired listeners", () => {
    const { callbacks, clock } = registry()
    const later = callbacks.open(spec([], { expiresAt: NOW + 900_000 }))
    const sooner = callbacks.open(spec([], { expiresAt: NOW + 300_000 }))
    expect(callbacks.list().map(view => view.id)).toEqual([sooner.id, later.id])
    clock.now = NOW + 300_000
    expect(callbacks.list().map(view => view.id)).toEqual([later.id])
  })

  it("closes everything on shutdown", async () => {
    const { callbacks } = registry()
    const handle = callbacks.open(spec([]))
    callbacks.open(spec([]))
    callbacks.closeAll()
    expect(callbacks.list()).toEqual([])
    expect(await callbacks.dispatch(handle.id, get("/auth/callback"))).toBeNull()
  })
})
