/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { frameReplayTurns, framePassthroughContinuation, PASSTHROUGH_CONTINUATION_LEAD_IN, normalizeContent, getLastUserMessage, extractAdvisorModel, stripAdvisorTools, stripNonStandardStreamFields, consolidateMultimodalOntoLastUser, buildToolUseIndex, describeToolCall, extractSystemText } from "../proxy/messages"

const img = (id: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: id } })
function userMsg(content: unknown) {
  return { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null }
}

describe("normalizeContent", () => {
  it("returns string content as-is", () => {
    expect(normalizeContent("hello")).toBe("hello")
  })

  it("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "hello world" }]
    expect(normalizeContent(content)).toBe("hello world")
  })

  it("handles tool_use blocks", () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_use:tu_1:Read:")
    expect(result).toContain('"file":"a.ts"')
  })

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]
    const result = normalizeContent(content)
    expect(result).toBe("tool_result:tu_1:file contents")
  })

  it("handles tool_result blocks with object content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: { key: "val" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_result:tu_1:")
    expect(result).toContain('"key":"val"')
  })

  it("handles mixed content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(normalizeContent(content)).toBe("hello\nworld")
  })

  it("JSON stringifies unknown block types", () => {
    const content = [{ type: "image", data: "base64" }]
    const result = normalizeContent(content)
    expect(result).toContain('"type":"image"')
  })

  it("produces stable hashes when cache_control is added to text blocks", () => {
    const without = [{ type: "text", text: "hello" }]
    const withCC = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]
    // text blocks extract only .text, so cache_control is already ignored
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to tool_result content blocks", () => {
    const without = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }] }]
    const withCC = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to unknown block types", () => {
    const without = [{ type: "image", data: "base64" }]
    const withCC = [{ type: "image", data: "base64", cache_control: { type: "ephemeral" } }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("converts non-string non-array to string", () => {
    expect(normalizeContent(42)).toBe("42")
    expect(normalizeContent(null)).toBe("null")
    expect(normalizeContent(true)).toBe("true")
  })
})

describe("getLastUserMessage", () => {
  it("returns the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("second")
  })

  it("returns last message as fallback when no user messages", () => {
    const messages = [
      { role: "assistant", content: "reply" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("reply")
  })

  it("handles empty array", () => {
    const result = getLastUserMessage([])
    expect(result).toHaveLength(0)
  })

  it("returns single user message from single-message array", () => {
    const messages = [{ role: "user", content: "only" }]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("only")
  })
})

describe("extractAdvisorModel", () => {
  it("extracts model from advisor tool definition", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
    ]
    expect(extractAdvisorModel(tools)).toBe("claude-opus-4-7")
  })

  it("returns undefined when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(extractAdvisorModel(tools)).toBeUndefined()
  })

  it("returns undefined for non-array input", () => {
    expect(extractAdvisorModel(undefined)).toBeUndefined()
    expect(extractAdvisorModel(null)).toBeUndefined()
    expect(extractAdvisorModel("not-array")).toBeUndefined()
  })

  it("returns undefined when model is missing or empty", () => {
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor" }])).toBeUndefined()
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor", model: "" }])).toBeUndefined()
  })

  it("matches any advisor_ type prefix", () => {
    expect(extractAdvisorModel([{ type: "advisor_20270101", name: "advisor", model: "claude-opus-5" }])).toBe("claude-opus-5")
  })
})

describe("stripAdvisorTools", () => {
  it("removes advisor tool definitions from array", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
      { name: "Write", description: "Write a file" },
    ]
    const result = stripAdvisorTools(tools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: "Read", description: "Read a file" })
    expect(result[1]).toEqual({ name: "Write", description: "Write a file" })
  })

  it("returns all tools when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(stripAdvisorTools(tools)).toHaveLength(2)
  })

  it("handles empty array", () => {
    expect(stripAdvisorTools([])).toHaveLength(0)
  })
})

