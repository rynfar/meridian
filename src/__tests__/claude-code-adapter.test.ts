/**
 * Tests for the Claude Code CLI adapter.
 *
 * Claude Code's request shape differs from the other adapters in two ways
 * that this adapter handles:
 *  - It usually runs on a different host than the proxy, so its local CWD
 *    must not be used as the SDK subprocess cwd.
 *  - It embeds working-directory info as `Primary working directory: …`
 *    inside a `# Environment` section rather than the `<env>…</env>` block
 *    OpenCode uses.
 */
import { describe, it, expect } from "bun:test"
import type { Context } from "hono"
import { CLAUDE_CODE_AGENT_ID_HEADER, claudeCodeAdapter, claudeCodeSessionKey, isClaudeCodeAuxiliaryRequest } from "../proxy/adapters/claudecode"

describe("claudeCodeAdapter — identity", () => {
  it("has name 'claude-code'", () => {
    expect(claudeCodeAdapter.name).toBe("claude-code")
  })
})

describe("claudeCodeAdapter.getSessionId", () => {
  it("extracts a session ID from Claude Code's JSON-string metadata", () => {
    // Any unrelated header value is ignored; only the agent-id header keys.
    const ctx = {
      req: { header: (name: string) => name === CLAUDE_CODE_AGENT_ID_HEADER ? undefined : "any-value" },
    }
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: "device-1",
          account_uuid: "",
          session_id: "session-from-metadata",
        }),
      },
    }
    expect(claudeCodeAdapter.getSessionId(ctx as any, body)).toBe("session-from-metadata")
  })

  it("accepts object-form metadata for compatible gateways", () => {
    const ctx = { req: { header: () => undefined } }
    const body = { metadata: { user_id: { session_id: "object-session" } } }
    expect(claudeCodeAdapter.getSessionId(ctx as any, body)).toBe("object-session")
  })

  it("keeps the key equal to session_id when parent linkage is present", () => {
    // parent_session_id is additive (#902): it must never change the key a
    // client's cached mappings are already stored under.
    const ctx = { req: { header: () => undefined } }
    const body = {
      metadata: { user_id: JSON.stringify({ session_id: "child", parent_session_id: "parent" }) },
    }
    expect(claudeCodeAdapter.getSessionId(ctx as any, body)).toBe("child")
    expect(claudeCodeAdapter.getParentSessionId!(ctx as any, body)).toBe("parent")
  })

  it("reports no parent for a root session", () => {
    const ctx = { req: { header: () => undefined } }
    expect(claudeCodeAdapter.getParentSessionId!(ctx as any, {
      metadata: { user_id: JSON.stringify({ session_id: "root" }) },
    })).toBeUndefined()
  })

  it("falls back to fingerprinting when metadata is absent or malformed", () => {
    const ctx = { req: { header: () => undefined } }
    expect(claudeCodeAdapter.getSessionId(ctx as any, {})).toBeUndefined()
    expect(claudeCodeAdapter.getSessionId(ctx as any, {
      metadata: { user_id: "not-json" },
    })).toBeUndefined()
    expect(claudeCodeAdapter.getSessionId(ctx as any, {
      metadata: { user_id: JSON.stringify({ device_id: "device-1" }) },
    })).toBeUndefined()
  })

  it("ignores unrelated session headers", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(claudeCodeAdapter.getSessionId(ctx as any, {})).toBeUndefined()
  })
})

