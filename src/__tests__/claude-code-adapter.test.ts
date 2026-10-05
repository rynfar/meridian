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
      .toBe("\u0000meridian-claude-code:1:[\"agent\",\"parent-sid\",\"a4a81dc1bbf7ee837\"]")
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
    expect(claudeCodeSessionKey("x".repeat(128), body)).toBe(`\u0000meridian-claude-code:1:["agent","parent-sid","${"x".repeat(128)}"]`)
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
    system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\nfixture permissions\n</cc_automode_permissions>\nReturn a verdict." }],
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

  it("accepts omitted stage2 stops and rejects unknown supplied stops", () => {
    const { stop_sequences: _omitted, ...withoutStops } = classifier
    expect(isClaudeCodeAuxiliaryRequest(undefined, withoutStops)).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: [] })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: ["</block>", "</severity>"] })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: ["\n\nHuman:"] }))
      .toBe(false)
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
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, tools: null })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, tools: "none" })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stream: undefined })).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stream: "false" })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, stop_sequences: ["</block>", 42] })).toBe(false)
  })

  it("requires the classifier-specific system envelope, not ordinary XML output", () => {
    const { system: _system, ...ordinary } = classifier
    expect(isClaudeCodeAuxiliaryRequest(undefined, ordinary)).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...ordinary, system: "Write XML ending at </block>." })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...ordinary, system: [{ type: "text", text: "<cc_automode_permissions>" }] })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...ordinary, messages: [
      { role: "user", content: "Write a block." },
      { role: "assistant", content: "<block>one</block>" },
      { role: "user", content: "Write another block." },
    ] })).toBe(false)
    // The official segmented classifier can carry more than two user turns.
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, messages: [
      ...classifier.messages, { role: "user", content: "another transcript segment" },
    ] })).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, system: classifier.system[0]!.text })).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, system: [
      { type: "text", text: "x-anthropic-billing-header: fixture" }, ...classifier.system,
    ] })).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, system: "<cc_automode_permissions>\nfixture permissions\n</cc_automode_permissions>" })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...ordinary, system: [
      { type: "text", text: "You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\nfixture" },
      { type: "text", text: "\n</cc_automode_permissions>" },
    ] })).toBe(false)
  })

  it("rejects a long malformed classifier envelope and permits empty permissions", () => {
    const prefix = "You are a security monitor for autonomous AI coding agents."
    const unclosed = `${prefix}\n${"<cc_automode_permissions>\n".repeat(8192)}`
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier, system: unclosed })).toBe(false)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier,
      system: `${prefix}\n<cc_automode_permissions>\n</cc_automode_permissions>` })).toBe(true)
    expect(isClaudeCodeAuxiliaryRequest(undefined, { ...classifier,
      system: `${prefix}\n<cc_automode_permissions>\nfixture\n</cc_automode_permissions>unfinished` })).toBe(false)
  })
})

describe("claudeCodeAdapter.isAuxiliaryRequest", () => {
  type AdapterContext = Parameters<typeof claudeCodeAdapter.getSessionId>[0]
  const contextWith = (headers: Record<string, string>): AdapterContext =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as AdapterContext
  const body = {
    system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\nfixture permissions\n</cc_automode_permissions>" }],
    stream: false,
    stop_sequences: ["</block>"],
    messages: [{ role: "user", content: "x" }],
    metadata: { user_id: JSON.stringify({ session_id: "conv-1" }) },
  }

  it("reads the request-class header from the context", () => {
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(contextWith({}), body)).toBe(true)
    expect(claudeCodeAdapter.isAuxiliaryRequest?.(
      contextWith({ "x-claude-code-request-class": "main" }), body,
    )).toBe(false)
  })
})
