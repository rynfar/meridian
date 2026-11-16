import { describe, expect, it } from "bun:test"
import { adaptResponsesBody } from "../proxy/chatgpt/body"
import { aggregateResponsesStream, tapResponsesStream, type TapSummary } from "../proxy/chatgpt/tap"

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
  const bytes = new TextEncoder().encode(text)
  // Split mid-frame to prove frames are reassembled across reads.
  const cut = Math.floor(bytes.length / 3)
  return new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close() } })
}

const completedStream = () => sse([
  { type: "response.created", response: { id: "r1", output: [] } },
  { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
  { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
  { type: "response.output_text.delta", delta: "pong" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] } },
  { type: "response.completed", response: { id: "r1", model: "gpt-6-luna", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } } } },
])

describe("adaptResponsesBody", () => {
  it("changes only what the Codex backend requires and leaves the client's prompt alone", () => {
    const input = {
      model: "gpt-6-luna",
      max_output_tokens: 32000,
      input: [{ role: "system", content: "sys" }, { role: "developer", content: "dev" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", name: "bash" }],
      prompt_cache_key: "k",
      reasoning: { effort: "low" },
    }
    const { body, applied, clientWantsStream } = adaptResponsesBody(input)
    expect(applied).toEqual(["store=false", "stream=true", "include+reasoning.encrypted_content", "-max_output_tokens"])
    expect(clientWantsStream).toBe(false)
    const { store, stream, include, ...rest } = body
    expect({ store, stream, include }).toEqual({ store: false, stream: true, include: ["reasoning.encrypted_content"] })
    const { max_output_tokens: _dropped, ...expectedRest } = input
    expect(rest).toEqual(expectedRest)
    expect("instructions" in body).toBe(false)
    expect(input.max_output_tokens).toBe(32000)
  })

  it("removes the sampling parameters the backend refuses on every model", () => {
    const input = { model: "gpt-6-luna", store: false, stream: true, include: ["reasoning.encrypted_content"], input: [], temperature: 0.5, top_p: 0.9 }
    const { body, applied } = adaptResponsesBody(input)
    expect(applied).toEqual(["-temperature", "-top_p"])
    const { temperature: _t, top_p: _p, ...expected } = input
    expect(body).toEqual(expected)
    expect(input.temperature).toBe(0.5)
  })

  it("passes a body that already satisfies the backend with nothing applied", () => {
    const input = { model: "gpt-5.4", store: false, stream: true, include: ["reasoning.encrypted_content"], instructions: "codex", input: [] }
    expect(adaptResponsesBody(input)).toEqual({ body: input, applied: [], clientWantsStream: true })
  })
})

describe("adaptResponsesBody: Reasoning Summary", () => {
  const satisfied = { model: "gpt-6.1-sol", store: false, stream: true, include: ["reasoning.encrypted_content"], input: [] }

  it("creates `reasoning` with the forced summary when the client sent none", () => {
    for (const level of ["auto", "concise", "detailed"] as const) {
      const { body, applied } = adaptResponsesBody(satisfied, { reasoningSummary: level })
      expect(body.reasoning).toEqual({ summary: level })
      expect(applied).toEqual([`reasoning.summary=${level}`])
    }
    expect("reasoning" in satisfied).toBe(false)
  })

  it("keeps the client's effort and other reasoning fields", () => {
    const input = { ...satisfied, reasoning: { effort: "xhigh", generate_summary: null } }
    const { body, applied } = adaptResponsesBody(input, { reasoningSummary: "detailed" })
    expect(body.reasoning).toEqual({ effort: "xhigh", generate_summary: null, summary: "detailed" })
    expect(applied).toEqual(["reasoning.summary=detailed"])
    expect(input.reasoning).toEqual({ effort: "xhigh", generate_summary: null })
  })

  it("replaces a different summary the client asked for", () => {
    const { body, applied } = adaptResponsesBody({ ...satisfied, reasoning: { effort: "high", summary: "auto" } }, { reasoningSummary: "concise" })
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" })
    expect(applied).toEqual(["reasoning.summary=concise"])
  })

  it("records nothing when the client already asked for the forced level", () => {
    const input = { ...satisfied, reasoning: { effort: "high", summary: "detailed" } }
    expect(adaptResponsesBody(input, { reasoningSummary: "detailed" })).toEqual({ body: input, applied: [], clientWantsStream: true })
  })

  it("leaves `reasoning` exactly as sent, or absent, without an override", () => {
    const withReasoning = { ...satisfied, reasoning: { effort: "low", summary: "auto" } }
    expect(JSON.stringify(adaptResponsesBody(withReasoning, {}).body)).toBe(JSON.stringify(withReasoning))
    expect(JSON.stringify(adaptResponsesBody(satisfied, { reasoningSummary: undefined }).body)).toBe(JSON.stringify(satisfied))
  })
})

describe("tapResponsesStream", () => {
  it("forwards bytes unchanged and reports usage, first output and reasoning summaries", async () => {
    const original = await new Response(completedStream()).text()
    let summary: TapSummary | undefined
    let clock = 1000
    const tapped = await new Response(tapResponsesStream(completedStream(), s => { summary = s }, () => ++clock)).text()
    expect(tapped).toBe(original)
    expect(summary).toMatchObject({
      outcome: "completed", model: "gpt-6-luna", reasoningSummaryEvents: 1, interrupted: null,
      usage: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 12 },
    })
    expect(summary!.firstOutputAt).not.toBeNull()
  })

  it("reports a cancelled stream exactly once", async () => {
    const calls: TapSummary[] = []
    const reader = tapResponsesStream(completedStream(), s => calls.push(s)).getReader()
    await reader.read()
    await reader.cancel()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.interrupted).toBe("cancelled")
  })
})

describe("aggregateResponsesStream", () => {
  it("rebuilds the empty terminal output from output_item.done events", async () => {
    const response = await aggregateResponsesStream(completedStream())
    expect(response?.output).toEqual([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] }])
    expect(response?.model).toBe("gpt-6-luna")
  })

  it("returns null when the stream never finished", async () => {
    expect(await aggregateResponsesStream(sse([{ type: "response.created", response: {} }]))).toBeNull()
  })
})