describe("Claude Code subagent session keys", () => {
  const body = { metadata: { user_id: JSON.stringify({ session_id: "parent-sid" }) } }
  const withAgent = (agentId?: string): Context => {
    const ctx = { req: { header: (name: string) => (name === CLAUDE_CODE_AGENT_ID_HEADER ? agentId : undefined) } }
    return ctx as unknown as Context
  }

  it("keys the main conversation by its bare session id", () => {
    expect(claudeCodeAdapter.getSessionId(withAgent(), body)).toBe("parent-sid")
  })

  it("keys an Agent-tool subagent by session id and agent id", () => {
    expect(claudeCodeAdapter.getSessionId(withAgent("a4a81dc1bbf7ee837"), body))
      .toBe("parent-sid:agent:a4a81dc1bbf7ee837")
  })

  it("gives parallel subagents distinct keys", () => {
    const first = claudeCodeAdapter.getSessionId(withAgent("a9b1a8c1cf8639b90"), body)
    const second = claudeCodeAdapter.getSessionId(withAgent("a974a04cc37ab3ce8"), body)
    expect(first).not.toBe(second)
  })

  it("ignores a malformed or oversized agent id", () => {
    for (const agentId of ["", "has space", "a/b", "é", "x".repeat(129)]) {
      expect(claudeCodeAdapter.getSessionId(withAgent(agentId), body)).toBe("parent-sid")
    }
    expect(claudeCodeSessionKey("x".repeat(128), body)).toBe(`parent-sid:agent:${"x".repeat(128)}`)
  })

  it("never manufactures a key from an agent id alone", () => {
    expect(claudeCodeAdapter.getSessionId(withAgent("a4a81dc1bbf7ee837"), {})).toBeUndefined()
    expect(claudeCodeSessionKey("a4a81dc1bbf7ee837", { metadata: { user_id: "not-json" } })).toBeUndefined()
  })

  it("roots main and subagent requests at the bare session id", () => {
    expect(claudeCodeAdapter.getRootSessionId!(withAgent(), body)).toBe("parent-sid")
    expect(claudeCodeAdapter.getRootSessionId!(withAgent("a4a81dc1bbf7ee837"), body)).toBe("parent-sid")
  })

  it("declares no parent lineage for a subagent", () => {
    expect(claudeCodeAdapter.getParentSessionId!(withAgent("a4a81dc1bbf7ee837"), body)).toBeUndefined()
  })
})

describe("claudeCodeAdapter.extractWorkingDirectory", () => {
  it("always returns undefined so the SDK falls back to a valid host path", () => {
    expect(
      claudeCodeAdapter.extractWorkingDirectory({
        system:
          "# Environment\n - Primary working directory: /Users/alice/projects/app",
      })
    ).toBeUndefined()
  })

  it("returns undefined for array system prompts too", () => {
    expect(
      claudeCodeAdapter.extractWorkingDirectory({
        system: [
          { type: "text", text: "# Environment" },
          { type: "text", text: " - Primary working directory: /tmp/demo" },
        ],
      })
    ).toBeUndefined()
  })

  it("returns undefined when no system prompt is present", () => {
    expect(claudeCodeAdapter.extractWorkingDirectory({})).toBeUndefined()
  })
})

