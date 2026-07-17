/**
 * OpenAI Responses API translation — #475 (Codex CLI ≥ 0.96).
 *
 * Wire shapes mirror real Codex 0.143 traffic captured in the design spec
 * (docs/superpowers/specs/2026-07-08-codex-responses-api-design.md).
 */

import { describe, it, expect } from "bun:test"
import {
  translateResponsesToAnthropic,
  translateAnthropicToResponses,
  createResponsesSseTranslator,
} from "../proxy/openaiResponses"

describe("translateResponsesToAnthropic", () => {
  it("returns null without input", () => {
    expect(translateResponsesToAnthropic({ model: "claude-sonnet-5" })).toBeNull()
  })

  it("maps string input to a single user message", () => {
    const r = translateResponsesToAnthropic({ model: "claude-sonnet-5", input: "hi" })!
    expect(r.model).toBe("claude-sonnet-5")
    expect(r.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(r.stream).toBe(false)
  })

  it("maps instructions to system and folds developer messages in", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      instructions: "You are Codex.",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "House rules." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    })!
    expect(r.system).toContain("You are Codex.")
    expect(r.system).toContain("House rules.")
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]!.role).toBe("user")
  })

  it("maps the codex tool round-trip: function_call + function_call_output", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listing." }] },
        { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
      ],
    })!
    // Consecutive same-role turns merge (Anthropic requires alternating
    // roles): the trailing tool_result + "thanks" text become one user turn.
    const roles = r.messages.map((m: any) => m.role)
    expect(roles).toEqual(["user", "assistant", "user"])
    const assistant = r.messages[1]! as any
    expect(assistant.content.some((b: any) => b.type === "text" && b.text === "Listing.")).toBe(true)
    const toolUse = assistant.content.find((b: any) => b.type === "tool_use")
    expect(toolUse).toEqual({ type: "tool_use", id: "call_1", name: "shell", input: { command: ["ls"] } })
    const finalUser = (r.messages[2] as any).content
    expect(finalUser[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "a.txt\nb.txt" })
    expect(finalUser.some((b: any) => b.type === "text" && b.text === "thanks")).toBe(true)
  })

  it("skips reasoning items (phase 1)", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      input: [
        { type: "reasoning", summary: [], encrypted_content: "opaque" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
      ],
    })!
    expect(r.messages).toHaveLength(1)
  })

  it("maps function tools, tool_choice, and limits", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      input: "x",
      tools: [{ type: "function", name: "shell", description: "run", strict: false, parameters: { type: "object", properties: {} } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_output_tokens: 4096,
      temperature: 0.4,
      stream: true,
    })!
    expect(r.tools).toEqual([{ name: "shell", description: "run", input_schema: { type: "object", properties: {} } }])
    expect(r.tool_choice).toEqual({ type: "auto" })
    expect(r.max_tokens).toBe(4096)
    expect(r.temperature).toBe(0.4)
    expect(r.stream).toBe(true)
  })

  it("maps forced tool_choice variants", () => {
    const req = (tc: unknown) => translateResponsesToAnthropic({ model: "m", input: "x", tool_choice: tc })!
    expect(req("required").tool_choice).toEqual({ type: "any" })
    expect(req({ type: "function", name: "shell" }).tool_choice).toEqual({ type: "tool", name: "shell" })
    expect(req("none").tool_choice).toBeUndefined()
  })
})