describe("stripNonStandardStreamFields (#525)", () => {
  it("removes context_management from a message_delta event", () => {
    const event = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
      context_management: { applied_edits: [{ type: "clear_tool_uses_20250919" }] },
    }
    const out = stripNonStandardStreamFields(event) as Record<string, unknown>
    expect(out).not.toHaveProperty("context_management")
    // Everything else must survive untouched.
    expect(out.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null })
    expect(out.usage).toEqual({ output_tokens: 12 })
  })

  it("removes context_management nested inside delta", () => {
    const event = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", context_management: { foo: 1 } },
    }
    const out = stripNonStandardStreamFields(event) as { delta: Record<string, unknown> }
    expect(out.delta).not.toHaveProperty("context_management")
    expect(out.delta.stop_reason).toBe("end_turn")
  })

  it("is a no-op on events without the field (content_block_delta)", () => {
    const event = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
    const out = stripNonStandardStreamFields(event)
    expect(out).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })
  })

  it("returns non-object inputs unchanged", () => {
    expect(stripNonStandardStreamFields(null)).toBeNull()
    expect(stripNonStandardStreamFields("x" as unknown)).toBe("x")
  })

  it("mutates and returns the same reference (for inline use)", () => {
    const event = { type: "message_delta", context_management: {} }
    expect(stripNonStandardStreamFields(event)).toBe(event)
    expect(event).not.toHaveProperty("context_management")
  })
})

describe("consolidateMultimodalOntoLastUser (#553)", () => {
  it("moves an image from an earlier user turn onto the last user turn", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([{ type: "text", text: "here is the file" }, img("A")]),
      userMsg([{ type: "text", text: "describe it" }]),
    ])
    // Earlier turn keeps its text, loses the image.
    expect(out[0]!.message.content).toEqual([{ type: "text", text: "here is the file" }])
    // Last turn gains the image, keeps its text.
    expect(out[1]!.message.content).toEqual([{ type: "text", text: "describe it" }, img("A")])
  })

  it("targets the last ARRAY-content user turn, not a flattened assistant string", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([{ type: "text", text: "look" }]),
      userMsg("[Assistant: sure]"), // flattened assistant turn — string content
    ])
    // Image must land on the real user turn (index 1), never appended to a string.
    expect(out[1]!.message.content).toContainEqual(img("A"))
    expect(out[2]!.message.content).toBe("[Assistant: sure]")
    expect(out[0]!.message.content).toEqual([])
  })

  it("does not duplicate an image already present on the last user turn", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([{ type: "text", text: "again" }, img("A")]),
    ])
    const imgs = (out[1]!.message.content as any[]).filter((b) => b.type === "image")
    expect(imgs).toHaveLength(1)
  })

  it("preserves the order of multiple carried images", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([img("B")]),
      userMsg([{ type: "text", text: "compare" }]),
    ])
    const imgs = (out[2]!.message.content as any[]).filter((b) => b.type === "image").map((b) => b.source.data)
    expect(imgs).toEqual(["A", "B"])
  })

  it("is a no-op with fewer than two array-content user turns", () => {
    const input = [userMsg([{ type: "text", text: "hi" }, img("A")])]
    expect(consolidateMultimodalOntoLastUser(input)).toEqual(input)
  })

  it("does not mutate the input array or its messages", () => {
    const input = [userMsg([img("A")]), userMsg([{ type: "text", text: "x" }])]
    const snapshot = JSON.parse(JSON.stringify(input))
    consolidateMultimodalOntoLastUser(input)
    expect(input).toEqual(snapshot)
  })
})

