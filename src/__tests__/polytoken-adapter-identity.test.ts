/**
 * Polytoken adapter identity — direct unit tests.
 *
 * The native adapter's identity comes ONLY from the X-Polytoken-Session
 * header: no parent identity, no routing attestation, no agent-mode scoping,
 * no OpenCode lineage normalization. Content normalization reuses the generic
 * helper. CWD extraction returns undefined (the client environment may differ
 * from the proxy) rather than parsing client prose.
 */
import { describe, it, expect } from "bun:test"
import { polytokenAdapter } from "../proxy/adapters/polytoken"
import { normalizeContent } from "../proxy/messages"

function ctx(headers: Record<string, string> = {}, body?: unknown): any {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    body,
  }
}

describe("polytokenAdapter identity", () => {
  it("is named polytoken with the polytoken MCP server name", () => {
    expect(polytokenAdapter.name).toBe("polytoken")
    expect(polytokenAdapter.getMcpServerName()).toBe("polytoken")
  })

  it("reads session identity only from the native header", () => {
    const c = ctx({ "x-polytoken-session": "native-1" })
    expect(polytokenAdapter.getSessionId(c)).toBe("native-1")
  })

  it("ignores OpenCode, affinity, and litellm identity headers entirely", () => {
    const c = ctx({
      "x-opencode-session": "oc-1",
      "x-session-affinity": "aff-1",
      "x-litellm-session-id": "llm-1",
      "x-jcode-session": "j-1",
    })
    expect(polytokenAdapter.getSessionId(c)).toBeUndefined()
  })

  it("does not manufacture identity from a blank native header", () => {
    expect(polytokenAdapter.getSessionId(ctx({ "x-polytoken-session": "  " }))).toBeUndefined()
    expect(polytokenAdapter.getSessionId(ctx({}))).toBeUndefined()
  })

  it("does not scope by agent mode or read a parent id", () => {
    const c = ctx({
      "x-polytoken-session": "native-1",
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "scout",
      "x-polytoken-parent-session": "parent-1",
    })
    expect(polytokenAdapter.getSessionId(c)).toBe("native-1")
    expect(polytokenAdapter.getAgentMode?.(c)).toBeUndefined()
    expect(polytokenAdapter.getParentSessionId?.(c)).toBeUndefined()
  })

  it("never returns a routing-turn identity (no attestation parsing)", () => {
    const c = ctx({
      "x-polytoken-session": "native-1",
      "x-opencode-agent-mode": "primary",
      "x-opencode-agent-name": "main",
      "x-meridian-attestation": "anything",
    })
    expect(polytokenAdapter.getRoutingTurnIdentity?.(c)).toBeUndefined()
  })

  it("does not run OpenCode lineage canonicalization (generic hook messages stay hashed)", () => {
    const messages = [{
      role: "user",
      content: [{ type: "text", text: "<user-prompt-submit-hook>{\"continue\":true}</user-prompt-submit-hook>" }],
    }]
    // No canonicalizer hook: the server falls back to the raw messages, so
    // OpenCode's hook-block stripping never applies to native traffic.
    expect(polytokenAdapter.canonicalizeMessagesForLineage).toBeUndefined()
  })

  it("reuses the generic content normalizer", () => {
    expect(polytokenAdapter.normalizeContent("hello")).toBe(normalizeContent("hello"))
    expect(polytokenAdapter.normalizeContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]))
      .toBe(normalizeContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]))
  })

  it("returns undefined CWD for both proxy and client extraction (remote client)", () => {
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n</env>",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "<system-reminder>cwd=/tmp/x</system-reminder>" }],
      }],
    }
    expect(polytokenAdapter.extractWorkingDirectory(body)).toBeUndefined()
    expect(polytokenAdapter.extractClientWorkingDirectory?.(body)).toBeUndefined()
    expect(polytokenAdapter.clientEnvironmentMayDifferFromProxy).toBe(true)
  })

  it("keeps strict same-key serialization (no concurrent-turn opt-out)", () => {
    expect(polytokenAdapter.runsConcurrentTurnsPerSessionKey).toBeUndefined()
  })

  it("does not parse Task tools into SDK agents/hooks (client-owned tool loop)", () => {
    const body = {
      tools: [{
        name: "task",
        description: "Launch subagent 'scout'",
        input_schema: { type: "object", properties: { subagent_type: { type: "string" } } },
      }],
    }
    expect(polytokenAdapter.buildSdkAgents?.(body, []) ?? {}).toEqual({})
    expect(polytokenAdapter.buildSdkHooks?.(body, {})).toBeUndefined()
    expect(polytokenAdapter.buildSystemContextAddendum?.(body, {})).toBe("")
  })
})