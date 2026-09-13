/**
 * Route-level tests for the model-pricing settings API (#629 follow-up).
 * The pure logic is covered in pricing-unit/pricing-store-unit; these pin the
 * HTTP contract: shapes, validation status codes, and the malformed-JSON 400.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installLoggerMock } from "./loggerMock"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

const { createProxyServer } = await import("../proxy/server")
const { resetPricingOverridesCache } = await import("../telemetry/pricingStore")

describe("pricing settings routes", () => {
  let dir: string
  let saved: string | undefined
  let app: any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-pricing-routes-"))
    saved = process.env.MERIDIAN_PRICING_CONFIG
    process.env.MERIDIAN_PRICING_CONFIG = join(dir, "model-pricing.json")
    resetPricingOverridesCache()
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.MERIDIAN_PRICING_CONFIG
    else process.env.MERIDIAN_PRICING_CONFIG = saved
    resetPricingOverridesCache()
    rmSync(dir, { recursive: true, force: true })
  })

  const get = () => app.fetch(new Request("http://localhost/settings/api/pricing"))
  const put = (model: string, body: string) =>
    app.fetch(new Request(`http://localhost/settings/api/pricing/${encodeURIComponent(model)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body,
    }))
  const del = (model: string) =>
    app.fetch(new Request(`http://localhost/settings/api/pricing/${encodeURIComponent(model)}`, { method: "DELETE" }))

  it("GET returns builtin table + overrides", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.builtin["claude-opus-5"]).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(body.builtin["claude-opus-4-8"]).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(body.overrides).toEqual({})
  })

  it("PUT persists an override; DELETE removes it", async () => {
    const putRes = await put("my-model", JSON.stringify({ inputPerMTok: 2, outputPerMTok: 4 }))
    expect(putRes.status).toBe(200)
    resetPricingOverridesCache()
    let body = await (await get()).json() as any
    expect(body.overrides["my-model"]).toMatchObject({ inputPerMTok: 2, outputPerMTok: 4 })

    expect((await del("my-model")).status).toBe(200)
    resetPricingOverridesCache()
    body = await (await get()).json() as any
    expect(body.overrides).toEqual({})
  })

  it("PUT rejects invalid rates with 400 + message", async () => {
    const res = await put("my-model", JSON.stringify({ inputPerMTok: -1, outputPerMTok: 4 }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain("non-negative")
  })

  it("PUT rejects malformed JSON with 400, not 500", async () => {
    const res = await put("my-model", "{not json")
    expect(res.status).toBe(400)
  })

  it("PUT rejects an empty model key with 400", async () => {
    const res = await put("   ", JSON.stringify({ inputPerMTok: 1, outputPerMTok: 2 }))
    expect(res.status).toBe(400)
  })
})
