import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { contractKey, parseAgRequest, parseAgRequestWithMeta, parallelAgTool, renderAgPrompt, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const base = () => ({
  model: "fixture-model",
  messages: [{ role: "user" as const, content: "hello" }],
})

describe("Antigravity Anthropic request normalization", () => {
  it("does not confuse literal user system tags with normalized steering during compaction", () => {
    for (const content of ["[system]\nSECOND_REQUEST short", [{ type: "text", text: "[system]\nSECOND_REQUEST short" }]]) {
      const request = parseAgRequest({ ...base(), messages: [
        { role: "user", content: "older request ".repeat(5000) },
        { role: "assistant", content: "Acknowledged" },
        { role: "user", content },
      ] })
      const prompt = renderAgPromptWithinLimit(request, [], "", 40000)
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(40000)
      expect(prompt).toContain("[system]\\nSECOND_REQUEST short")
    }
  })
  it("preserves serial tool choice constraints after dropping hosted targets and rejects malformed choices", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search" }, { name: "lookup", input_schema: {} }]
    const request = parseAgRequest({ ...base(), tools, tool_choice: { type: "tool", name: "web_search", disable_parallel_tool_use: true } })
    expect(request.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
    expect(parallelAgTool(request)).toBeUndefined()
    for (const tool_choice of [
      { type: "tool", name: "web_search", disable_parallel_tool_use: "yes" },
      { type: "tool", name: "web_search", extra: true },
      { type: "any", name: "not allowed" },
    ]) expect(() => parseAgRequest({ ...base(), tools: tools.slice(0, 1), tool_choice })).toThrow("tool_choice")
  })
  it("bounds every unknown block description without cutting surrogate pairs", () => {
    for (const block of [
      { type: "unknown", data: "a".repeat(25000) },
      { type: "x".repeat(25000), data: "synthetic" },
      { type: "tool_reference", tool_name: "x".repeat(25000) },
      { type: "tool_reference", tool_name: "x".repeat(19982) + "\u{1F642}".repeat(100) },
    ]) {
      const request = parseAgRequest({ ...base(), messages: [{ role: "user", content: [block] }] })
      const content = request.messages[0]!.content
      if (typeof content === "string" || content[0]?.type !== "text") throw new Error("Expected normalized text")
      expect(content[0].text.length).toBeLessThanOrEqual(20014)
      expect(content[0].text).toContain("...(truncated)")
      expect(Buffer.from(content[0].text).toString()).toBe(content[0].text)
    }
  })
  it("rejects invalid hosted tool names before emitting headers", () => {
    for (const name of ["bad\r\nheader", "bad,name", "\u975EASCII", "x".repeat(65)]) {
      expect(() => parseAgRequest({ ...base(), tools: [{ type: "web_search_20250305", name }] })).toThrow("tools")
    }
  })
  it("drops whitespace-only system messages", () => {
    const request = parseAgRequest({ ...base(), messages: [{ role: "system", content: " \n\t " }, ...base().messages] })
    expect(request.messages).toEqual(base().messages)
  })
  it("does not coerce recognized message-only blocks into tool-result text", () => {
    for (const nested of [
      { type: "tool_use", id: "nested", name: "lookup", input: {} },
      { type: "tool_result", tool_use_id: "nested", content: "nested result" },
    ]) {
      expect(() => parseAgRequest({ ...base(), messages: [
        { role: "user", content: "Run lookup" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [nested] }] },
      ] })).toThrow("invalid or unsupported request")
    }
  })
  it("keeps the latest actual user instruction verbatim when trailing system steering forces prompt compaction", () => {
    const instruction = "NEW_GOAL_START " + "preserve this instruction ".repeat(240) + " NEW_GOAL_END"
    const request = parseAgRequest({ ...base(), messages: [
      { role: "user", content: "Original task" },
      { role: "assistant", content: "Acknowledged" },
      { role: "user", content: instruction },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] },
      { role: "system", content: "Keep the current instruction" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result ".repeat(4000) }] },
    ] })
    const original = JSON.stringify(request)
    const prompt = renderAgPromptWithinLimit(request, [], "", 16000)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(16000)
    expect(prompt).toContain(JSON.stringify(instruction))
    expect(prompt).toContain("[system]\\nKeep the current instruction")
    expect(JSON.stringify(request)).toBe(original)
  })
  it("protects system steering in the text compaction pass without protecting adjacent old tool results", () => {
    const steering = "STEERING_START " + "explicit reminder ".repeat(250) + " STEERING_END"
    const request = parseAgRequest({ ...base(), messages: [
      { role: "user", content: "Keep the current goal" },
      { role: "assistant", content: "older assistant text ".repeat(250) },
      { role: "system", content: steering },
      { role: "assistant", content: [{ type: "text", text: "other assistant text ".repeat(250) }, { type: "tool_use", id: "t1", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "small result" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "latest result" }] },
    ] })
    const prompt = renderAgPromptWithinLimit(request, [], "", 9000)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(9000)
    expect(prompt).toContain(JSON.stringify("[system]\n" + steering))
    expect(prompt).toContain("Keep the current goal")
  })
  it("drops thinking-only historical user messages but still rejects an empty final user", () => {
    const request = parseAgRequest({ ...base(), messages: [
      { role: "user", content: "Original task" },
      { role: "assistant", content: "Acknowledged" },
      { role: "user", content: [{ type: "thinking", thinking: "synthetic discarded block" }] },
      { role: "assistant", content: "Continue" },
      { role: "user", content: "Latest task" },
    ] })
    expect(request.messages).toHaveLength(4)
    expect(request.messages.some(message => Array.isArray(message.content) && !message.content.length)).toBe(false)
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "user", content: [{ type: "thinking", thinking: "synthetic discarded block" }] }] })).toThrow("must not be empty")
  })
  it("renders mid-conversation role: system messages in-place as tagged user text without mutating input or changing contractKey", () => {
    const input = {
      ...base(),
      system: "Top instruction",
      messages: [
        { role: "user", content: "first" },
        { role: "system", content: "mid instruction" },
        { role: "assistant", content: "ok" },
        { role: "system", content: [{ type: "text", text: "second mid" }] },
        { role: "user", content: "final" },
      ],
    }
    const parsed = parseAgRequest(input)
    expect(parsed.system).toBe("Top instruction")
    expect(parsed.messages.map(m => m.role)).toEqual(["user", "user", "assistant", "user"])
    expect(parsed.messages[1]!.content).toEqual([{ type: "text", text: "[system]\nmid instruction" }])
    expect(parsed.messages[3]!.content).toEqual([
      { type: "text", text: "[system]\nsecond mid" },
      { type: "text", text: "final" },
    ])
    expect(input.messages.length).toBe(5)
    expect(input.messages[1]!.role).toBe("system")

    const withoutLateSystem = parseAgRequest({
      ...base(),
      system: "Top instruction",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "final" },
      ],
    })
    expect(contractKey(parsed)).toBe(contractKey(withoutLateSystem))

    const prompt = renderAgPrompt(parsed)
    expect(prompt).toContain("Client system instructions:\nTop instruction")
    expect(prompt).toContain("[system]\\nmid instruction")

    // role: system between assistant tool_use and matching user tool_result
    // must coalesce into the following user message so pending-pair validation succeeds
    const betweenPair = parseAgRequest({
      ...base(),
      system: "Top instruction",
      messages: [
        { role: "user", content: "run tool" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { key: "a" } }] },
        { role: "system", content: "Pending reminder" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "text", text: "steering" }] },
      ],
    })
    expect(betweenPair.system).toBe("Top instruction")
    expect(betweenPair.messages.map(m => m.role)).toEqual(["user", "assistant", "user"])
    expect(betweenPair.messages[2]!.content).toEqual([
      { type: "text", text: "[system]\nPending reminder" },
      { type: "tool_result", tool_use_id: "t1", content: "done" },
      { type: "text", text: "steering" },
    ])

    // Ordinary unmatched tool errors remain strict even when role: system is present
    expect(() => parseAgRequest({
      ...base(),
      messages: [
        { role: "user", content: "run tool" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { key: "a" } }] },
        { role: "system", content: "No result follows" },
      ],
    })).toThrow("matching result")
    expect(() => parseAgRequest({
      ...base(),
      messages: [
        { role: "user", content: "run tool" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { key: "a" } }] },
        { role: "system", content: "No result before assistant" },
        { role: "assistant", content: "skipped" },
        { role: "user", content: "next" },
      ],
    })).toThrow("matching result")
  })

  it("drops historical thinking and redacted_thinking blocks", () => {
    const parsed = parseAgRequest({
      ...base(),
      messages: [
        { role: "user", content: "plan" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret thought", signature: "sig123" },
            { type: "redacted_thinking", data: "opaque==" },
            { type: "text", text: "Here is the answer." },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    })
    expect(parsed.messages[1]!.content).toEqual([{ type: "text", text: "Here is the answer." }])

    const droppedEmptyAssistant = parseAgRequest({
      ...base(),
      messages: [
        { role: "user", content: "plan" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "only thinking", signature: "sig" },
            { type: "redacted_thinking", data: "opaque==" },
          ],
        },
        { role: "user", content: "proceed" },
      ],
    })
    expect(droppedEmptyAssistant.messages).toEqual([
      { role: "user", content: "plan" },
      { role: "user", content: "proceed" },
    ])

    expect(() => parseAgRequest({ ...base(), messages: [{ role: "user", content: "" }] })).toThrow("empty")
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "user", content: "   " }] })).toThrow("empty")
    expect(() => parseAgRequest({
      ...base(),
      messages: [{ role: "user", content: [{ type: "thinking", thinking: "x", signature: "s" }] }],
    })).toThrow("empty")
    expect(() => parseAgRequest({
      ...base(),
      messages: [{ role: "user", content: [{ type: "text", text: " \n " }] }],
    })).toThrow("empty")
  })

  it("renders unknown content blocks as text while preserving strict malformed known-block rejection", () => {
    const parsed = parseAgRequest({
      ...base(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "bun" } },
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://bun.sh" }] },
            { type: "tool_use", id: "tu_1", name: "ToolSearch", input: { query: "read" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "tool_reference", tool_name: "Read" }],
            },
          ],
        },
      ],
    })
    const assistantBlocks = parsed.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(assistantBlocks[0]!.type).toBe("text")
    expect(assistantBlocks[0]!.text).toContain("[server_tool_use]")
    expect(assistantBlocks[1]!.type).toBe("text")
    expect(assistantBlocks[1]!.text).toContain("[web_search_tool_result]")
    const resultBlock = (parsed.messages[1]!.content as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>)[0]!
    expect(resultBlock.content![0]).toEqual({ type: "text", text: "[tool reference: Read]" })

    // Strict malformed known-block rejection must remain intact
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "user", content: [{ type: "image", source: {} }] }] })).toThrow("text")
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "x" }] }, { role: "user", content: "hi" }] })).toThrow()
  })

  it("drops server tools without input_schema and matching tool_choice, while rejecting malformed custom tools", () => {
    const parsed = parseAgRequest({
      ...base(),
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20250910", name: "web_fetch" },
        { name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    })
    expect(parsed.tools.map(t => t.name)).toEqual(["read_file"])
    expect(parsed.tool_choice).toEqual({ type: "auto" })

    const onlyServer = parseAgRequest({
      ...base(),
      tools: [{ type: "code_execution_20250522", name: "code_execution" }],
      tool_choice: { type: "any" },
    })
    expect(onlyServer.tools).toEqual([])
    expect(onlyServer.tool_choice).toEqual({ type: "auto" })

    expect(() => parseAgRequest({ ...base(), tools: [{ name: "custom_no_schema" }] })).toThrow("tools")
    expect(() => parseAgRequest({ ...base(), tools: [{ name: "bad_schema", input_schema: [] }] })).toThrow("tools")
  })

  it("ignores sampling parameters temperature, top_p, and top_k when valid numbers", () => {
    const parsed = parseAgRequest({
      ...base(),
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
    })
    expect(parsed.temperature).toBeUndefined()
    expect(parsed.top_p).toBeUndefined()
    expect(parsed.top_k).toBeUndefined()
    expect(renderAgPrompt(parsed)).not.toContain("temperature")

    expect(() => parseAgRequest({ ...base(), temperature: "hot" })).toThrow()
  })

  it("rejects client-executed Anthropic tool types without input_schema and preserves kept tool_choice on name collision", () => {
    for (const type of ["bash_20250124", "text_editor_20250124", "computer_20250124", "memory_20250818"]) {
      expect(() => parseAgRequest({
        ...base(),
        tools: [{ type, name: type.split("_")[0] }],
      })).toThrow("tools")
    }

    const collision = parseAgRequest({
      ...base(),
      tools: [
        { type: "web_search_20250305", name: "lookup" },
        { name: "lookup", input_schema: { type: "object" } },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    })
    expect(collision.tools).toEqual([{ name: "lookup", input_schema: { type: "object" } }])
    expect(collision.tool_choice).toEqual({ type: "tool", name: "lookup" })
  })

  it("reports dropped hosted tools via metadata without leaking into prompt or contractKey, and rejects malformed known inputs", () => {
    const withHosted = parseAgRequestWithMeta({
      ...base(),
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "web_fetch_20250910", name: "web_fetch" },
        { name: "lookup", input_schema: { type: "object" } },
      ],
    })
    const withoutHosted = parseAgRequest({
      ...base(),
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    })
    expect(withHosted.droppedTools).toEqual(["web_search", "web_fetch"])
    expect(contractKey(withHosted.request)).toBe(contractKey(withoutHosted))
    expect(renderAgPrompt(withHosted.request)).not.toContain("web_search")
    expect(renderAgPrompt(withHosted.request)).not.toContain("web_fetch")

    // Negative malformed known inputs must still throw 400 AntigravityError
    expect(() => parseAgRequest({ ...base(), tools: [{ type: "web_search_20250305" }] })).toThrow("tools")
    expect(() => parseAgRequest({ ...base(), tools: [{ type: "web_search_20250305", name: 123 }] })).toThrow("tools")
    expect(() => parseAgRequest({ ...base(), tools: [{ type: "web_search_20250305", name: "ws", input_schema: [] }] })).toThrow("tools")
    expect(() => parseAgRequest({ ...base(), system: [{ type: "image", source: {} }] })).toThrow()
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "system", content: [{ type: "image", source: {} }] }, { role: "user", content: "hi" }] })).toThrow()
    expect(() => parseAgRequest({ ...base(), messages: [{ role: "assistant", content: "only assistant" }] })).toThrow("last message")
  })

  describe("HTTP mocked CLI normalization, warm reuse, and count_tokens", () => {
    const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
    const closing: Array<() => Promise<void>> = []
    afterEach(async () => { for (const close of closing.splice(0)) await close() })

    it("returns 400 for deeply nested unknown data and nested tool results without recursion failure", async () => {
      const runtime = new AntigravityRuntime({ executable, allowToolBridge: true })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
      closing.push(server.closeBackend)
      const sendRaw = (body: string) => server.app.fetch(new Request("http://local/v1/messages/count_tokens", { method: "POST", body }))
      const deep = "[".repeat(300000) + "0" + "]".repeat(300000)
      const unknown = await sendRaw('{"model":"fixture-model","messages":[{"role":"user","content":[{"type":"unknown","data":' + deep + '}]}]}')
      expect(unknown.status).toBe(400)
      expect((await unknown.json() as { error: { type: string } }).error.type).toBe("invalid_request_error")
      const nested = '{"type":"tool_result","tool_use_id":"nested","content":['.repeat(100000) + '{"type":"text","text":"end"}' + ']}'.repeat(100000)
      const results = await sendRaw('{"model":"fixture-model","messages":[{"role":"user","content":[' + nested + ']}]}')
      expect(results.status).toBe(400)
    })

    it("bounds hosted-tool headers and warnings while exposing the full dropped count", async () => {
      const runtime = new AntigravityRuntime({ executable, allowToolBridge: true })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
      closing.push(server.closeBackend)
      const tools = Array.from({ length: 2000 }, (_, index) => ({ type: "web_search_20250305", name: "search_" + index }))
      const warnings: string[] = []
      const previousWarn = console.warn
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
      try {
        const response = await server.app.fetch(new Request("http://local/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ ...base(), tools }) }))
        expect(response.status).toBe(200)
        expect(response.headers.get("x-meridian-dropped-tools")?.split(",")).toEqual(tools.slice(0, 16).map(tool => tool.name))
        expect(response.headers.get("x-meridian-dropped-tools-count")).toBe("2000")
        expect(warnings).toHaveLength(1)
        expect(warnings[0]!.length).toBeLessThan(1200)
        expect(warnings[0]).toContain("2000")
      } finally { console.warn = previousWarn }
    })

    it("normalizes requests through /v1/messages, rejects bash_20250124, and validates count_tokens", async () => {
      const runtime = new AntigravityRuntime({ executable, reuseConversations: true, allowToolBridge: true, turnTimeoutMs: 10000 })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
      closing.push(server.closeBackend)
      const send = (path: string, body: unknown) => server.app.fetch(new Request(`http://local${path}`, { method: "POST", body: JSON.stringify(body) }))

      const okBody = {
        model: "fixture-model",
        max_tokens: 100,
        system: "Base",
        temperature: 0.2,
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } },
        ],
        messages: [
          { role: "user", content: "First" },
          { role: "system", content: "Extra" },
          { role: "assistant", content: [
            { type: "thinking", thinking: "hidden", signature: "sig" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "tool_use", id: "tool_1", name: "lookup", input: { key: "k" } },
          ] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "tool_1", content: [{ type: "tool_reference", tool_name: "lookup" }] },
          ] },
        ],
      }
      const logs: string[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
      try {
        const okRes = await send("/v1/messages", okBody)
        expect(okRes.status).toBe(200)
        expect(okRes.headers.get("x-meridian-dropped-tools")).toBe("web_search")
        expect(logs.filter(l => l.includes("Dropped unsupported hosted tools"))).toHaveLength(1)
        const firstReply = await okRes.json() as { content: unknown[] }

        // PM3: keep top-level system="Base" and append late role:"system" steering.
        // Must warm-reuse the live CLI run without replaying the old model turn.
        const warmRes = await send("/v1/messages", {
          model: "fixture-model",
          max_tokens: 100,
          system: "Base",
          tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
          messages: [
            ...okBody.messages,
            { role: "assistant", content: firstReply.content },
            { role: "system", content: "Late steering" },
            { role: "user", content: "Followup" },
          ],
        })
        expect(warmRes.status).toBe(200)
        expect(warmRes.headers.get("x-meridian-dropped-tools")).toBeNull()
        expect(runtime.reused).toBeGreaterThanOrEqual(1)
        expect(runtime.runs.size).toBe(1)

        const badBash = await send("/v1/messages", {
          model: "fixture-model",
          tools: [{ type: "bash_20250124", name: "bash" }],
          messages: [{ role: "user", content: "hi" }],
        })
        expect(badBash.status).toBe(400)

        const badEmptyUser = await send("/v1/messages", {
          model: "fixture-model",
          messages: [{ role: "user", content: [{ type: "thinking", thinking: "x", signature: "s" }] }],
        })
        expect(badEmptyUser.status).toBe(400)

        const countOk = await send("/v1/messages/count_tokens", {
          model: "fixture-model",
          temperature: 0.5,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "hi" }],
        })
        expect(countOk.status).toBe(200)
        expect(countOk.headers.get("x-meridian-dropped-tools")).toBe("web_search")
        expect(logs.filter(l => l.includes("Dropped unsupported hosted tools"))).toHaveLength(2)

        const countBad = await send("/v1/messages/count_tokens", {
          model: "fixture-model",
          tools: [{ type: "bash_20250124", name: "bash" }],
          messages: [{ role: "user", content: "hi" }],
        })
        expect(countBad.status).toBe(400)
      } finally {
        console.warn = origWarn
      }
    })

    it("continues pending tool call on same run when role: system arrives between tool_use and tool_result", async () => {
      const runtime = new AntigravityRuntime({ executable, reuseConversations: true, allowToolBridge: true, turnTimeoutMs: 10000 })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
      closing.push(server.closeBackend)
      const send = (path: string, body: unknown) => server.app.fetch(new Request(`http://local${path}`, { method: "POST", body: JSON.stringify(body) }))

      const tools = [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }]
      const firstBody = {
        model: "fixture-model",
        max_tokens: 100,
        system: "Base",
        tools,
        messages: [{ role: "user", content: "STEERING please call lookup" }],
      }
      const firstRes = await send("/v1/messages", firstBody)
      expect(firstRes.status).toBe(200)
      const firstReply = await firstRes.json() as { stop_reason: string; content: Array<{ type: string; id?: string }> }
      expect(firstReply.stop_reason).toBe("tool_use")
      const toolUse = firstReply.content.find(b => b.type === "tool_use")
      expect(toolUse?.id).toBeTruthy()
      const firstRun = Array.from(runtime.runs.values())[0]!
      const firstContract = firstRun.contract

      const secondRes = await send("/v1/messages", {
        model: "fixture-model",
        max_tokens: 100,
        system: "Base",
        tools,
        messages: [
          ...firstBody.messages,
          { role: "assistant", content: firstReply.content },
          { role: "system", content: "Pending tool reminder" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse!.id!, content: "tool-ok" },
              { type: "text", text: "User steering" },
            ],
          },
        ],
      })
      expect(secondRes.status).toBe(200)
      expect(runtime.runs.size).toBe(1)
      expect(Array.from(runtime.runs.values())[0]).toBe(firstRun)
      expect(firstRun.contract).toBe(firstContract)
      const secondReply = await secondRes.json() as { content: Array<{ type: string; text?: string }> }
      const answerText = secondReply.content.find(b => b.type === "text")?.text ?? ""
      const sysIdx = answerText.indexOf("[system]\\nPending tool reminder")
      const steerIdx = answerText.indexOf("User steering")
      expect(sysIdx).toBeGreaterThanOrEqual(0)
      expect(steerIdx).toBeGreaterThan(sysIdx)
    })
  })
})
