import { describe, expect, it } from "bun:test"
import {
  ChatGptTurnLedger,
  chatGptCostUsd,
  chatGptTokenFields,
  createChatGptAdmission,
  createUnpricedModelWarning,
  decorateChatGptTurn,
  fallbackTrigger,
  MAX_BUDGET_ERROR_CODE,
  stripReasoningSummaries,
  transformResponsesStream,
  type ChatGptTurnNotes,
} from "../proxy/chatgpt/parity"
import {
  CHATGPT_FEATURE_DEFAULTS,
  chatGptRenewalIntervals,
  effectiveCreditsPolicy,
  getChatGptFeatures,
  forcedReasoningSummary,
  resetChatGptFeatures,
  updateChatGptFeatures,
  validateChatGptFeatureUpdate,
  type ChatGptFeatures,
} from "../proxy/chatgpt/features"
import type { ChatGptTurnEvent } from "../proxy/backends/chatgpt"
import { computeCostEstimate, resolveModelPricing, type ModelPricing } from "../telemetry/pricing"
import type { RequestMetric } from "../telemetry/types"

const PRICING: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 0 }

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!))
      else controller.close()
    },
    cancel() { onCancel?.() },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text()
}

const REASONING_ITEM = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "**Planning**" }], encrypted_content: "gAAAA-opaque" }

const REASONING_STREAM = [
  frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
  frame("response.output_item.added", { output_index: 0, item: { ...REASONING_ITEM, summary: [] } }),
  frame("response.reasoning_summary_part.added", { item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }),
  frame("response.reasoning_summary_text.delta", { item_id: "rs_1", summary_index: 0, delta: "**Planning**" }),
  frame("response.reasoning_summary_text.done", { item_id: "rs_1", summary_index: 0, text: "**Planning**" }),
  frame("response.reasoning_summary_part.done", { item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "**Planning**" } }),
  frame("response.output_item.done", { output_index: 0, item: REASONING_ITEM }),
  frame("response.output_text.delta", { output_index: 1, delta: "Hello" }),
  frame("response.completed", {
    response: {
      id: "resp_1", status: "completed", output: [REASONING_ITEM, { type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } },
    },
  }),
]

describe("Thinking Passthrough off", () => {
  it("drops reasoning summary events and empties summaries but keeps the reasoning item and its encrypted content", async () => {
    const out = await readAll(transformResponsesStream(streamOf(REASONING_STREAM), { stripSummaries: true }))
    expect(out).not.toContain("reasoning_summary")
    expect(out).not.toContain("**Planning**")
    expect(out).toContain("gAAAA-opaque")
    expect(out).toContain('"id":"rs_1"')
    expect(out).toContain("Hello")
    const frames = out.split("\n\n").filter(Boolean)
    expect(frames).toHaveLength(5)
    for (const f of frames) expect(() => JSON.parse(f.split("\n").find(l => l.startsWith("data:"))!.slice(5))).not.toThrow()
  })

  it("survives frames split at arbitrary byte boundaries", async () => {
    const joined = REASONING_STREAM.join("")
    const chunks: string[] = []
    for (let i = 0; i < joined.length; i += 7) chunks.push(joined.slice(i, i + 7))
    const whole = await readAll(transformResponsesStream(streamOf(REASONING_STREAM), { stripSummaries: true }))
    const split = await readAll(transformResponsesStream(streamOf(chunks), { stripSummaries: true }))
    expect(split).toBe(whole)
  })

  it("leaves frames it does not change byte for byte", async () => {
    const plain = [
      frame("response.created", { response: { id: "r", output: [] } }),
      frame("response.output_text.delta", { delta: "x  y" }),
    ]
    expect(await readAll(transformResponsesStream(streamOf(plain), { stripSummaries: true }))).toBe(plain.join(""))
  })

  it("strips summaries from a non-streamed response object", () => {
    const response = { output: [structuredClone(REASONING_ITEM), { type: "message" }] }
    expect(stripReasoningSummaries(response)).toBe(true)
    expect(response.output[0]).toEqual({ ...REASONING_ITEM, summary: [] })
    expect(stripReasoningSummaries(response)).toBe(false)
  })
})