describe("buildToolUseIndex / tool-result attribution (#552)", () => {
  const history = [
    { role: "user", content: "create tmp/test2.txt" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Creating it now." },
        { type: "tool_use", id: "toolu_w", name: "write", input: { filePath: "tmp/test2.txt", content: "apple" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "Wrote file successfully" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_r", name: "read", input: { path: "tmp/test1.txt" } }],
    },
  ]

  it("indexes every assistant tool_use by id with name and target", () => {
    const idx = buildToolUseIndex(history)
    // write is a mutating tool → carries a content summary so the model can
    // recognize its own work product on replay (#496 follow-up)
    expect(idx.get("toolu_w")).toEqual({ name: "write", target: "tmp/test2.txt", contentSummary: "apple" })
    expect(idx.get("toolu_r")).toEqual({ name: "read", target: "tmp/test1.txt", contentSummary: undefined })
  })

  it("extracts common target keys and truncates long ones", () => {
    const idx = buildToolUseIndex([
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
        { type: "tool_use", id: "t2", name: "grep", input: { pattern: "x".repeat(200) } },
        { type: "tool_use", id: "t3", name: "custom", input: { weird: true } },
      ] },
    ])
    expect(idx.get("t1")).toEqual({ name: "bash", target: "echo hi", contentSummary: undefined })
    expect(idx.get("t2")!.target!.length).toBeLessThanOrEqual(80)
    expect(idx.get("t3")).toEqual({ name: "custom", target: undefined, contentSummary: undefined })
  })

  it("describeToolCall renders a compact attribution label", () => {
    expect(describeToolCall({ name: "write", target: "tmp/test2.txt", contentSummary: undefined })).toBe("[your write tmp/test2.txt]")
    expect(describeToolCall({ name: "custom", target: undefined, contentSummary: undefined })).toBe("[your custom]")
  })

  // A code-execution tool's whole payload is the `code` field. Without it in
  // TOOL_TARGET_KEYS every call replayed as the same bare `[your ipython]`:
  // the model could not tell which cell produced which result, nor that it had
  // already run one, and re-ran the first cell indefinitely.
  it("attributes code-execution tools by the code they ran", () => {
    const idx = buildToolUseIndex([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "ipython", input: { code: "2+2" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "ipython", input: { code: "3+3" } }] },
    ])
    expect(idx.get("c1")).toEqual({ name: "ipython", target: "2+2", contentSummary: undefined })
    expect(idx.get("c2")).toEqual({ name: "ipython", target: "3+3", contentSummary: undefined })

    const labels = [...idx.values()].map(describeToolCall)
    expect(new Set(labels).size).toBe(2)
    expect(labels).toEqual(["[your ipython 2+2]", "[your ipython 3+3]"])
  })

  // The label is rendered inline in a single-line bracket. A multi-line value
  // used to embed raw newlines into the replayed prompt, breaking the compact
  // shape #111/#386 rely on. Affects `command` for every bash-using adapter,
  // not just code tools.
  it("keeps multi-line targets on one line", () => {
    const idx = buildToolUseIndex([
      { role: "assistant", content: [
        { type: "tool_use", id: "b1", name: "bash", input: { command: "echo one\necho two\necho three" } },
        { type: "tool_use", id: "b2", name: "ipython", input: { code: "import os\nprint(os.getcwd())" } },
      ] },
    ])
    for (const id of ["b1", "b2"]) {
      const label = describeToolCall(idx.get(id)!)
      expect(label).not.toContain("\n")
      expect(label.startsWith("[")).toBe(true)
      expect(label.endsWith("]")).toBe(true)
    }
    expect(idx.get("b1")!.target).toBe("echo one echo two echo three")
    expect(idx.get("b2")!.target).toBe("import os print(os.getcwd())")
  })

  it("still truncates long targets to the 80-char budget after collapsing", () => {
    const idx = buildToolUseIndex([
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "ipython", input: { code: "x = 1\n".repeat(100) } },
      ] },
    ])
    const target = idx.get("t1")!.target!
    expect(target.length).toBeLessThanOrEqual(80)
    expect(target.endsWith("...")).toBe(true)
    expect(target).not.toContain("\n")
  })

  it("ignores a whitespace-only target and falls through to the next key", () => {
    const idx = buildToolUseIndex([
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "runner", input: { command: "   \n  ", code: "print(1)" } },
      ] },
    ])
    expect(idx.get("t1")!.target).toBe("print(1)")
  })

  it("returns an empty index for non-array and toolless content", () => {
    expect(buildToolUseIndex([{ role: "user", content: "hi" }]).size).toBe(0)
    expect(buildToolUseIndex([]).size).toBe(0)
  })

  // #496 follow-up: on fresh replay the assistant's tool_use blocks are dropped,
  // so without a content summary the model knows THAT it edited a file but not
  // WHAT it wrote — it then re-derives near-duplicate edits and confabulates a
  // parallel editor ("the first variant of the comments isn't mine").
  describe("content summaries for mutating tools", () => {
    it("edit: summarizes newString", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "e1", name: "edit", input: { filePath: "a.yml", oldString: "old", newString: "# Ignore major bumps\n  - dependency-name: foo" } },
        ] },
      ])
      expect(idx.get("e1")!.contentSummary).toBe("# Ignore major bumps - dependency-name: foo")
    })

    it("edit: accepts snake_case new_string and PascalCase tool names", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "a.ts", new_string: "const x = 1" } },
        ] },
      ])
      expect(idx.get("e2")!.contentSummary).toBe("const x = 1")
    })

    it("write: summarizes content", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "w1", name: "write", input: { filePath: "b.txt", content: "hello\nworld" } },
        ] },
      ])
      expect(idx.get("w1")!.contentSummary).toBe("hello world")
    })

    it("multiedit: summarizes the first edit and notes the count", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "m1", name: "multiedit", input: { filePath: "c.ts", edits: [
            { oldString: "a", newString: "first new text" },
            { oldString: "b", newString: "second" },
            { oldString: "c", newString: "third" },
          ] } },
        ] },
      ])
      expect(idx.get("m1")!.contentSummary).toBe("3 edits; first: first new text")
    })

    it("collapses whitespace and truncates long content", () => {
      const long = ("line one\n\n  line two\t" + "x".repeat(300))
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "e3", name: "edit", input: { filePath: "d.ts", newString: long } },
        ] },
      ])
      const s = idx.get("e3")!.contentSummary!
      expect(s.startsWith("line one line two")).toBe(true)
      expect(s.length).toBeLessThanOrEqual(123)
      expect(s.endsWith("...")).toBe(true)
      expect(s).not.toContain("\n")
    })

    it("non-mutating tools get no summary (read/bash/grep)", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "r1", name: "read", input: { filePath: "a.ts" } },
          { type: "tool_use", id: "b1", name: "bash", input: { command: "rm -rf /tmp/x" } },
          { type: "tool_use", id: "g1", name: "grep", input: { pattern: "foo" } },
        ] },
      ])
      expect(idx.get("r1")!.contentSummary).toBeUndefined()
      expect(idx.get("b1")!.contentSummary).toBeUndefined()
      expect(idx.get("g1")!.contentSummary).toBeUndefined()
    })

    it("describeToolCall includes the summary when present", () => {
      expect(describeToolCall({ name: "edit", target: "a.yml", contentSummary: "# Ignore major bumps" }))
        .toBe('[your edit a.yml → "# Ignore major bumps"]')
      expect(describeToolCall({ name: "write", target: undefined, contentSummary: "hello" }))
        .toBe('[your write → "hello"]')
    })

    it("tolerates malformed inputs without crashing", () => {
      const idx = buildToolUseIndex([
        { role: "assistant", content: [
          { type: "tool_use", id: "x1", name: "edit", input: { filePath: "a", newString: 42 } },
          { type: "tool_use", id: "x2", name: "multiedit", input: { filePath: "b", edits: "not-an-array" } },
          { type: "tool_use", id: "x3", name: "write", input: null },
        ] },
      ])
      expect(idx.get("x1")!.contentSummary).toBeUndefined()
      expect(idx.get("x2")!.contentSummary).toBeUndefined()
      expect(idx.get("x3")!.contentSummary).toBeUndefined()
    })
  })
})

