/**
 * Browser sign-in for the admin pages when `MERIDIAN_API_KEY` is set.
 *
 * `requireAuth` reads the key from `x-api-key` / `Authorization: Bearer`.
 * A browser navigating to /profiles can send neither, so with the key set the
 * admin UI was unreachable from a browser. These tests pin the cookie path:
 *
 * - a browser navigation (GET, Accept: text/html, no key header) to a gated
 *   page is redirected to /login, not answered with a 401 JSON dead end;
 * - POST /login with the right key sets an HttpOnly, SameSite=Strict session
 *   cookie whose value is a MAC of the key, never the key; a wrong key sets
 *   nothing;
 * - the cookie satisfies requireAuth and hasValidApiKey; a wrong cookie does
 *   not; an explicit wrong header is not rescued by a valid cookie;
 * - /login and /logout are open; /logout clears the cookie;
 * - `next` is confined to a same-origin path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"

const SAVED_KEY = process.env.MERIDIAN_API_KEY
const TEST_KEY = "test-meridian-cookie-key"

beforeAll(() => {
  process.env.MERIDIAN_API_KEY = TEST_KEY
})

afterAll(() => {
  if (SAVED_KEY !== undefined) process.env.MERIDIAN_API_KEY = SAVED_KEY
  else delete process.env.MERIDIAN_API_KEY
})

const { createProxyServer } = await import("../proxy/server")
const { hasValidApiKey, sessionCookieValue, LOGIN_COOKIE } = await import("../proxy/auth")

const GATED_JSON = "/settings/api/features"
const GATED_PAGE = "/settings"
const cookieHeader = (value: string) => ({ Cookie: `${LOGIN_COOKIE}=${value}` })
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

function postLogin(app: ReturnType<typeof createProxyServer>["app"], fields: Record<string, string>, url = "http://localhost/login") {
  return app.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  }))
}

describe("admin cookie login", () => {
  it("redirects a browser navigation to a gated page to /login, keeping the target", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request(`http://localhost${GATED_PAGE}?tab=routing`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`${GATED_PAGE}?tab=routing`)}`)
  })

  it("still answers a script or API client with 401 JSON", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request(`http://localhost${GATED_JSON}`))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("authentication_error")
    // A browser Accept header with a wrong explicit key is an API client with a bad key, not a navigation.
    const withHeader = await app.fetch(new Request(`http://localhost${GATED_PAGE}`, {
      headers: { Accept: "text/html", "x-api-key": "wrong" },
    }))
    expect(withHeader.status).toBe(401)
  })

  it("serves the sign-in page without a key", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/login?next=%2Fprofiles"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const html = await res.text()
    expect(html).toContain('action="/login"')
    expect(html).toContain('name="key"')
    expect(html).toContain('name="next" value="/profiles"')
  })

  it("refuses a wrong key without setting a cookie", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await postLogin(app, { key: "not-the-key", next: "/profiles" })
    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.text()).toContain("not accepted")
  })

  it("accepts the right key with an HttpOnly, SameSite=Strict cookie that is not the key", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await postLogin(app, { key: TEST_KEY, next: "/profiles" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/profiles")
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=")
    expect(cookie).not.toContain(TEST_KEY)
    // Plain http: no Secure flag, or the LAN deployment could never read the cookie back.
    expect(cookie).not.toContain("Secure")
    const value = cookie.slice(LOGIN_COOKIE.length + 1).split(";")[0]
    expect(value).toBe(sessionCookieValue(TEST_KEY))
  })

  it("marks the cookie Secure when the request came over https", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await postLogin(app, { key: TEST_KEY }, "https://meridian.example/login")
    expect(res.status).toBe(302)
    expect(res.headers.get("set-cookie") ?? "").toContain("Secure")
  })

  it("lets the cookie through requireAuth on a gated route", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request(`http://localhost${GATED_JSON}`, {
      headers: cookieHeader(sessionCookieValue(TEST_KEY)),
    }))
    expect(res.status).toBe(200)
  })

  it("rejects a wrong cookie, and a wrong header beside a valid cookie", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const wrongCookie = await app.fetch(new Request(`http://localhost${GATED_JSON}`, {
      headers: cookieHeader(sessionCookieValue("another-key")),
    }))
    expect(wrongCookie.status).toBe(401)
    const rawKeyAsCookie = await app.fetch(new Request(`http://localhost${GATED_JSON}`, {
      headers: cookieHeader(TEST_KEY),
    }))
    expect(rawKeyAsCookie.status).toBe(401)
    const headerWins = await app.fetch(new Request(`http://localhost${GATED_JSON}`, {
      headers: { ...cookieHeader(sessionCookieValue(TEST_KEY)), "x-api-key": "wrong" },
    }))
    expect(headerWins.status).toBe(401)
  })

  it("hasValidApiKey accepts the cookie for the standard-Request backends", () => {
    expect(hasValidApiKey(new Headers(cookieHeader(sessionCookieValue(TEST_KEY))))).toBe(true)
    expect(hasValidApiKey(new Headers(cookieHeader("nonsense")))).toBe(false)
    expect(hasValidApiKey(new Headers({ "x-api-key": TEST_KEY }))).toBe(true)
    expect(hasValidApiKey(new Headers())).toBe(false)
  })

  it("sends an already signed-in browser straight to its target", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/login?next=%2Fsettings", {
      headers: cookieHeader(sessionCookieValue(TEST_KEY)),
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/settings")
  })

  it("confines `next` to a same-origin path", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    for (const next of ["//evil.example/x", "https://evil.example", "/login", "settings", ""]) {
      const res = await postLogin(app, { key: TEST_KEY, next })
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("/profiles")
    }
  })

  it("clears the cookie on logout", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/logout", {
      method: "POST",
      headers: cookieHeader(sessionCookieValue(TEST_KEY)),
    }))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login")
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true)
    expect(cookie).toMatch(/Max-Age=0|Expires=/)
  })

  it("is inert when MERIDIAN_API_KEY is unset", async () => {
    delete process.env.MERIDIAN_API_KEY
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const page = await app.fetch(new Request("http://localhost/login?next=%2Fprofiles"))
      expect(page.status).toBe(302)
      expect(page.headers.get("location")).toBe("/profiles")
      const post = await postLogin(app, { key: "anything" })
      expect(post.status).toBe(302)
      expect(post.headers.get("set-cookie")).toBeNull()
      expect(hasValidApiKey(new Headers())).toBe(true)
    } finally {
      process.env.MERIDIAN_API_KEY = TEST_KEY
    }
  })
})