describe("Max Budget", () => {
  const features = (maxBudgetUsd: number): ChatGptFeatures => ({ ...CHATGPT_FEATURE_DEFAULTS, maxBudgetUsd })

  it("stops the stream with response.failed once the running estimate passes the budget, and cancels upstream", async () => {
    let cancelled = false
    let exceeded = 0
    const deltas = Array.from({ length: 50 }, () => frame("response.output_text.delta", { delta: "x".repeat(4000) }))
    const stream = streamOf([REASONING_STREAM[0]!, ...deltas, REASONING_STREAM.at(-1)!], () => { cancelled = true })
    const out = await readAll(transformResponsesStream(stream, {
      stripSummaries: false,
      // 1000 output tokens per delta at $10/M = $0.01 each; the budget buys five.
      budget: { limitUsd: 0.05, inputUsd: 0, outputPerMTok: 10, model: "gpt-5.6-sol", onExceeded: () => { exceeded++ } },
    }))
    const failed = out.split("\n\n").filter(Boolean).at(-1)!
    expect(failed).toStartWith("event: response.failed")
    const data = JSON.parse(failed.split("\n")[1]!.slice(5))
    expect(data.response.id).toBe("resp_1")
    expect(data.response.error.code).toBe(MAX_BUDGET_ERROR_CODE)
    // The sixth delta is the one that crosses $0.05; nothing after it is sent.
    expect(out.split("\n\n").filter(f => f.startsWith("event: response.output_text.delta"))).toHaveLength(6)
    expect(out).not.toContain("response.completed")
    expect(exceeded).toBe(1)
    expect(cancelled).toBe(true)
  })

  it("does not stop a stream that ends under the budget", async () => {
    const out = await readAll(transformResponsesStream(streamOf(REASONING_STREAM), {
      stripSummaries: false,
      budget: { limitUsd: 1, inputUsd: 0, outputPerMTok: 10, model: "gpt-5.6-sol", onExceeded: () => { throw new Error("no") } },
    }))
    expect(out).toBe(REASONING_STREAM.join(""))
  })

  it("admission refuses a turn whose input alone is over budget, before any seat", () => {
    const ledger = new ChatGptTurnLedger<object>()
    const context = {}
    const notes = ledger.open(context, features(0.0001))
    const inbound = new Request("http://x", { method: "POST", body: "{}" })
    ledger.bindInbound(inbound, context)
    const admit = createChatGptAdmission({ ledger, features: () => features(0.0001), pricing: () => PRICING })
    const refused = admit({ requestId: "r1", model: "gpt-5.6-sol", body: { model: "gpt-5.6-sol", input: "x".repeat(1000) }, headers: inbound.headers })
    expect(refused?.status).toBe(400)
    expect(notes.refusedByBudget).toBe(true)
    expect(notes.requestedModel).toBe("gpt-5.6-sol")
  })

  it("admission records the input estimate and admits a turn under budget", () => {
    const ledger = new ChatGptTurnLedger<object>()
    const context = {}
    const notes = ledger.open(context, features(1))
    const inbound = new Request("http://x", { method: "POST", body: "{}" })
    ledger.bindInbound(inbound, context)
    const admit = createChatGptAdmission({ ledger, features: () => features(1), pricing: () => PRICING })
    expect(admit({ requestId: "r1", model: "gpt-5.6-sol", body: { input: "hi" }, headers: inbound.headers })).toBeUndefined()
    expect(notes.inputEstimateUsd).toBeGreaterThan(0)
    expect(ledger.settle("r1")).toBe(notes)
    expect(ledger.settle("r1")).toBeUndefined()
  })

  it("admission estimates a long prompt at the long-context input rate", () => {
    const tiered: ModelPricing = {
      ...PRICING,
      contextTiers: [{ aboveInputTokens: 272_000, inputPerMTok: 4, outputPerMTok: 15, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5 }],
    }
    const estimateFor = (chars: number) => {
      const ledger = new ChatGptTurnLedger<object>()
      const context = {}
      const notes = ledger.open(context, features(100))
      const inbound = new Request("http://x", { method: "POST", body: "{}" })
      ledger.bindInbound(inbound, context)
      const admit = createChatGptAdmission({ ledger, features: () => features(100), pricing: () => tiered })
      admit({ requestId: "r", model: "gpt-6.1-sol", body: { input: "x".repeat(chars) }, headers: inbound.headers })
      return notes
    }
    const short = estimateFor(4 * 100_000)
    expect(short.inputEstimateTokens).toBeLessThan(272_000)
    expect(short.inputEstimateUsd).toBeCloseTo((short.inputEstimateTokens! / 1e6) * 2, 10)
    const long = estimateFor(4 * 300_000)
    expect(long.inputEstimateTokens).toBeGreaterThan(272_000)
    expect(long.inputEstimateUsd).toBeCloseTo((long.inputEstimateTokens! / 1e6) * 4, 10)
  })

  it("admits an unpriced model rather than guessing it is free", () => {
    const admit = createChatGptAdmission({ ledger: new ChatGptTurnLedger<object>(), features: () => features(0.0000001), pricing: () => null })
    expect(admit({ requestId: "r", model: "gpt-5.6-sol", body: { input: "x".repeat(10_000) }, headers: new Headers() })).toBeUndefined()
  })

  it("flags a turn whose actual usage came in over budget", () => {
    const notes = { features: features(0.001) }
    const event = turnEvent({ usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000, reasoningTokens: 900 } })
    expect(decorateChatGptTurn(event, notes, () => PRICING).error).toBe(MAX_BUDGET_ERROR_CODE)
    expect(decorateChatGptTurn(event, { features: features(1) }, () => PRICING).error).toBeNull()
  })
})