describe("frameReplayTurns (#619)", () => {
  const t = (role: string, text: string) => ({ role, text })

  it("wraps replayed history in an envelope and separates the final user message", () => {
    const out = frameReplayTurns([
      t("user", "read the config file"),
      t("assistant", "[Assistant: I read it, it contains X]"),
      t("user", "now update the port"),
    ])
    expect(out).toStartWith("<conversation_history>\n")
    expect(out).toContain("read the config file")
    expect(out).toContain("[Assistant: I read it, it contains X]")
    expect(out).toContain("</conversation_history>")
    // Anti-imitation instruction between envelope and live message
    expect(out).toContain("context only")
    // The live user message is terminal, outside the envelope
    expect(out).toEndWith("now update the port")
    expect(out.indexOf("</conversation_history>")).toBeLessThan(out.indexOf("now update the port"))
  })

  it("leaves single-turn prompts bare — no envelope for fresh conversations", () => {
    expect(frameReplayTurns([t("user", "hello")])).toBe("hello")
  })

  it("falls back to a plain join when the final turn is not a user turn", () => {
    const out = frameReplayTurns([
      t("user", "do a thing"),
      t("assistant", "[Assistant: done]"),
    ])
    expect(out).toBe("do a thing\n\n[Assistant: done]")
  })

  it("skips empty turns and never emits Human: markers", () => {
    const out = frameReplayTurns([
      t("user", "first"),
      t("assistant", ""),
      t("user", "[your bash ls]:\nfile.txt"),
      t("user", "final question"),
    ])
    expect(out).not.toContain("Human:")
    expect(out).toEndWith("final question")
    expect(out).toContain("[your bash ls]:")
  })
})