describe("translateAnthropicToResponses (non-stream)", () => {
  const ctx = { responseId: "resp_1", model: "claude-sonnet-5", created: 1700000000 }

  it("assembles a completed response with text output", () => {
    const out = translateAnthropicToResponses({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }, ctx) as any
    expect(out.id).toBe("resp_1")
    expect(out.object).toBe("response")
    expect(out.status).toBe("completed")
    expect(out.model).toBe("claude-sonnet-5")
    const msg = out.output.find((o: any) => o.type === "message")
    expect(msg.role).toBe("assistant")
    expect(msg.content).toEqual([{ type: "output_text", text: "Hello!", annotations: [] }])
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
  })

  it("maps tool_use blocks to function_call items", () => {
    const out = translateAnthropicToResponses({
      content: [
        { type: "text", text: "Running." },
        { type: "tool_use", id: "toolu_1", name: "shell", input: { command: ["ls"] } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 2 },
    }, ctx) as any
    const fc = out.output.find((o: any) => o.type === "function_call")
    expect(fc.call_id).toBe("toolu_1")
    expect(fc.name).toBe("shell")
    expect(JSON.parse(fc.arguments)).toEqual({ command: ["ls"] })
    expect(fc.status).toBe("completed")
  })

  it("strips thinking blocks (phase 1)", () => {
    const out = translateAnthropicToResponses({
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "Answer." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }, ctx) as any
    expect(JSON.stringify(out.output)).not.toContain("hmm")
    expect(out.output.find((o: any) => o.type === "message").content[0].text).toBe("Answer.")
  })
})

describe("createResponsesSseTranslator (stream)", () => {
  const ctx = { responseId: "resp_s", model: "claude-sonnet-5", created: 1700000000 }

  function run(events: Array<Record<string, unknown>>) {
    const translate = createResponsesSseTranslator(ctx)
    const out: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const e of events) out.push(...translate(e as any))
    return out
  }

  const textStream = [
    { type: "message_start", message: { id: "m1", usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]

  it("emits the Responses event sequence for a text turn", () => {
    const out = run(textStream)
    const types = out.map((e) => e.event)
    expect(types[0]).toBe("response.created")
    expect(types[1]).toBe("response.in_progress")
    expect(types).toContain("response.output_item.added")
    expect(types).toContain("response.content_part.added")
    expect(types.filter((t) => t === "response.output_text.delta")).toHaveLength(2)
    expect(types).toContain("response.output_text.done")
    expect(types).toContain("response.content_part.done")
    expect(types).toContain("response.output_item.done")
    expect(types[types.length - 1]).toBe("response.completed")
  })

  it("accumulates text and reports usage in response.completed", () => {
    const out = run(textStream)
    const done = out.find((e) => e.event === "response.output_text.done")!
    expect((done.data as any).text).toBe("Hello")
    const completed = out.find((e) => e.event === "response.completed")!
    const resp = (completed.data as any).response
    expect(resp.status).toBe("completed")
    expect(resp.usage).toEqual({ input_tokens: 12, output_tokens: 7, total_tokens: 19 })
    const msg = resp.output.find((o: any) => o.type === "message")
    expect(msg.content[0].text).toBe("Hello")
  })

  it("emits function_call items with argument deltas for tool_use blocks", () => {
    const out = run([
      { type: "message_start", message: { id: "m1", usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "shell", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '["ls"]}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ])
    const types = out.map((e) => e.event)
    const added = out.find((e) => e.event === "response.output_item.added")!
    expect((added.data as any).item.type).toBe("function_call")
    expect((added.data as any).item.call_id).toBe("toolu_9")
    expect((added.data as any).item.name).toBe("shell")
    expect(types.filter((t) => t === "response.function_call_arguments.delta")).toHaveLength(2)
    const argsDone = out.find((e) => e.event === "response.function_call_arguments.done")!
    expect(JSON.parse((argsDone.data as any).arguments)).toEqual({ command: ["ls"] })
    const itemDone = out.find((e) => e.event === "response.output_item.done")!
    expect(JSON.parse((itemDone.data as any).item.arguments)).toEqual({ command: ["ls"] })
    const completed = out.find((e) => e.event === "response.completed")!
    const fc = (completed.data as any).response.output.find((o: any) => o.type === "function_call")
    expect(fc.call_id).toBe("toolu_9")
  })

  it("skips thinking blocks without emitting items", () => {
    const out = run([
      { type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ])
    expect(JSON.stringify(out)).not.toContain("pondering")
    const added = out.filter((e) => e.event === "response.output_item.added")
    expect(added).toHaveLength(1)
    expect((added[0]!.data as any).item.type).toBe("message")
  })

  it("assigns increasing sequence numbers", () => {
    const out = run(textStream)
    const seqs = out.map((e) => (e.data as any).sequence_number)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
  })

  it("emits a placeholder reasoning item when reasoning was requested (#475 hang fix)", () => {
    // Codex 0.144 hangs if it asked for reasoning (include reasoning.*) and
    // no reasoning item appears in the output. Emit one empty placeholder.
    const translate = createResponsesSseTranslator({ ...ctx, reasoningRequested: true })
    const out: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const e of textStream) out.push(...translate(e as any))
    const reasoningAdded = out.find(
      (e) => e.event === "response.output_item.added" && (e.data as any).item?.type === "reasoning"
    )
    expect(reasoningAdded).toBeDefined()
    // And it appears in the terminal response output.
    const completed = out.find((e) => e.event === "response.completed")!
    const reasoning = (completed.data as any).response.output.find((o: any) => o.type === "reasoning")
    expect(reasoning).toBeDefined()
    // Absent by default (no phantom reasoning when not requested).
    const plain = createResponsesSseTranslator(ctx)
    const plainOut: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const e of textStream) plainOut.push(...translate(e as any))
    void plainOut
    const noReasoning = run(textStream).find(
      (e) => e.event === "response.output_item.added" && (e.data as any).item?.type === "reasoning"
    )
    expect(noReasoning).toBeUndefined()
    void plain
  })

  it("embeds a `type` field in every data payload matching the event name", () => {
    // The Responses SSE format is self-describing; Codex's deserializer is
    // #[serde(tag = "type")]. A payload without `type` fails to parse and
    // Codex reports "stream closed before response.completed" — the exact
    // symptom that blocked the first live run. Data `type` must equal the
    // SSE `event:` name for every emission.
    for (const e of run(textStream)) {
      expect((e.data as any).type).toBe(e.event)
    }
  })
})
