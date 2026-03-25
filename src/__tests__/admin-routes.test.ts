import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"
import { createAdminRoutes } from "../keys/routes"
import { initAdmin, generateJwt } from "../keys/auth"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Admin routes auth", () => {
  const MASTER_KEY = "test-master-key-123"
  let app: Hono
  let jwt: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "admin-routes-test-"))
    process.env.MERIDIAN_ADMIN_FILE = join(tmpDir, "admin.json")
    process.env.MERIDIAN_MASTER_KEY = MASTER_KEY
    initAdmin()
    jwt = generateJwt()
    app = new Hono()
    app.route("/admin", createAdminRoutes())
  })

  afterEach(() => {
    delete process.env.MERIDIAN_ADMIN_FILE
    delete process.env.MERIDIAN_MASTER_KEY
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("serves dashboard HTML without auth", async () => {
    const res = await app.fetch(new Request("http://localhost/admin"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("Admin Dashboard")
  })

  it("rejects API calls without JWT", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/keys"))
    expect(res.status).toBe(401)
  })

  it("accepts API calls with valid JWT", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/keys", {
      headers: { "Authorization": `Bearer ${jwt}` }
    }))
    expect(res.status).toBe(200)
  })

  it("rejects API calls with invalid JWT", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/keys", {
      headers: { "Authorization": "Bearer invalid.jwt.token" }
    }))
    expect(res.status).toBe(401)
  })

  it("login returns JWT with valid master key", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: MASTER_KEY }),
    }))
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.token).toBeTruthy()
    expect(data.token.split(".")).toHaveLength(3)
  })

  it("login rejects wrong master key", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "wrong-key" }),
    }))
    expect(res.status).toBe(401)
  })

  it("GET /admin/models returns model catalog", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/models", {
      headers: { "Authorization": `Bearer ${jwt}` }
    }))
    expect(res.status).toBe(200)
    const models = await res.json() as any
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
  })

  it("GET /admin/settings returns settings", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/settings", {
      headers: { "Authorization": `Bearer ${jwt}` }
    }))
    expect(res.status).toBe(200)
    const settings = await res.json() as any
    expect(settings.maxConcurrent).toBeGreaterThan(0)
  })
})
