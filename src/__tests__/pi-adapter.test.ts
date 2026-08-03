/**
 * Tests for the Pi coding agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { piAdapter } from "../proxy/adapters/pi"

describe("piAdapter — identity", () => {
  it("has name 'pi'", () => {
    expect(piAdapter.name).toBe("pi")
  })
})

describe("piAdapter.getSessionId", () => {
  it("returns x-session-affinity when present (orchestrator-supplied session key)", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-session-affinity" ? "worker-run-1" : undefined,
      },
    }
    expect(piAdapter.getSessionId(ctx as any)).toBe("worker-run-1")
  })

  it("returns undefined without the affinity header — bare pi sends no session header", () => {
    const ctx = {
      req: { header: () => undefined },
    }
    expect(piAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("ignores x-opencode-session (opencode's header is not pi's)", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(piAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("piAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from string system prompt", () => {
    const body = {
      system: "You are an expert coding assistant.\nCurrent working directory: /Users/test/project\nMore instructions here.",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("extracts CWD from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "You are an expert coding assistant." },
        { type: "text", text: "Current working directory: /tmp/my-repo" },
      ],
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/tmp/my-repo")
  })

  it("extracts CWD case-insensitively", () => {
    const body = {
      system: "current working directory: /home/user/project",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/home/user/project")
  })

  it("returns undefined when system prompt is missing", () => {
    expect(piAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined when system prompt has no CWD line", () => {
    const body = {
      system: "You are a helpful assistant. No directory info here.",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined for empty string system", () => {
    expect(piAdapter.extractWorkingDirectory({ system: "" })).toBeUndefined()
  })

  it("returns undefined for empty array system", () => {
    expect(piAdapter.extractWorkingDirectory({ system: [] })).toBeUndefined()
  })

  it("handles system array with non-text blocks", () => {
    const body = {
      system: [
        { type: "image", source: {} },
        { type: "text", text: "Current working directory: /opt/app" },
      ],
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/opt/app")
  })

  it("trims trailing whitespace from CWD", () => {
    const body = {
      system: "Current working directory: /Users/test/project   \nNext line",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })
})

describe("piAdapter.extractClientWorkingDirectory", () => {
  it("mirrors extractWorkingDirectory — returns the parsed CWD", () => {
    const body = {
      system: "You are an expert coding assistant.\nCurrent working directory: /Users/test/project",
    }
    expect(piAdapter.extractClientWorkingDirectory!(body)).toBe("/Users/test/project")
  })

  it("extracts from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "System intro." },
        { type: "text", text: "Current working directory: /tmp/my-repo" },
      ],
    }
    expect(piAdapter.extractClientWorkingDirectory!(body)).toBe("/tmp/my-repo")
  })

  it("returns undefined when system prompt lacks the CWD line", () => {
    expect(
      piAdapter.extractClientWorkingDirectory!({ system: "no cwd line here" })
    ).toBeUndefined()
  })

  it("returns undefined when system prompt is missing", () => {
    expect(piAdapter.extractClientWorkingDirectory!({})).toBeUndefined()
  })

  it("returns the same value as extractWorkingDirectory for any body", () => {
    // This parity guarantee is load-bearing: the default resolution in
    // server.ts collapses the two paths for same-host clients. If they
    // diverged, buildCwdNote would emit a spurious <env> addendum.
    const bodies = [
      { system: "Current working directory: /a" },
      { system: [{ type: "text", text: "Current working directory: /b" }] },
      { system: "no directory here" },
      {},
    ]
    for (const body of bodies) {
      expect(piAdapter.extractClientWorkingDirectory!(body))
        .toBe(piAdapter.extractWorkingDirectory(body))
    }
  })
})

describe("piAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(piAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]
    const result = piAdapter.normalizeContent(content)
    expect(result).toContain("First block")
    expect(result).toContain("Second block")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = piAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("handles null content", () => {
    expect(piAdapter.normalizeContent(null as any)).toBe("null")
  })
})

describe("piAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes SDK PascalCase tool names", () => {
    const blocked = piAdapter.getBlockedBuiltinTools()
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getBlockedBuiltinTools does NOT include Pi's lowercase tool names", () => {
    const blocked = piAdapter.getBlockedBuiltinTools()
    expect(blocked).not.toContain("bash")
    expect(blocked).not.toContain("edit")
    expect(blocked).not.toContain("write")
    expect(blocked).not.toContain("read")
    expect(blocked).not.toContain("grep")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = piAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("ExitPlanMode")
    // ToolSearch is intentionally NOT incompatible — it is used internally by the SDK
    // for deferred tool loading and must not be blocked.
    expect(incompatible).not.toContain("ToolSearch")
    expect(incompatible).toContain("CronCreate")
    expect(incompatible).toContain("EnterWorktree")
  })

  it("getMcpServerName returns 'pi'", () => {
    expect(piAdapter.getMcpServerName()).toBe("pi")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(piAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__pi__ prefix", () => {
    for (const tool of piAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__pi__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = piAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__pi__read")
    expect(tools).toContain("mcp__pi__write")
    expect(tools).toContain("mcp__pi__edit")
    expect(tools).toContain("mcp__pi__bash")
    expect(tools).toContain("mcp__pi__glob")
    expect(tools).toContain("mcp__pi__grep")
  })
})

describe("piAdapter.buildSdkAgents", () => {
  it("always returns empty object", () => {
    expect(piAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("piAdapter.buildSdkHooks", () => {
  it("always returns undefined", () => {
    expect(piAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })
})

describe("piAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string", () => {
    expect(piAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("piAdapter.usesPassthrough", () => {
  it("defaults to passthrough mode and honors the disable flags", () => {
    const original = process.env.MERIDIAN_PASSTHROUGH
    try {
      delete process.env.MERIDIAN_PASSTHROUGH
      expect(piAdapter.usesPassthrough!()).toBe(true)

      process.env.MERIDIAN_PASSTHROUGH = "0"
      expect(piAdapter.usesPassthrough!()).toBe(false)

      process.env.MERIDIAN_PASSTHROUGH = "false"
      expect(piAdapter.usesPassthrough!()).toBe(false)
    } finally {
      if (original === undefined) {
        delete process.env.MERIDIAN_PASSTHROUGH
      } else {
        process.env.MERIDIAN_PASSTHROUGH = original
      }
    }
  })
})

describe("piAdapter.extractFileChangesFromToolUse", () => {
  it("detects write with filePath", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { filePath: "/tmp/test.ts", content: "hello" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with file_path fallback", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { file_path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with path fallback", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects edit with filePath", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("edit", { filePath: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "edited", path: "/tmp/test.ts" }])
  })

  it("detects bash commands with output redirects", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("bash", { command: "echo hello > /tmp/out.txt" })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns empty for read tool", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("read", { filePath: "/tmp/test.ts" })).toEqual([])
  })

  it("returns empty for grep tool", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("grep", { pattern: "TODO" })).toEqual([])
  })

  it("returns empty for write with no path", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("write", { content: "hello" })).toEqual([])
  })

  it("returns empty for bash with no command", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("bash", {})).toEqual([])
  })

  it("returns empty for null input", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("write", null)).toEqual([])
  })
})


/**
 * #734: Oh My Pi carries a stable per-agent session id in metadata.user_id
 * rather than a header. Without reading it, every OMP request ending in
 * `user[tool_result]` hit the headerless `isClientDrivenLoop` bypass — no
 * session key means an independent request, which skips lineage lookup and
 * starts a fresh SDK session on every tool round.
 */