describe("framePassthroughContinuation", () => {
  // The deny boundary fork places the spent "end your turn now" deny
  // immediately before this delta. Without the lead-in the model obeys it and
  // answers with an empty text block (see the doc comment on the constant).
  const delta = "[your shell ls]:\nfile.txt"

  it("puts the lead-in ahead of the delta and keeps the delta terminal", () => {
    const out = framePassthroughContinuation(delta)
    expect(out).toStartWith(PASSTHROUGH_CONTINUATION_LEAD_IN)
    expect(out).toEndWith(delta)
  })

  it("says the end-turn instruction is discharged", () => {
    expect(framePassthroughContinuation(delta).toLowerCase()).toContain("discharged")
  })

  it("leaves an empty delta alone — the lead-in must never be the whole turn", () => {
    expect(framePassthroughContinuation("")).toBe("")
  })

  it("adds no transcript markers for the model to imitate (#496)", () => {
    const out = framePassthroughContinuation(delta)
    expect(out).not.toContain("Human:")
    expect(out).not.toContain("[Assistant:")
    expect(out).not.toContain("<conversation_history>")
  })
})

describe("extractSystemText", () => {
  const CLIENT_PROMPT = "You are a release-notes assistant. Answer in bullet points."
  const BILLING = "x-anthropic-billing-header: cc_version=2.1.220.8b8; cc_entrypoint=sdk-cli;"
  const SDK_PREAMBLE = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

  it("passes a string system field through unchanged", () => {
    expect(extractSystemText(CLIENT_PROMPT)).toBe(CLIENT_PROMPT)
  })

  it("joins text blocks with newlines", () => {
    expect(extractSystemText([{ type: "text", text: "a" }, { type: "text", text: "b" }]))
      .toBe("a\nb")
  })

  // Claude Code's system array leads with a pseudo-HTTP header. Joined
  // verbatim it sits at the top of the subprocess's system prompt, where it
  // is noise at best — and it describes a request Meridian never makes, since
  // the subprocess sends its own billing header.
  it("drops the billing header block Claude Code smuggles through system", () => {
    const out = extractSystemText([
      { type: "text", text: BILLING },
      { type: "text", text: SDK_PREAMBLE },
      { type: "text", text: CLIENT_PROMPT },
    ])
    expect(out).not.toContain("x-anthropic-billing-header")
    expect(out).not.toContain("cc_entrypoint")
    expect(out).toBe(`${SDK_PREAMBLE}\n${CLIENT_PROMPT}`)
  })

  it("keeps a client prompt that merely mentions a header in prose", () => {
    const prose = "Always send the x-anthropic-billing-header when relaying."
    expect(extractSystemText([{ type: "text", text: prose }])).toBe(prose)
  })

  it("ignores non-text blocks and empty text", () => {
    expect(extractSystemText([
      { type: "image", source: {} },
      { type: "text", text: "" },
      { type: "text", text: CLIENT_PROMPT },
    ])).toBe(CLIENT_PROMPT)
  })

  it("returns empty string for absent or malformed input", () => {
    expect(extractSystemText(undefined)).toBe("")
    expect(extractSystemText(null)).toBe("")
    expect(extractSystemText(42)).toBe("")
  })
})
