import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { agClientToolCallLimit } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const previous = process.env.MERIDIAN_AGY_MAX_TOOL_CALLS
const closing: Array<() => Promise<void>> = []
afterEach(async () => {
  if (previous === undefined) delete process.env.MERIDIAN_AGY_MAX_TOOL_CALLS
  else process.env.MERIDIAN_AGY_MAX_TOOL_CALLS = previous
  for (const close of closing.splice(0)) await close()
})
interface Reply {
  content: Array<{ type: string; id?: string; text?: string }>
  stop_reason: string
}
async function loop(count: number, limit: number, batch = false, changedEnvironment?: number) {
  process.env.MERIDIAN_AGY_MAX_TOOL_CALLS = String(limit)
  const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url)), allowToolBridge: true, reuseConversations: false, turnTimeoutMs: 60000 })
  if (changedEnvironment !== undefined) process.env.MERIDIAN_AGY_MAX_TOOL_CALLS = String(changedEnvironment)
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const body = {
    model: "fixture-model", max_tokens: 100,
    tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
    messages: [{ role: "user", content: `CLIENT_${batch ? "BATCH" : "TOOL"}_LOOP_${count}` }] as Array<{ role: string; content: unknown }>,
  }
  let calls = 0
  for (let round = 0; round <= count; round++) {
    const response = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
    const reply = await response.json() as Reply
    if (response.status !== 200) return { status: response.status, calls, complete: false }
    const tools = reply.content.filter(block => block.type === "tool_use")
    if (!tools.length) return { status: response.status, calls, complete: reply.content.some(block => block.text === "LONG_LOOP_COMPLETE") }
    calls += tools.length
    body.messages.push({ role: "assistant", content: reply.content }, { role: "user", content: tools.map(block => ({ type: "tool_result", tool_use_id: block.id, content: "ok" })) })
  }
  throw new Error("Fixture exceeded its bounded loop")
}
describe("Antigravity client tool allowance", () => {
  it("keeps the default and rejects invalid explicit limits at startup", () => {
    expect(agClientToolCallLimit({})).toBe(256)
    expect(agClientToolCallLimit({ MERIDIAN_AGY_MAX_TOOL_CALLS: "65536" })).toBe(65536)
    for (const value of ["0", "-1", "1.5", "65537", "NaN", "Infinity"]) {
      expect(() => agClientToolCallLimit({ MERIDIAN_AGY_MAX_TOOL_CALLS: value })).toThrow("MERIDIAN_AGY_MAX_TOOL_CALLS")
      process.env.MERIDIAN_AGY_MAX_TOOL_CALLS = value
      expect(() => new AntigravityRuntime()).toThrow("MERIDIAN_AGY_MAX_TOOL_CALLS")
    }
  })
  it("completes 300 sequential client calls in the same run", async () => {
    expect(await loop(300, 512)).toEqual({ status: 200, calls: 300, complete: true })
  }, 60000)
  it("completes parallel batches beyond the old cumulative allowance", async () => {
    expect(await loop(272, 512, true)).toEqual({ status: 200, calls: 272, complete: true })
  }, 60000)
  it("still enforces a configured small allowance", async () => {
    expect(await loop(4, 3)).toEqual({ status: 502, calls: 3, complete: false })
  }, 20000)
  it("captures the allowance at construction rather than rereading the environment", async () => {
    expect(await loop(4, 3, false, 512)).toEqual({ status: 502, calls: 3, complete: false })
  }, 20000)
  it("replays duplicate MCP requests even exactly at the allowance", async () => {
    expect(await loop(3, 3)).toEqual({ status: 200, calls: 3, complete: true })
  }, 20000)
  it("accepts and replays a parallel batch that exactly fills the allowance", async () => {
    expect(await loop(2, 2, true)).toEqual({ status: 200, calls: 2, complete: true })
  }, 20000)
  it("bounds new batch requests after rejected single calls fill the MCP replay ledger", async () => {
    process.env.MERIDIAN_AGY_MAX_TOOL_CALLS = "2"
    const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url)), allowToolBridge: true, turnTimeoutMs: 60000 })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(server.closeBackend)
    const response = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify({
      model: "fixture-model", tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
      messages: [{ role: "user", content: "CLIENT_LEDGER_BOUNDARY" }],
    }) }))
    expect(response.status).toBe(200)
    const reply = await response.json() as Reply
    expect(reply.stop_reason).toBe("end_turn")
    expect(reply.content).toEqual([{ type: "text", text: "LEDGER_BOUNDARY_PRESERVED" }])
  }, 20000)
  it("rejects an over-budget batch without partially dispatching it", async () => {
    expect(await loop(32, 20, true)).toEqual({ status: 502, calls: 16, complete: false })
  }, 20000)
})