function turnEvent(overrides: Partial<ChatGptTurnEvent> = {}): ChatGptTurnEvent {
  return {
    requestId: "r", startedAt: 0, requestModel: "gpt-5.6-sol", model: "gpt-5.6-sol", seat: "seat", status: 200, stream: true,
    adaptations: [], attempts: [], usage: null, ttfbMs: null, durationMs: 1, error: null, reasoningSummaryEvents: 0, ...overrides,
  }
}

describe("cached and reasoning tokens are valued exactly once", () => {
  const usage = { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 50 }
  // 600 uncached * $2 + 400 cached * $0.20 + 200 output (reasoning inside) * $10, per 1M.
  const expected = (600 * 2 + 400 * 0.2 + 200 * 10) / 1e6

  it("maps ChatGPT usage to uncached input + cache reads + output", () => {
    expect(chatGptTokenFields(usage)).toEqual({ inputTokens: 600, cacheReadInputTokens: 400, cacheCreationInputTokens: 0, outputTokens: 200 })
  })

  it("prices the turn once per token in the budget", () => {
    expect(chatGptCostUsd(usage, PRICING)).toBeCloseTo(expected, 12)
  })

  it("prices the recorded telemetry row identically in the dashboard estimate", () => {
    const metric = { requestId: "r", timestamp: 0, model: "gpt-5.6-sol", requestModel: "gpt-5.6-sol", mode: "stream", isResume: false,
      isPassthrough: true, status: 200, queueWaitMs: 0, proxyOverheadMs: 0, ttfbMs: null, upstreamDurationMs: 0, totalDurationMs: 0,
      contentBlocks: 0, textEvents: 0, error: null, ...chatGptTokenFields(usage), reasoningOutputTokens: usage.reasoningTokens } satisfies RequestMetric
    const estimate = computeCostEstimate([metric], { "gpt-5.6-sol": PRICING })
    expect(estimate.totalUsd).toBeCloseTo(expected, 12)
  })

  it("values a real gpt-5.6-sol turn once per token at its built-in list price", () => {
    const rates = resolveModelPricing("gpt-5.6-sol")!
    expect(rates).toMatchObject({ inputPerMTok: 4, cacheReadPerMTok: 0.4, outputPerMTok: 20 })
    const listPrice = (600 * 4 + 400 * 0.4 + 200 * 20) / 1e6
    expect(chatGptCostUsd(usage, rates)).toBeCloseTo(listPrice, 12)
    const metric = { requestId: "r", timestamp: 0, model: "gpt-5.6-sol", requestModel: "gpt-5.6-sol", mode: "stream", isResume: false,
      isPassthrough: true, status: 200, queueWaitMs: 0, proxyOverheadMs: 0, ttfbMs: null, upstreamDurationMs: 0, totalDurationMs: 0,
      contentBlocks: 0, textEvents: 0, error: null, ...chatGptTokenFields(usage), reasoningOutputTokens: usage.reasoningTokens } satisfies RequestMetric
    expect(computeCostEstimate([metric]).totalUsd).toBeCloseTo(listPrice, 12)
    // Reasoning tokens are already inside output: recording them does not move the price.
    const { reasoningOutputTokens: _, ...withoutReasoning } = metric
    expect(computeCostEstimate([withoutReasoning]).totalUsd).toBeCloseTo(listPrice, 12)
  })

  it("prices a fallback turn at the model that served it, not the one the client asked for", () => {
    const metric = { requestId: "r", timestamp: 0, model: "gpt-5.4", requestModel: "gpt-5.6-sol", fallbackFromModel: "gpt-5.6-sol",
      mode: "stream", isResume: false, isPassthrough: true, status: 200, queueWaitMs: 0, proxyOverheadMs: 0, ttfbMs: null,
      upstreamDurationMs: 0, totalDurationMs: 0, contentBlocks: 0, textEvents: 0, error: null, ...chatGptTokenFields(usage) } satisfies RequestMetric
    expect(computeCostEstimate([metric]).totalUsd).toBeCloseTo((600 * 2.5 + 400 * 0.25 + 200 * 15) / 1e6, 12)
  })

  it("budgets a fallback turn at the served model's rate", () => {
    const notes: ChatGptTurnNotes = { features: { ...CHATGPT_FEATURE_DEFAULTS, maxBudgetUsd: 0.005, fallbackModel: "gpt-5.4" }, fallbackFrom: "gpt-5.6-sol" }
    const event = turnEvent({ requestModel: "gpt-5.4", model: "gpt-5.4", usage })
    // $0.0046 at gpt-5.4 rates stays under $0.005; the $0.00656 gpt-5.6-sol price would not.
    expect(decorateChatGptTurn(event, notes, resolveModelPricing).error).toBeNull()
  })
})

