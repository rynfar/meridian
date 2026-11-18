import { describe, expect, it } from "bun:test"
import * as agProtocol from "../proxy/backends/antigravityProtocol"
const { parseAgRequest } = agProtocol
import { agOpenai } from "../proxy/backends/antigravityOpenai"
import { AgResponseStore } from "../proxy/backends/antigravityResponses"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, resolveBackendConfig } from "../proxy/types"
import { fileURLToPath } from "node:url"

const base = () => ({
  model: "fixture-model-high",
  messages: [{ role: "user" as const, content: "hello" }],
})

describe("Antigravity effort and thinking budget mapping", () => {
  it("clamps xhigh, max, and minimal effort levels instead of rejecting with 400", () => {
    const xhigh = parseAgRequest({ ...base(), output_config: { effort: "xhigh" } })
    expect(xhigh.output_config?.effort).toBe("high")

    const max = parseAgRequest({ ...base(), output_config: { effort: "max" } })
    expect(max.output_config?.effort).toBe("high")

    const minimal = parseAgRequest({ ...base(), model: "gemini-fixture-low", output_config: { effort: "minimal" } })
    expect(minimal.output_config?.effort).toBe("low")
    expect(minimal.model).toBe("gemini-fixture-low")
  })

  it("clamps OpenAI reasoning_effort and Responses reasoning.effort", async () => {
    const store = new AgResponseStore()
    const captured: ReturnType<typeof parseAgRequest>[] = []
    const captureMessages = async (req: Request) => {
      captured.push(parseAgRequest(await req.json()))
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "fixture-model-high", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
    }

    const chatRes = await agOpenai(
      new Request("http://local/v1/chat/completions", { method: "POST" }),
      { model: "fixture-model-high", messages: [{ role: "user", content: "hello" }], reasoning_effort: "xhigh" },
      false,
      captureMessages,
      store,
    )
    expect(chatRes.status).toBe(200)
    expect(captured[0]?.output_config?.effort).toBe("high")

    const respRes = await agOpenai(
      new Request("http://local/v1/responses", { method: "POST" }),
      { model: "fixture-model-high", input: [{ role: "user", content: "hello" }], reasoning: { effort: "max" } },
      true,
      captureMessages,
      store,
    )
    expect(respRes.status).toBe(200)
    expect(captured[1]?.output_config?.effort).toBe("high")
  })

  it("defaults adaptThinkingBudgets to false everywhere unless MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1", () => {
    const prev = process.env.MERIDIAN_AGY_ADAPT_THINKING_BUDGETS
    try {
      delete process.env.MERIDIAN_AGY_ADAPT_THINKING_BUDGETS
      expect(resolveBackendConfig({ backend: "antigravity" }).antigravity?.adaptThinkingBudgets).toBe(false)
      expect(() => parseAgRequest({ ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 4096 } })).toThrow("MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1")
      process.env.MERIDIAN_AGY_ADAPT_THINKING_BUDGETS = "1"
      expect(resolveBackendConfig({ backend: "antigravity" }).antigravity?.adaptThinkingBudgets).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.MERIDIAN_AGY_ADAPT_THINKING_BUDGETS
      else process.env.MERIDIAN_AGY_ADAPT_THINKING_BUDGETS = prev
    }
  })

  it("maps numeric thinking budgets to the closest supported model slug from discovery when unsuffixed", () => {
    const partialModels = ["gemini-partial-low", "gemini-partial-high"]
    const mediumToHigh = parseAgRequest(
      { ...base(), model: "gemini-partial", thinking: { type: "enabled", budget_tokens: 4096 } },
      true,
      partialModels,
    )
    expect(mediumToHigh.model).toBe("gemini-partial-high")
    expect(mediumToHigh.output_config?.effort).toBe("high")

    const lowMedModels = ["gemini-lowmed-low", "gemini-lowmed-medium"]
    const highToMed = parseAgRequest(
      { ...base(), model: "gemini-lowmed", thinking: { type: "enabled", budget_tokens: 16384 } },
      true,
      lowMedModels,
    )
    expect(highToMed.model).toBe("gemini-lowmed-medium")
    expect(highToMed.output_config?.effort).toBe("medium")
  })

  it("maps output_config.effort across discovered Gemini variants when unsuffixed and clamps unsupported levels", () => {
    const partialModels = ["gemini-partial-low", "gemini-partial-high"]
    const mapped = parseAgRequest(
      { ...base(), model: "gemini-partial", output_config: { effort: "max" } },
      false,
      partialModels,
    )
    expect(mapped.model).toBe("gemini-partial-high")
    expect(mapped.output_config?.effort).toBe("high")

    const xhigh = parseAgRequest(
      { ...base(), model: "gemini-partial", output_config: { effort: "xhigh" } },
      false,
      partialModels,
    )
    expect(xhigh.model).toBe("gemini-partial-high")
    expect(xhigh.output_config?.effort).toBe("high")

    const clamped = parseAgRequest(
      { ...base(), model: "gemini-partial", output_config: { effort: "medium" } },
      false,
      partialModels,
    )
    expect(clamped.model).toBe("gemini-partial-high")
    expect(clamped.output_config?.effort).toBe("high")
  })

  it("maps xhigh against the agy 1.5.13 model catalog and falls back to high", () => {
    const models = [
      "gemini-4-neon", "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh",
      "gemini-4-neon-flash", "gemini-4-neon-flash-low", "gemini-4-neon-flash-medium", "gemini-4-neon-flash-high", "gemini-4-neon-flash-xhigh",
    ]
    const xhigh = parseAgRequest({ ...base(), model: "gemini-4-neon", output_config: { effort: "xhigh" } }, false, models)
    expect(xhigh.model).toBe("gemini-4-neon-xhigh")
    expect(xhigh.output_config?.effort).toBe("xhigh")

    const max = parseAgRequest({ ...base(), model: "gemini-4-neon-flash", output_config: { effort: "max" } }, false, models)
    expect(max.model).toBe("gemini-4-neon-flash-xhigh")
    expect(max.output_config?.effort).toBe("xhigh")

    const noXhigh = parseAgRequest({ ...base(), model: "gemini-4-neon", output_config: { effort: "xhigh" } }, false, models.filter(model => !model.endsWith("-xhigh")))
    expect(noXhigh.model).toBe("gemini-4-neon-high")
    expect(noXhigh.output_config?.effort).toBe("high")

    const suffixWins = parseAgRequest({ ...base(), model: "gemini-4-neon-xhigh", output_config: { effort: "low" } }, false, models)
    expect(suffixWins.model).toBe("gemini-4-neon-xhigh")
    expect(suffixWins.output_config?.effort).toBe("xhigh")
  })

  it("keeps explicit model level suffix authoritative over output_config.effort while preserving opt-in numeric budget remapping", () => {
    const highWithLowEffort = parseAgRequest({ ...base(), model: "gemini-fixture-high", output_config: { effort: "low" } })
    expect(highWithLowEffort.model).toBe("gemini-fixture-high")
    expect(highWithLowEffort.output_config?.effort).toBe("high")

    const suffixedBudget = parseAgRequest(
      { ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 31999 } },
      true,
      ["gemini-fixture-low", "gemini-fixture-medium", "gemini-fixture-high"],
    )
    expect(suffixedBudget.model).toBe("gemini-fixture-high")
    expect(suffixedBudget.output_config?.effort).toBe("high")
    expect(suffixedBudget.thinking).toEqual({ type: "adaptive" })

    expect(() => parseAgRequest({ ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 31999 } }, false)).toThrow("MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1")
    expect(() => parseAgRequest({ ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 0 } }, true)).toThrow()
  })

  it("skips model discovery for non-effort/format-only/malformed/explicit-suffix-effort requests and propagates discovery errors", async () => {
    const { resolveAgRequest } = agProtocol
    let probes = 0
    const discover = async () => { probes++; return ["gemini-partial-low", "gemini-partial-high"] }

    await expect(resolveAgRequest({ ...base(), messages: [] }, true, discover)).rejects.toThrow()
    await resolveAgRequest({ ...base(), thinking: { type: "disabled" } }, true, discover)
    await resolveAgRequest({ ...base(), thinking: { type: "adaptive" } }, true, discover)
    await resolveAgRequest({ ...base(), output_config: { format: { type: "json_schema", schema: {} } } }, true, discover)
    await resolveAgRequest({ ...base(), model: "gemini-partial-low", output_config: { effort: "high" } }, false, discover)
    await expect(resolveAgRequest({ ...base(), model: "gemini-partial-low", thinking: { type: "enabled", budget_tokens: 4096 } }, false, discover)).rejects.toThrow("ADAPT_THINKING_BUDGETS")
    expect(probes).toBe(0)

    await expect(resolveAgRequest(
      { ...base(), model: "gemini-partial-low", thinking: { type: "enabled", budget_tokens: 4096 } },
      true,
      async () => { throw new Error("probe failed") },
    )).rejects.toThrow("probe failed")

    const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
    const defaultRuntime = new AntigravityRuntime({ executable, reuseConversations: false, turnTimeoutMs: 10000 })
    const defaultServer = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, defaultRuntime)
    try {
      const health = await (await defaultServer.app.fetch(new Request("http://local/health"))).json() as { capabilities: { thinkingBudgets: unknown } }
      expect(health.capabilities.thinkingBudgets).toBe(false)
      const rejectedCount = await defaultServer.app.fetch(new Request("http://local/v1/messages/count_tokens", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 4096 } }),
      }))
      expect(rejectedCount.status).toBe(400)
    } finally {
      await defaultServer.closeBackend()
    }

    const runtime = new AntigravityRuntime({ executable, reuseConversations: false, adaptThinkingBudgets: true, turnTimeoutMs: 10000 })
    let countProbes = 0
    runtime.availableModels = async () => { countProbes++; return ["gemini-fixture-low"] }
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    try {
      const res = await server.app.fetch(new Request("http://local/v1/messages/count_tokens", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 4096 } }),
      }))
      expect(res.status).toBe(200)
      expect(countProbes).toBe(0)
    } finally {
      await server.closeBackend()
    }
  })

  it("restricts effort remapping to Gemini families and emits adaptation headers only when rewritten", async () => {
    expect(() => parseAgRequest(
      { ...base(), model: "claude-sonnet-low", output_config: { effort: "high" } },
      true,
      ["claude-sonnet-low", "claude-sonnet-high"],
    )).toThrow("model slug")

    expect(() => parseAgRequest(
      { ...base(), model: "gemini-fixture-low", thinking: { type: "enabled", budget_tokens: 4096 } },
      false,
    )).toThrow("MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1")

    const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
    const runtime = new AntigravityRuntime({ executable, reuseConversations: false, adaptThinkingBudgets: true, turnTimeoutMs: 10000 })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    try {
      const plain = await server.app.fetch(new Request("http://local/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "fixture-model" }),
      }))
      expect(plain.status).toBe(200)
      expect(plain.headers.get("x-meridian-thinking-budgets")).toBeNull()
      expect(plain.headers.get("x-meridian-effective-model")).toBeNull()
      expect(plain.headers.get("x-meridian-effective-effort")).toBeNull()

      const noop = await server.app.fetch(new Request("http://local/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "gemini-fixture-high", output_config: { effort: "high" } }),
      }))
      expect(noop.status).toBe(200)
      expect(noop.headers.get("x-meridian-thinking-budgets")).toBeNull()
      expect(noop.headers.get("x-meridian-effective-model")).toBeNull()
      expect(noop.headers.get("x-meridian-effective-effort")).toBeNull()

      const rewritten = await server.app.fetch(new Request("http://local/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "gemini-fixture", output_config: { effort: "max" } }),
      }))
      expect(rewritten.status).toBe(200)
      expect(rewritten.headers.get("x-meridian-thinking-budgets")).toBeNull()
      expect(rewritten.headers.get("x-meridian-effective-model")).toBe("gemini-fixture-high")
      expect(rewritten.headers.get("x-meridian-effective-effort")).toBe("high")

      const suffixWins = await server.app.fetch(new Request("http://local/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...base(), model: "gemini-fixture-high", output_config: { effort: "low" } }),
      }))
      expect(suffixWins.status).toBe(200)
      expect(suffixWins.headers.get("x-meridian-thinking-budgets")).toBeNull()
      expect(suffixWins.headers.get("x-meridian-effective-model")).toBe("gemini-fixture-high")
      expect(suffixWins.headers.get("x-meridian-effective-effort")).toBe("high")
    } finally {
      await server.closeBackend()
    }
  })
})
