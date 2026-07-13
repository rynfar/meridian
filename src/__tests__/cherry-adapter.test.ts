/**
 * Cherry Studio adapter — unit tests.
 *
 * Cherry Studio is a chat client (not a coding agent). Unlike OpenCode, it
 * relies on Claude's *own* built-in web search rather than executing tools
 * itself. Meridian blocks WebSearch/WebFetch globally for coding agents (they
 * have their own equivalents), which is why #481 saw "no WebSearch/WebFetch
 * tool exposed". This adapter unblocks the SDK's built-in web tools and runs
 * internally (non-passthrough) so Claude executes the search and returns a
 * grounded answer.
 */
import { describe, it, expect } from "bun:test"
import { cherryAdapter } from "../proxy/adapters/cherry"
import { cherryTransforms } from "../proxy/transforms/cherry"
import { detectAdapter } from "../proxy/adapters/detect"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../proxy/tools"
import type { RequestContext } from "../proxy/transform"

function ctxFor(headers: Record<string, string>) {
  const h = new Headers(headers)
  return { req: { header: (k: string) => h.get(k) ?? undefined, raw: { headers: h } } } as any
}

describe("cherryAdapter identity", () => {
  it("is named 'cherry'", () => {
    expect(cherryAdapter.name).toBe("cherry")
  })

  it("runs in internal (non-passthrough) mode so the SDK executes WebSearch", () => {
    expect(cherryAdapter.usesPassthrough?.()).toBe(false)
  })
})

describe("cherryAdapter tool policy", () => {
  it("does NOT block the built-in web tools", () => {
    const blocked = cherryAdapter.getBlockedBuiltinTools()
    expect(blocked).not.toContain("WebSearch")
    expect(blocked).not.toContain("WebFetch")
  })

  it("still blocks the other built-ins (Read/Write/Bash/etc.)", () => {
    const blocked = cherryAdapter.getBlockedBuiltinTools()
    for (const t of BLOCKED_BUILTIN_TOOLS) {
      if (t === "WebSearch" || t === "WebFetch") continue
      expect(blocked).toContain(t)
    }
  })

  it("does NOT list WebSearch among agent-incompatible tools", () => {
    expect(cherryAdapter.getAgentIncompatibleTools()).not.toContain("WebSearch")
  })

  it("allows exactly the built-in web tools (no filesystem MCP tools for a chat client)", () => {
    const allowed = cherryAdapter.getAllowedMcpTools()
    expect([...allowed].sort()).toEqual(["WebFetch", "WebSearch"])
  })
})

describe("cherryTransforms onRequest", () => {
  const base: RequestContext = {
    adapter: "cherry",
    body: { messages: [{ role: "user", content: "search the web" }] },
    headers: new Headers(),
    model: "sonnet",
    messages: [{ role: "user", content: "search the web" }],
    systemContext: undefined,
    tools: undefined,
    stream: false,
    workingDirectory: "/tmp",
    blockedTools: [],
    incompatibleTools: [],
    allowedMcpTools: [],
  } as any

  const out = cherryTransforms[0]!.onRequest!(base)

  it("puts WebSearch/WebFetch in the allowlist", () => {
    expect([...out.allowedMcpTools].sort()).toEqual(["WebFetch", "WebSearch"])
  })

  it("keeps the web tools OUT of both disallowed lists", () => {
    expect(out.blockedTools).not.toContain("WebSearch")
    expect(out.blockedTools).not.toContain("WebFetch")
    expect(out.incompatibleTools).not.toContain("WebSearch")
  })

  it("still disallows the rest of the blocked built-ins", () => {
    for (const t of CLAUDE_CODE_ONLY_TOOLS) {
      if (t === "WebSearch") continue
      expect(out.incompatibleTools).toContain(t)
    }
  })

  it("runs non-passthrough (SDK executes the search internally)", () => {
    expect(out.passthrough).toBe(false)
  })

  it("hides internal tool_use and unrenderable thinking from the chat client", () => {
    expect(out.hidesInternalTools).toBe(true)
    expect(out.supportsThinking).toBe(false)
  })
})

describe("detectAdapter → cherry", () => {
  it("selects cherry via x-meridian-agent: cherry", () => {
    expect(detectAdapter(ctxFor({ "x-meridian-agent": "cherry" })).name).toBe("cherry")
  })

  it("also accepts the 'cherrystudio' alias", () => {
    expect(detectAdapter(ctxFor({ "x-meridian-agent": "cherrystudio" })).name).toBe("cherry")
  })
})