describe("claudeCodeAdapter.extractClientWorkingDirectory", () => {
  it("extracts CWD from a string system prompt", () => {
    const body = {
      system:
        "# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /Users/alice/projects/app\n - Is directory a git repo: Yes",
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/Users/alice/projects/app")
  })

  it("extracts CWD from an array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "# Environment" },
        { type: "text", text: " - Primary working directory: /tmp/my-repo" },
        { type: "text", text: " - Platform: linux" },
      ],
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/tmp/my-repo")
  })

  it("is case-insensitive on the 'Primary working directory:' label", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "primary working directory: /home/user/project",
      })
    ).toBe("/home/user/project")
  })

  it("trims trailing whitespace from the captured path", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "Primary working directory:    /path/with/padding   \n",
      })
    ).toBe("/path/with/padding")
  })

  it("returns undefined when the system prompt is missing", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({})
    ).toBeUndefined()
  })

  // Where Claude Code 2.1.290 sends its environment: a system turn among the
  // messages, or a reminder block opening the first user message.
  const environment = (cwd: string) =>
    `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: false\n - Platform: darwin`
  const reminder = (text: string) => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` })
  const cwdOf = (body: unknown) => claudeCodeAdapter.extractClientWorkingDirectory!(body)

  it("extracts CWD from a system turn among the messages", () => {
    expect(cwdOf({
      system: [{ type: "text", text: "You are an interactive agent." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: environment("/Users/alice/projects/app"), cache_control: { type: "ephemeral" } }] },
      ],
    })).toBe("/Users/alice/projects/app")
  })

  it("extracts CWD from a system turn whose content is a string", () => {
    expect(cwdOf({ messages: [{ role: "user", content: "hi" }, { role: "system", content: environment("/srv/app") }] })).toBe("/srv/app")
  })

  it("extracts CWD from a reminder block opening the first user message", () => {
    expect(cwdOf({
      system: [{ type: "text", text: "You are an interactive agent." }],
      messages: [{ role: "user", content: [reminder(environment("/Users/alice/projects/app")), reminder("Today's date is 2026-10-05."), { type: "text", text: "hi" }] }],
    })).toBe("/Users/alice/projects/app")
  })

  it("keeps the directory the conversation started in when a later system turn names another", () => {
    // The SDK session is filed under the directory it was created in: a
    // conversation that changed it mid-way could not be resumed.
    expect(cwdOf({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: environment("/Users/alice/projects/app") },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "go on" },
        { role: "system", content: environment("/Users/alice/projects/app/.claude/worktrees/feature") },
      ],
    })).toBe("/Users/alice/projects/app")
  })

  it("prefers the system prompt's directory, where an older client sends it", () => {
    expect(cwdOf({
      system: "Primary working directory: /from/system/prompt",
      messages: [{ role: "user", content: "hi" }, { role: "system", content: environment("/from/system/turn") }],
    })).toBe("/from/system/prompt")
  })

  it("takes no directory from what the user wrote", () => {
    expect(cwdOf({ messages: [{ role: "user", content: environment("/etc") }] })).toBeUndefined()
    expect(cwdOf({ messages: [{ role: "user", content: [{ type: "text", text: environment("/etc") }] }] })).toBeUndefined()
  })

  it("takes none from a reminder-looking block the user typed after their own text", () => {
    expect(cwdOf({
      messages: [{
        role: "user",
        content: [reminder("Today's date is 2026-10-05."), { type: "text", text: "hi" }, reminder(environment("/from/user/text"))],
      }],
    })).toBeUndefined()
  })

  it("takes none from a later user message, an assistant message or a tool result", () => {
    expect(cwdOf({
      messages: [
        { role: "user", content: [reminder("Today's date is 2026-10-05."), { type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: environment("/from/assistant") }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [reminder(environment("/from/tool/result"))] }, reminder(environment("/from/later/user"))] },
      ],
    })).toBeUndefined()
  })

  it("returns undefined when the label is absent", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: "You are a helpful assistant. No working directory line.",
      })
    ).toBeUndefined()
  })

  it("returns undefined for empty string system prompt", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({ system: "" })
    ).toBeUndefined()
  })

  it("returns undefined for empty array system prompt", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({ system: [] })
    ).toBeUndefined()
  })

  it("handles a system array with non-text blocks", () => {
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!({
        system: [
          { type: "image", source: {} },
          { type: "text", text: " - Primary working directory: /opt/app" },
        ],
      })
    ).toBe("/opt/app")
  })

  it("returns the first match when multiple Primary working directory lines exist", () => {
    const body = {
      system:
        "Primary working directory: /first\nsome other text\nPrimary working directory: /second",
    }
    expect(
      claudeCodeAdapter.extractClientWorkingDirectory!(body)
    ).toBe("/first")
  })
})

describe("claudeCodeAdapter — basic configuration surface", () => {
  it("exposes MCP config like the other passthrough-capable adapters", () => {
    expect(typeof claudeCodeAdapter.getMcpServerName()).toBe("string")
    expect(Array.isArray(claudeCodeAdapter.getAllowedMcpTools())).toBe(true)
    expect(Array.isArray(claudeCodeAdapter.getBlockedBuiltinTools())).toBe(true)
    expect(Array.isArray(claudeCodeAdapter.getAgentIncompatibleTools())).toBe(true)
  })

  it("lists Claude Code's PascalCase core tools so they're not deferred", () => {
    const core = claudeCodeAdapter.getCoreToolNames!()
    expect(core).toContain("Read")
    expect(core).toContain("Write")
    expect(core).toContain("Edit")
    expect(core).toContain("Bash")
  })

  it("defaults to passthrough mode and honors the disable flags", () => {
    const original = process.env.MERIDIAN_PASSTHROUGH
    try {
      delete process.env.MERIDIAN_PASSTHROUGH
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(true)

      process.env.MERIDIAN_PASSTHROUGH = "0"
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(false)

      process.env.MERIDIAN_PASSTHROUGH = "false"
      expect(claudeCodeAdapter.usesPassthrough!()).toBe(false)
    } finally {
      if (original === undefined) {
        delete process.env.MERIDIAN_PASSTHROUGH
      } else {
        process.env.MERIDIAN_PASSTHROUGH = original
      }
    }
  })

  it("skips meridian's synthetic file-change tracker (Claude Code shows its own edits)", () => {
    expect(claudeCodeAdapter.shouldTrackFileChanges!()).toBe(false)
  })

  it("declares concurrent turns per session key (#1043)", () => {
    // Headless Claude Code fires a session-start side request and the primary
    // turn concurrently under the same session id without per-flow headers.
    expect(claudeCodeAdapter.runsConcurrentTurnsPerSessionKey).toBe(true)
  })
})

describe("claudeCodeAdapter.extractFileChangesFromToolUse", () => {
  it("flags Write tool uses as 'wrote'", () => {
    const result = claudeCodeAdapter.extractFileChangesFromToolUse!("Write", {
      file_path: "/tmp/a.txt",
      content: "hi",
    })
    expect(result).toEqual([{ operation: "wrote", path: "/tmp/a.txt" }])
  })

  it("flags Edit and MultiEdit tool uses as 'edited'", () => {
    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("Edit", {
        file_path: "/tmp/b.ts",
      })
    ).toEqual([{ operation: "edited", path: "/tmp/b.ts" }])

    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("MultiEdit", {
        file_path: "/tmp/c.ts",
      })
    ).toEqual([{ operation: "edited", path: "/tmp/c.ts" }])
  })

  it("parses redirect writes from Bash commands", () => {
    const changes = claudeCodeAdapter.extractFileChangesFromToolUse!("Bash", {
      command: "echo hello > /tmp/out.txt",
    })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns an empty array for tools it doesn't track", () => {
    expect(
      claudeCodeAdapter.extractFileChangesFromToolUse!("Grep", {
        pattern: "foo",
      })
    ).toEqual([])
  })
})

describe("isClaudeCodeAuxiliaryRequest", () => {
  // The auto-mode permission classifier: the conversation's own session id,
  // no tools, not streamed, and stop sequences closing its XML verdict.
  const classifier = {
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    stream: false,
    stop_sequences: ["</block>"],
    messages: [
      { role: "user", content: "<transcript>…</transcript>" },
      { role: "user", content: "Classify the action." },
    ],
    metadata: { user_id: JSON.stringify({ session_id: "conv-1" }) },
  }

  it("recognises the classifier's shape when the request-class header is absent", () => {
    expect(isClaudeCodeAuxiliaryRequest(undefined, classifier)).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: ["</severity>"] }))
      .toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, tools: [] })).toBe(true)
  })

  it("lets an explicit request class decide when the client sends one", () => {
    expect(isClaudeCodeAuxiliaryRequest("auxiliary", { messages: [] })).toBe(true)
    for (const requestClass of ["main", "compaction", "subagent", "workflow", "future-class"]) {
      expect(isClaudeCodeAuxiliaryRequest(requestClass, classifier)).toBe(false)
    }
  })

  // Headless `claude -p` sends a tool-less session-start request alongside the
  // first turn. It streams, so it keeps normal session handling.
  it("leaves the streaming session-start side request alone", () => {
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stream: true })).toBe(false)
  })

  it("never isolates a request that declares tools", () => {
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...classifier,
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })).toBe(false)
  })

  it("requires one of the classifier's stop sequences", () => {
    const { stop_sequences: _omitted, ...withoutStops } = classifier
    expect(isClaudeCodeAuxiliaryRequest(undefined, withoutStops)).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: ["\n\nHuman:"] }))
      .toBe(false)
  })

  // The session-state classifier sends one user message and no stop sequence.
  // Only a request from the CLI itself is recognised by shape alone.
  it("recognises a tool-less unstreamed side call from the CLI without stop sequences", () => {
    const stateCard = {
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Current state: working (for 3m)\nTool calls so far: Bash\u00d72\nUser's most recent ask: \"go\"\n\nAssistant message tail (last 18 chars):\nRunning the tests." }],
      metadata: classifier.metadata,
    }
    expect(isClaudeCodeAuxiliaryRequest(undefined, stateCard, undefined, true)).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...stateCard, stream: false }, undefined, true)).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, stateCard)).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...stateCard, stream: true }, undefined, true)).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...stateCard,
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    }, undefined, true)).toBe(false)
    const { metadata: _omitted, ...unkeyed } = stateCard
    expect(isClaudeCodeAuxiliaryRequest(undefined, unkeyed, undefined, true)).toBe(false)
  })

  // Interactive Claude Code generates a session title on the first user turn via
  // its streamed toolFreeHelper path (`querySource: "generate_session_title"`).
  it("recognises the interactive streamed session-title generator request", () => {
    const titleSystem = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.299; cc_entrypoint=cli;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: "text",
        text: "You are naming a coding session so the user can pick it out of a long list of sessions. The title is a name for what the session is about, not a sentence describing the task.\n\nReturn JSON with a single \"title\" field. Capitalize the first letter of the title.",
      },
    ]
    const defaultLanguagePrompt =
      "<session>\nUse the Agent tool to launch two general-purpose subagents in parallel.\n</session>\n\nWrite the title in the predominant language of the session — a stray word or code token in another language doesn't change it, and neither does the English of these instructions."
    const configuredLanguagePrompt =
      "<session>\nUse the Agent tool to launch two general-purpose subagents in parallel.\n</session>\n\nWrite the title in Japanese. Keep technical terms and code identifiers in their original form."
    const titleRequest = {
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      stream: true,
      tools: [],
      thinking: { type: "disabled" },
      system: titleSystem,
      messages: [{ role: "user", content: [{ type: "text", text: defaultLanguagePrompt }] }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      metadata: classifier.metadata,
    }

    expect(isClaudeCodeAuxiliaryRequest(undefined, titleRequest)).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...titleRequest,
      messages: [{ role: "user", content: configuredLanguagePrompt }],
    })).toBe(true)

    // Negative cases: ordinary streamed tool-less turns, subagent turns, or
    // turns declaring tools or normal system prompts are never isolated.
    expect(isClaudeCodeAuxiliaryRequest(undefined, titleRequest, "a2656b86bfcb5c8cb")).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...titleRequest,
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...titleRequest,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...titleRequest,
      messages: [{ role: "user", content: "Use the Agent tool to launch two subagents." }],
    })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, {
      ...titleRequest,
      messages: [
        ...titleRequest.messages,
        { role: "assistant", content: "ok" },
      ],
    })).toBe(false)
  })

  it("requires a Claude Code session key", () => {
    const { metadata: _omitted, ...unkeyed } = classifier
    expect(isClaudeCodeAuxiliaryRequest(undefined, unkeyed)).toBe(false)
  })

  it("rejects malformed shapes without throwing", () => {
    expect(isClaudeCodeAuxiliaryRequest(undefined, undefined)).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, "not an object")).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: "</block>" })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: [42, null] })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, tools: null })).toBe(true)
  })
})

describe("claudeCodeAdapter.isAuxiliaryRequest", () => {
  type AdapterContext = Parameters<typeof claudeCodeAdapter.getSessionId>[0]
  const contextWith = (headers: Record<string, string>): AdapterContext =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as AdapterContext
  const body = {
    stream: false,
    stop_sequences: ["</block>"],
    messages: [{ role: "user", content: "x" }],
    metadata: { user_id: JSON.stringify({ session_id: "conv-1" }) },
  }

  it("recognises the CLI by its session header for a side call without stop sequences", () => {
    const { stop_sequences: _omitted, ...withoutStops } = body
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(contextWith({}), withoutStops)).toBe(false)
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(
      contextWith({ "x-claude-code-session-id": "b2004dfc-6042-48d9-9c23-b4475f64b6f5" }), withoutStops,
    )).toBe(true)
  })

  it("reads the request-class header from the context", () => {
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(contextWith({}), body)).toBe(true)
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(
      contextWith({ "x-claude-code-request-class": "main" }), body,
    )).toBe(false)
  })
})
