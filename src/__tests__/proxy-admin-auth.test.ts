import { beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "/usr/bin/claude",
  isClosedControllerError: () => false,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@example.com", subscriptionType: "max" }),
  hasExtendedContext: () => false,
  stripExtendedContext: (model: string) => model,
}))

const { createProxyServer } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

function createTestApp(config: Record<string, unknown> = {}) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", ...config })
  return app
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

describe("Proxy admin route auth", () => {
  beforeEach(() => {
    telemetryStore.clear()
  })

  it("keeps admin routes open when protection is disabled", async () => {
    const app = createTestApp()

    const health = await app.fetch(new Request("http://localhost/health"))
    const telemetry = await app.fetch(new Request("http://localhost/telemetry/summary"))

    expect(health.status).toBe(200)
    expect(telemetry.status).toBe(200)
  })

  it("protects health and telemetry routes with requiredApiKeys by default", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      requiredApiKeys: ["shared-admin-key"],
    })

    const denied = await app.fetch(new Request("http://localhost/health"))
    const allowed = await app.fetch(new Request("http://localhost/telemetry/summary", {
      headers: { "x-api-key": "shared-admin-key" },
    }))

    expect(denied.status).toBe(401)
    expect(allowed.status).toBe(200)
  })

  it("uses adminApiKeys when configured", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      requiredApiKeys: ["message-key"],
      adminApiKeys: ["admin-only-key"],
    })

    const wrongKey = await app.fetch(new Request("http://localhost/health", {
      headers: { "x-api-key": "message-key" },
    }))
    const rightKey = await app.fetch(new Request("http://localhost/health", {
      headers: { authorization: "Bearer admin-only-key" },
    }))

    expect(wrongKey.status).toBe(401)
    expect(rightKey.status).toBe(200)
  })

  it("accepts browser-style Basic Auth when configured", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      adminUsername: "admin",
      adminPassword: "secret",
    })

    const response = await app.fetch(new Request("http://localhost/telemetry/summary", {
      headers: { authorization: basicAuthHeader("admin", "secret") },
    }))

    expect(response.status).toBe(200)
  })

  it("returns a browser Basic Auth challenge on invalid admin credentials", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      adminUsername: "admin",
      adminPassword: "secret",
    })

    const response = await app.fetch(new Request("http://localhost/health", {
      headers: { authorization: basicAuthHeader("admin", "wrong") },
    }))
    const body = await response.json() as any

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Meridian Admin"')
    expect(body.error.type).toBe("authentication_error")
  })

  it("accepts either admin API key or Basic Auth when both are configured", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      adminApiKeys: ["admin-only-key"],
      adminUsername: "admin",
      adminPassword: "secret",
    })

    const withKey = await app.fetch(new Request("http://localhost/health", {
      headers: { "x-api-key": "admin-only-key" },
    }))
    const withBasic = await app.fetch(new Request("http://localhost/health", {
      headers: { authorization: basicAuthHeader("admin", "secret") },
    }))

    expect(withKey.status).toBe(200)
    expect(withBasic.status).toBe(200)
  })

  it("keeps the landing page route public when admin protection is enabled", async () => {
    const app = createTestApp({
      protectAdminRoutes: true,
      adminApiKeys: ["admin-only-key"],
    })

    const response = await app.fetch(new Request("http://localhost/", {
      headers: { Accept: "text/html" },
    }))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Meridian")
  })
})
