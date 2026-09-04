/**
 * Unit tests for statusProbe.ts. The HTTP calls go through an injected
 * fetch, so nothing here binds a port or talks to a running instance.
 */

import { describe, it, expect } from "bun:test"
import {
  describeForeignResponse,
  formatConflictMessage,
  formatStatusMessage,
  isMeridianHealthBody,
  isPortAvailable,
  probeMeridian,
  probeUrlBase,
} from "../proxy/statusProbe"

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** A fetch that answers from a path -> Response table and records the calls. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; apiKey: string | null }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    calls.push({ url, apiKey: headers.get("x-api-key") })
    const path = new URL(url).pathname
    const route = routes[path]
    if (!route) throw new Error(`connect ECONNREFUSED ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const HEALTH_BODY = {
  status: "healthy",
  version: "1.60.0",
  auth: { loggedIn: true, email: "someone@example.com", subscriptionType: "max" },
  mode: "internal",
}

describe("probeUrlBase", () => {
  it("keeps an ordinary host", () => {
    expect(probeUrlBase("127.0.0.1", 3456)).toBe("http://127.0.0.1:3456")
  })

  it("connects to loopback for a wildcard bind, which is not itself connectable", () => {
    expect(probeUrlBase("0.0.0.0", 3456)).toBe("http://127.0.0.1:3456")
    expect(probeUrlBase("::", 3456)).toBe("http://[::1]:3456")
  })

  it("brackets an IPv6 literal", () => {
    expect(probeUrlBase("::1", 3456)).toBe("http://[::1]:3456")
  })

  it("honours a non-default port", () => {
    expect(probeUrlBase("127.0.0.1", 3457)).toBe("http://127.0.0.1:3457")
  })
})

describe("isMeridianHealthBody", () => {
  it("accepts a healthy instance", () => {
    expect(isMeridianHealthBody(HEALTH_BODY)).toBe(true)
  })

  it("accepts a logged-out instance, which answers 503 with the same shape", () => {
    expect(isMeridianHealthBody({ status: "unhealthy", version: "1.60.0", auth: { loggedIn: false } })).toBe(true)
  })

  it("accepts a degraded instance", () => {
    expect(isMeridianHealthBody({ status: "degraded", version: "1.60.0" })).toBe(true)
  })

  it("accepts Meridian's own auth rejection", () => {
    expect(isMeridianHealthBody({ type: "error", error: { type: "authentication_error", message: "nope" } })).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isMeridianHealthBody(null)).toBe(false)
    expect(isMeridianHealthBody("ok")).toBe(false)
    expect(isMeridianHealthBody({ status: "ok" })).toBe(false)
    expect(isMeridianHealthBody({ status: "healthy" })).toBe(false)
    expect(isMeridianHealthBody({ version: "1.0.0" })).toBe(false)
  })
})

describe("describeForeignResponse", () => {
  it("reports status, server and content type — never a body", () => {
    const headers = new Headers({ server: "SimpleHTTP/0.6 Python/3.13.1", "content-type": "text/html; charset=utf-8" })
    expect(describeForeignResponse(200, "OK", headers)).toBe("HTTP 200 OK, server: SimpleHTTP/0.6 Python/3.13.1, text/html")
  })

  it("copes with a bare response", () => {
    expect(describeForeignResponse(404, "", new Headers())).toBe("HTTP 404")
  })
})

describe("probeMeridian", () => {
  it("identifies Meridian and collects what the page shows", async () => {
    const { impl } = stubFetch({
      "/health": () => jsonResponse(HEALTH_BODY),
      "/profiles/list": () => jsonResponse({ profiles: [{ id: "primary", isActive: true }] }),
      "/v1/usage/quota/all": () => jsonResponse({ profiles: [] }),
      "/telemetry/summary": () => jsonResponse({ totalRequests: 12 }),
    })
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl })
    expect(result.kind).toBe("meridian")
    if (result.kind !== "meridian") throw new Error("unreachable")
    expect(result.snapshot.health?.mode).toBe("internal")
    expect(result.snapshot.summary?.totalRequests).toBe(12)
    expect(result.snapshot.unavailable).toBeUndefined()
  })

  it("identifies a logged-out instance from a 503, which is not 'not Meridian'", async () => {
    const { impl } = stubFetch({
      "/health": () => jsonResponse({ status: "unhealthy", version: "1.60.0", auth: { loggedIn: false } }, 503),
      "/profiles/list": () => jsonResponse({ profiles: [] }),
      "/v1/usage/quota/all": () => jsonResponse({ profiles: [] }),
      "/telemetry/summary": () => jsonResponse({}),
    })
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl })
    expect(result.kind).toBe("meridian")
  })

  it("probes the port it was told to, not the default", async () => {
    const { impl, calls } = stubFetch({
      "/health": () => jsonResponse(HEALTH_BODY),
      "/profiles/list": () => jsonResponse({}),
      "/v1/usage/quota/all": () => jsonResponse({}),
      "/telemetry/summary": () => jsonResponse({}),
    })
    await probeMeridian("127.0.0.1", 3457, { fetchImpl: impl })
    expect(calls.every((c) => c.url.startsWith("http://127.0.0.1:3457/"))).toBe(true)
  })

  it("sends the API key on the gated reads", async () => {
    const { impl, calls } = stubFetch({
      "/health": () => jsonResponse(HEALTH_BODY),
      "/profiles/list": () => jsonResponse({}),
      "/v1/usage/quota/all": () => jsonResponse({}),
      "/telemetry/summary": () => jsonResponse({}),
    })
    await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl, apiKey: "secret" })
    expect(calls.every((c) => c.apiKey === "secret")).toBe(true)
  })

  it("still identifies an instance that refuses the gated reads, and says why", async () => {
    const rejection = { type: "error", error: { type: "authentication_error", message: "Invalid or missing API key" } }
    const { impl } = stubFetch({
      "/health": () => jsonResponse(HEALTH_BODY),
      "/profiles/list": () => jsonResponse(rejection, 401),
      "/v1/usage/quota/all": () => jsonResponse(rejection, 401),
      "/telemetry/summary": () => jsonResponse(rejection, 401),
    })
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl })
    expect(result.kind).toBe("meridian")
    if (result.kind !== "meridian") throw new Error("unreachable")
    expect(result.snapshot.unavailable?.accounts).toContain("MERIDIAN_API_KEY")
    expect(result.snapshot.unavailable?.traffic).toContain("MERIDIAN_API_KEY")
  })

  it("identifies Meridian even when /health itself is gated", async () => {
    const rejection = { type: "error", error: { type: "authentication_error", message: "Invalid or missing API key" } }
    const { impl } = stubFetch({
      "/health": () => jsonResponse(rejection, 401),
      "/profiles/list": () => jsonResponse(rejection, 401),
      "/v1/usage/quota/all": () => jsonResponse(rejection, 401),
      "/telemetry/summary": () => jsonResponse(rejection, 401),
    })
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl })
    expect(result.kind).toBe("meridian")
    if (result.kind !== "meridian") throw new Error("unreachable")
    expect(result.snapshot.health).toBeNull()
  })

  it("reports a foreign listener without quoting its body", async () => {
    const { impl } = stubFetch({
      "/health": () =>
        new Response("<html>Directory listing</html>", {
          status: 404,
          statusText: "File not found",
          headers: { server: "SimpleHTTP/0.6 Python/3.13.1", "content-type": "text/html" },
        }),
    })
    const result = await probeMeridian("127.0.0.1", 8000, { fetchImpl: impl })
    expect(result.kind).toBe("foreign")
    if (result.kind !== "foreign") throw new Error("unreachable")
    expect(result.description).toContain("HTTP 404")
    expect(result.description).toContain("SimpleHTTP")
    expect(result.description).not.toContain("Directory listing")
  })

  it("treats a JSON server that is not Meridian as foreign", async () => {
    const { impl } = stubFetch({ "/health": () => jsonResponse({ status: "UP", db: "ok" }) })
    const result = await probeMeridian("127.0.0.1", 8080, { fetchImpl: impl })
    expect(result.kind).toBe("foreign")
  })

  it("treats a refused or wedged port as unreachable", async () => {
    const { impl } = stubFetch({})
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl })
    expect(result.kind).toBe("unreachable")
    if (result.kind !== "unreachable") throw new Error("unreachable")
    expect(result.description).toContain("ECONNREFUSED")
  })

  it("does not hang on a port that accepts and never answers", async () => {
    const impl = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation timed out.")))
      })) as unknown as typeof fetch
    const started = Date.now()
    const result = await probeMeridian("127.0.0.1", 3456, { fetchImpl: impl, timeoutMs: 50 })
    expect(result.kind).toBe("unreachable")
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe("isPortAvailable", () => {
  it("is true for a free port and false while one is held", async () => {
    const { createServer } = await import("node:net")
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve))
    const address = holder.address()
    if (address === null || typeof address === "string") throw new Error("expected a TCP address")

    expect(await isPortAvailable("127.0.0.1", address.port)).toBe(false)
    await new Promise<void>((resolve) => holder.close(() => resolve()))
    expect(await isPortAvailable("127.0.0.1", address.port)).toBe(true)
  })
})

describe("messages", () => {
  it("says what it found on a busy port, and does not dump usage", () => {
    const message = formatConflictMessage(
      { kind: "foreign", description: "HTTP 200 OK, server: SimpleHTTP/0.6 Python/3.13.1, text/html" },
      "127.0.0.1",
      8000,
    )
    expect(message).toContain("127.0.0.1:8000 is already in use")
    expect(message).toContain("it is not Meridian")
    expect(message).toContain("SimpleHTTP")
    expect(message).not.toContain("Usage:")
    expect(message).not.toContain("Commands:")
  })

  it("distinguishes a silent holder from a talkative stranger", () => {
    const message = formatConflictMessage(
      { kind: "unreachable", description: "The operation timed out." },
      "127.0.0.1",
      3456,
    )
    expect(message).toContain("did not answer")
  })

  it("tells a bare `status` that nothing is running, rather than reporting a conflict", () => {
    const message = formatStatusMessage({ kind: "unreachable", description: "ECONNREFUSED" }, "127.0.0.1", 3456)
    expect(message).toContain("no Meridian instance is listening")
    expect(message).not.toContain("already in use")
  })

  it("tells a `status` pointed at a stranger what it found", () => {
    const message = formatStatusMessage({ kind: "foreign", description: "HTTP 200 OK, text/html" }, "127.0.0.1", 8000)
    expect(message).toContain("is not Meridian")
    expect(message).toContain("HTTP 200 OK")
  })
})