describe("piAdapter.getSessionId — body identity fallback (#734)", () => {
  const ctx = (headers: Record<string, string> = {}) => ({
    req: { header: (n: string) => headers[n] },
  }) as any

  const ompBody = (sessionId: string) => ({
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
  })

  it("reads the OMP session id from metadata.user_id", () => {
    expect(piAdapter.getSessionId(ctx(), ompBody("omp-main-1"))).toBe("omp-main-1")
  })

  it("keeps x-session-affinity authoritative over the body", () => {
    // Pi's own convention, and an orchestrator-supplied key must keep winning.
    expect(piAdapter.getSessionId(ctx({ "x-session-affinity": "hdr" }), ompBody("body")))
      .toBe("hdr")
  })

  it("returns undefined for a stock Pi client with neither", () => {
    // The headerless bypass must stay reachable — it is correct for genuinely
    // concurrent tool loops with no identity at all.
    expect(piAdapter.getSessionId(ctx(), {})).toBeUndefined()
    expect(piAdapter.getSessionId(ctx())).toBeUndefined()
  })

  it("ignores a plain-string user_id, which is not a session declaration", () => {
    // Anthropic's user_id is a USER identifier; adopting one as a session key
    // would collide every conversation from that user into one SDK session.
    expect(piAdapter.getSessionId(ctx(), { metadata: { user_id: "user-123" } })).toBeUndefined()
  })

  it("ignores a JSON envelope without a session_id", () => {
    expect(piAdapter.getSessionId(ctx(), { metadata: { user_id: JSON.stringify({ account: "a" }) } }))
      .toBeUndefined()
  })

  it("ignores an empty session_id", () => {
    expect(piAdapter.getSessionId(ctx(), ompBody(""))).toBeUndefined()
  })

  it("keeps distinct agents on distinct sessions", () => {
    // OMP gives Main, Advisor and each subagent its own id; that distinctness
    // is what makes adopting the key safe against the collision the bypass
    // exists to prevent.
    const main = piAdapter.getSessionId(ctx(), ompBody("omp-main"))
    const advisor = piAdapter.getSessionId(ctx(), ompBody("omp-advisor"))
    expect(main).not.toBe(advisor)
  })
})
