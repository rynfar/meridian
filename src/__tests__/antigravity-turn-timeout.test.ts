import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, resolveBackendConfig, type AntigravityOptions } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
const nap = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const initial = {
  model: "fixture-model", messages: [{ role: "user", content: "Get receipt" }],
  tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
}
function fixture(options: AntigravityOptions) {
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, pendingToolTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { runtime, send }
}

describe.skipIf(process.platform === "win32")("Antigravity turn deadlines", () => {
  it("pauses the model deadline while waiting for client results and retains the same process", async () => {
    const { runtime, send } = fixture({ turnTimeoutMs: 3000 })
    const first = await send(initial)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: Array<{ type: string; id: string }> }
    const run = [...runtime.runs.values()][0]!
    const args = run.child!.spawnargs
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("7200s")
    await nap(3300)
    expect(runtime.runs.get(run.id)).toBe(run)
    const response = await send({ ...initial, messages: [...initial.messages,
      { role: "assistant", content: reply.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: reply.content[0]!.id, content: "receipt" }] },
    ] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("receipt")
    expect(runtime.runs.get(run.id)).toBe(run)
  })

  it("retains a wall-clock cap even while waiting for the client", async () => {
    const { runtime, send } = fixture({ turnTimeoutMs: 3000, turnMaxDurationMs: 7000 })
    const response = await send(initial)
    expect(response.status).toBe(200)
    const run = [...runtime.runs.values()][0]!
    const started = Date.now()
    await run.settled
    expect(Date.now() - started).toBeGreaterThan(1000)
    expect(runtime.runs.size).toBe(0)
  }, 20000)

  it("clears the absolute deadline on completion and starts fresh clocks for a warm user turn", async () => {
    const { runtime, send } = fixture({ turnTimeoutMs: 3000, turnMaxDurationMs: 4000, idleConversationMs: 10000 })
    const body = { ...initial, tools: [], messages: [{ role: "user", content: "First" }] }
    const first = await send(body)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: Array<{ type: string; text: string }> }
    const run = [...runtime.runs.values()][0]!
    await nap(4300)
    expect(runtime.runs.get(run.id)).toBe(run)
    expect(runtime.failed).toBe(0)
    const next = await send({ ...body, messages: [...body.messages,
      { role: "assistant", content: reply.content }, { role: "user", content: "Second" },
    ] })
    expect(next.status).toBe(200)
    await next.text()
    expect(runtime.reused).toBe(1)
    expect(runtime.runs.get(run.id)).toBe(run)
  })

  it("starts a model deadline when a warm user turn stalls", async () => {
    const { send } = fixture({ turnTimeoutMs: 3000, idleConversationMs: 10000 })
    const body = { ...initial, tools: [], messages: [{ role: "user", content: "First" }] }
    const first = await send(body)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: Array<{ type: string; text: string }> }
    const stalled = await send({ ...body, messages: [...body.messages,
      { role: "assistant", content: reply.content }, { role: "user", content: "HANG" },
    ] })
    expect(stalled.status).toBe(504)
  }, 10000)

  it("grants the full budget to each model phase even when their combined time exceeds one budget", async () => {
    const { send } = fixture({ turnTimeoutMs: 5000, turnMaxDurationMs: 15000 })
    const request = { ...initial, messages: [{ role: "user", content: "MODEL_DELAY" }] }
    const first = await send(request)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: Array<{ type: string; id: string }> }
    const response = await send({ ...request, messages: [...request.messages,
      { role: "assistant", content: reply.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: reply.content[0]!.id, content: "receipt" }] },
    ] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("receipt")
  }, 20000)

  it("resolves the absolute cap and rejects invalid values", () => {
    const saved = process.env.MERIDIAN_AGY_TURN_MAX_DURATION_MS
    try {
      process.env.MERIDIAN_AGY_TURN_MAX_DURATION_MS = "12345"
      expect(resolveBackendConfig({ backend: "antigravity" }).antigravity?.turnMaxDurationMs).toBe(12345)
      expect(resolveBackendConfig({ backend: "antigravity", antigravity: { turnMaxDurationMs: 67890 } }).antigravity?.turnMaxDurationMs).toBe(67890)
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_AGY_TURN_MAX_DURATION_MS
      else process.env.MERIDIAN_AGY_TURN_MAX_DURATION_MS = saved
    }
    for (const turnMaxDurationMs of [0, 1.5, 2_147_483_648]) {
      expect(() => new AntigravityRuntime({ turnMaxDurationMs })).toThrow("absolute turn deadline")
    }
  })

  it("validates the model-phase deadline before the absolute cap and keeps the two-hour default independent", () => {
    for (const turnTimeoutMs of [NaN, Infinity, 0, -1, 1.5, 2_147_483_648]) {
      expect(() => new AntigravityRuntime({ turnTimeoutMs })).toThrow("model phase deadline")
    }
    const runtime = new AntigravityRuntime({ turnTimeoutMs: 9_000_000 })
    closing.push(() => runtime.close())
    expect(runtime.turnMaxDurationMs).toBe(7_200_000)
  })

  it("still bounds a model phase with no client tools", async () => {
    const { send } = fixture({ turnTimeoutMs: 1000 })
    const response = await send({ ...initial, tools: [], messages: [{ role: "user", content: "HANG" }] })
    expect(response.status).toBe(504)
  })
})