describe("unpriced model warning", () => {
  it("logs once per unpriced model, never for a priced one, and stops once a price exists", () => {
    const logs: string[] = []
    const overrides: Record<string, ModelPricing> = {}
    const warn = createUnpricedModelWarning(model => resolveModelPricing(model, overrides), m => logs.push(m))
    warn("gpt-6.1-sol")
    warn("gpt-7-nova")
    warn("gpt-7-nova")
    warn("gpt-7-omega")
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain("model=gpt-7-nova has no price")
    overrides["gpt-8"] = { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 }
    warn("gpt-8")
    expect(logs).toHaveLength(2)
  })
})

describe("Fallback Model", () => {
  it("triggers on a rate limit and on a provider error without reading the body", async () => {
    for (const status of [429, 500, 503]) {
      const response = new Response(streamOf(["never read"]), { status })
      const check = await fallbackTrigger(response)
      expect(check.trigger).not.toBeNull()
      expect(check.response.bodyUsed).toBe(false)
    }
  })

  it("triggers on a model refusal and hands back the same bytes when it does not", async () => {
    const refused = await fallbackTrigger(new Response(JSON.stringify({ detail: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." }), { status: 400 }))
    expect(refused.trigger).toBe("model_refused")
    const other = JSON.stringify({ error: { message: "Invalid value for 'input'." } })
    const plain = await fallbackTrigger(new Response(other, { status: 400 }))
    expect(plain.trigger).toBeNull()
    expect(await plain.response.text()).toBe(other)
  })

  it("never triggers on a refused credential", async () => {
    expect((await fallbackTrigger(new Response("model unavailable", { status: 401 }))).trigger).toBeNull()
  })

  it("labels only the turn the fallback served", () => {
    const notes = { features: CHATGPT_FEATURE_DEFAULTS, fallbackFrom: "gpt-5.6-sol" }
    expect(decorateChatGptTurn(turnEvent({ requestModel: "gpt-5.6-sol", status: 503 }), notes, () => null).fallbackFromModel).toBeUndefined()
    expect(decorateChatGptTurn(turnEvent({ requestModel: "gpt-5.4" }), notes, () => null).fallbackFromModel).toBe("gpt-5.6-sol")
  })
})

describe("ChatGPT feature settings", () => {
  it("defaults to thinking passthrough on, the client's reasoning summary, no budget, no fallback, and never spending credits", () => {
    resetChatGptFeatures()
    expect(getChatGptFeatures()).toEqual({ thinkingPassthrough: true, reasoningSummary: "client", maxBudgetUsd: 0, fallbackModel: "", creditsPolicy: "never", seatCreditsPolicy: {}, freeSeatOrder: "before-credits", seatRenewalHours: {} })
  })

  it("round-trips through settings.json", () => {
    updateChatGptFeatures({ thinkingPassthrough: false, maxBudgetUsd: 0.5 })
    updateChatGptFeatures({ fallbackModel: "gpt-5.4", creditsPolicy: "reserve" })
    expect(getChatGptFeatures()).toEqual({ thinkingPassthrough: false, reasoningSummary: "client", maxBudgetUsd: 0.5, fallbackModel: "gpt-5.4", creditsPolicy: "reserve", seatCreditsPolicy: {}, freeSeatOrder: "before-credits", seatRenewalHours: {} })
    resetChatGptFeatures()
  })

  it("accepts the three credits policies, and a per-seat override that inherit removes", () => {
    const resolve = (id: string) => id === "pro-abc123" ? "user-1__workspace-1" : undefined
    expect(() => validateChatGptFeatureUpdate({ creditsPolicy: "always" })).toThrow("creditsPolicy must be one of: never, reserve, immediately")
    expect(() => validateChatGptFeatureUpdate({ seatCreditsPolicy: { nobody: "never" } }, [], resolve)).toThrow('unknown ChatGPT profile "nobody"')
    expect(() => validateChatGptFeatureUpdate({ seatCreditsPolicy: { "pro-abc123": "sometimes" } }, [], resolve)).toThrow()

    updateChatGptFeatures(validateChatGptFeatureUpdate({ creditsPolicy: "reserve", seatCreditsPolicy: { "pro-abc123": "immediately" } }, [], resolve))
    expect(getChatGptFeatures()).toMatchObject({ creditsPolicy: "reserve", seatCreditsPolicy: { "user-1__workspace-1": "immediately" } })
    expect(effectiveCreditsPolicy(getChatGptFeatures(), "user-1__workspace-1")).toEqual({ policy: "immediately", source: "seat" })
    expect(effectiveCreditsPolicy(getChatGptFeatures(), "user-2__workspace-2")).toEqual({ policy: "reserve", source: "default" })

    updateChatGptFeatures(validateChatGptFeatureUpdate({ seatCreditsPolicy: { "pro-abc123": "inherit" } }, [], resolve))
    expect(getChatGptFeatures().seatCreditsPolicy).toEqual({})
    resetChatGptFeatures()
  })

  it("keeps a per-seat renewal interval in hours, between 1 and 240, that null removes", () => {
    const resolve = (id: string) => id === "pro-abc123" ? "user-1__workspace-1" : undefined
    expect(() => validateChatGptFeatureUpdate({ seatRenewalHours: { nobody: 24 } }, [], resolve)).toThrow('unknown ChatGPT profile "nobody"')
    for (const bad of [0.5, 241, "24", Number.NaN, true]) {
      expect(() => validateChatGptFeatureUpdate({ seatRenewalHours: { "pro-abc123": bad } }, [], resolve)).toThrow("seatRenewalHours.pro-abc123 must be a number of hours from 1 to 240, or null")
    }
    expect(() => validateChatGptFeatureUpdate({ seatRenewalHours: [24] }, [], resolve)).toThrow("seatRenewalHours must be an object")

    updateChatGptFeatures(validateChatGptFeatureUpdate({ seatRenewalHours: { "pro-abc123": 24 } }, [], resolve))
    expect(getChatGptFeatures().seatRenewalHours).toEqual({ "user-1__workspace-1": 24 })
    expect(chatGptRenewalIntervals(getChatGptFeatures())).toEqual({ "user-1__workspace-1": 24 * 3_600_000 })

    updateChatGptFeatures(validateChatGptFeatureUpdate({ seatRenewalHours: { "pro-abc123": null } }, [], resolve))
    expect(getChatGptFeatures().seatRenewalHours).toEqual({})
    resetChatGptFeatures()
  })

  it("accepts the four reasoning summary values, forces all but client, and ignores a saved value it does not know", () => {
    for (const value of ["client", "auto", "concise", "detailed"] as const) {
      expect(validateChatGptFeatureUpdate({ reasoningSummary: value })).toEqual({ reasoningSummary: value })
      updateChatGptFeatures({ reasoningSummary: value })
      expect(getChatGptFeatures().reasoningSummary).toBe(value)
      expect(forcedReasoningSummary(getChatGptFeatures())).toBe(value === "client" ? undefined : value)
    }
    expect(() => validateChatGptFeatureUpdate({ reasoningSummary: "none" })).toThrow("reasoningSummary must be one of: client, auto, concise, detailed")
    expect(() => validateChatGptFeatureUpdate({ reasoningSummary: null })).toThrow()
    updateChatGptFeatures({ reasoningSummary: "verbose" as never })
    expect(getChatGptFeatures().reasoningSummary).toBe("client")
    resetChatGptFeatures()
  })

  it("falls back to never for a saved policy this build does not know", () => {
    updateChatGptFeatures({ creditsPolicy: "bogus" as never })
    expect(getChatGptFeatures().creditsPolicy).toBe("never")
    resetChatGptFeatures()
  })

  it("refuses a Claude fallback, a negative budget, and unknown keys", () => {
    expect(() => validateChatGptFeatureUpdate({ fallbackModel: "sonnet" })).toThrow()
    expect(() => validateChatGptFeatureUpdate({ maxBudgetUsd: -1 })).toThrow()
    expect(() => validateChatGptFeatureUpdate({ codeSystemPrompt: true })).toThrow()
    expect(validateChatGptFeatureUpdate({ fallbackModel: "", thinkingPassthrough: true })).toEqual({ fallbackModel: "", thinkingPassthrough: true })
  })

  it("accepts only an offered fallback, but keeps a saved one the offer has since dropped", () => {
    expect(validateChatGptFeatureUpdate({ fallbackModel: "gpt-6-luna" }, ["gpt-6-luna"])).toEqual({ fallbackModel: "gpt-6-luna" })
    expect(() => validateChatGptFeatureUpdate({ fallbackModel: "gpt-5.4" }, ["gpt-6-luna"])).toThrow('fallbackModel must be "" or one of: gpt-6-luna')
    updateChatGptFeatures({ fallbackModel: "gpt-5.4" })
    expect(getChatGptFeatures().fallbackModel).toBe("gpt-5.4")
    updateChatGptFeatures({ fallbackModel: "sonnet" })
    expect(getChatGptFeatures().fallbackModel).toBe("")
    resetChatGptFeatures()
  })
})
