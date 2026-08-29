/**
 * Tests for the OpenCode plugin's agent-mode header (plugin/meridian.ts).
 *
 * OpenCode >= 1.17 passes `agent` to the chat.headers hook as the agent
 * NAME (a string); older versions passed the full `{ name, mode }` object.
 * The plugin must classify subagents correctly in both shapes — a string
 * agent silently mapped to "primary" sends subagent traffic out at the
 * primary 1M tier, burning rate-limit budget and (field-observed) tripping
 * Anthropic's extra-usage metering on fresh subagent sessions.
 */
import { describe, it, expect, test } from "bun:test"
import MeridianPlugin from "../../plugin/meridian"
import { PRIORITY_ATTESTATION_HEADER } from "../../plugin/priority-attestation"
import { verifyPriorityAttestation } from "../proxy/priorityAttestation"

type Hooks = Awaited<ReturnType<typeof MeridianPlugin>>

async function instance(cfgAgents?: Record<string, { mode?: string; hidden?: boolean }>): Promise<Hooks> {
  const hooks = await MeridianPlugin({})
  if (cfgAgents) await hooks.config?.({ agent: cfgAgents })
  return hooks
}

async function headersFor(
  hooks: Hooks,
  agent: unknown,
  providerID = "anthropic",
): Promise<Record<string, string>> {
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      sessionID: "ses_test",
      agent: agent as any,
      model: { providerID },
      message: { id: "msg_test", time: { created: Date.now() } },
    },
    output,
  )
  return output.headers
}

describe("plugin/meridian.ts agent-mode header", () => {
  it("legacy object agent: reads mode directly", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, { name: "explore", mode: "subagent" })
    expect(h["x-opencode-agent-mode"]).toBe("subagent")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("string agent: built-in subagents resolve to subagent", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "explore"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: built-in primaries resolve to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "build"))["x-opencode-agent-mode"]).toBe("primary")
    expect((await headersFor(hooks, "plan"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: user-defined subagent from config resolves to subagent", async () => {
    const hooks = await instance({ "code-reviewer": { mode: "subagent" } })
    expect((await headersFor(hooks, "code-reviewer"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: config override of a built-in wins", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: unknown names fall back to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "mystery-agent"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it('mode "all" is normalized to primary', async () => {
    const hooks = await instance({ flexible: { mode: "all" } })
    expect((await headersFor(hooks, "flexible"))["x-opencode-agent-mode"]).toBe("primary")
    const legacy = await headersFor(hooks, { name: "flexible", mode: "all" })
    expect(legacy["x-opencode-agent-mode"]).toBe("primary")
  })

  it("session and request headers are always set for anthropic requests", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "explore")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-opencode-request"]).toBe("msg_test")
  })

  it("non-anthropic providers get no headers", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "title", "openrouter")
    expect(Object.keys(h)).toHaveLength(0)
  })

  it("agent names are sanitized to printable ASCII", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "expl\u200bore\u2728")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("config hook state is per plugin instance", async () => {
    const a = await instance({ shared: { mode: "subagent" } })
    const b = await instance()
    expect((await headersFor(a, "shared"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(b, "shared"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire drops agents removed from config", async () => {
    const hooks = await instance({ temp: { mode: "subagent" } })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("subagent")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire restores built-in mode when an override is removed", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })
})


describe("plugin/meridian.ts trusted routing attestation", () => {
  const key = Buffer.alloc(32, 11)

  async function routingHeaders(options: {
    agent: AgentInputForTest
    messageID?: string
    messageCreatedAt?: number
    parentID?: string
    initial?: Record<string, string>
    config?: Record<string, { mode?: string; hidden?: boolean }>
  }): Promise<Record<string, string>> {
    const hooks = await MeridianPlugin({
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data: { id: path.id, ...(options.parentID ? { parentID: options.parentID } : {}) },
          }),
        },
      },
    })
    if (options.config) await hooks.config?.({ agent: options.config })
    const output = { headers: { ...(options.initial ?? {}) } }
    await hooks["chat.headers"]!({
      sessionID: "ses_test",
      agent: options.agent,
      model: { providerID: "anthropic" },
      message: {
        id: options.messageID ?? "msg_test",
        sessionID: "ses_test",
        time: { created: options.messageCreatedAt ?? Date.now() },
      },
    }, output)
    return output.headers
  }

  type AgentInputForTest = string | { name?: string; mode?: string; hidden?: boolean }

  test("signs only an exact visible primary root human message", async () => {
    const saved = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
    try {
      const createdAt = Date.now()
      const first = await routingHeaders({ agent: "build", messageID: "msg_human_1", messageCreatedAt: createdAt })
      const same = await routingHeaders({ agent: "build", messageID: "msg_human_1", messageCreatedAt: createdAt })
      const next = await routingHeaders({ agent: "build", messageID: "msg_human_2", messageCreatedAt: createdAt + 1_000 })
      const replayedFirst = await routingHeaders({ agent: "build", messageID: "msg_human_1", messageCreatedAt: createdAt })
      const a = verifyPriorityAttestation(first[PRIORITY_ATTESTATION_HEADER], key)
      const b = verifyPriorityAttestation(same[PRIORITY_ATTESTATION_HEADER], key)
      const c = verifyPriorityAttestation(next[PRIORITY_ATTESTATION_HEADER], key)
      const replayedA = verifyPriorityAttestation(replayedFirst[PRIORITY_ATTESTATION_HEADER], key)
      expect(a?.generation).toBe("oc1")
      expect(a?.turnId).toBe(b?.turnId)
      expect(a?.issuedAt).toBe(b?.issuedAt)
      expect(c?.turnId).not.toBe(a?.turnId)
      expect(c!.issuedAt).toBeGreaterThan(a!.issuedAt)
      expect(replayedA?.turnId).toBe(a?.turnId)
      expect(replayedA?.issuedAt).toBe(a?.issuedAt)
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = saved
    }
  })

  test("rejects hidden, internal, all, subagent, unknown, fork, and pinned turns", async () => {
    const saved = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
    try {
      const cases = [
        await routingHeaders({ agent: "title" }),
        await routingHeaders({ agent: "summary" }),
        await routingHeaders({ agent: "compaction" }),
        await routingHeaders({ agent: "explore" }),
        await routingHeaders({ agent: "unknown-custom" }),
        await routingHeaders({ agent: "hidden-custom", config: { "hidden-custom": { mode: "primary", hidden: true } } }),
        await routingHeaders({ agent: "all-custom", config: { "all-custom": { mode: "all", hidden: false } } }),
        await routingHeaders({ agent: "primary-custom", config: { "primary-custom": { mode: "primary", hidden: false } }, parentID: "ses_parent" }),
        await routingHeaders({ agent: "build", initial: { "X-Meridian-Profile": "work" } }),
        await routingHeaders({ agent: " build ", config: { " build ": { mode: "primary", hidden: false } } }),
        await routingHeaders({ agent: "build\u200b", config: { "build\u200b": { mode: "primary", hidden: false } } }),
      ]
      for (const headers of cases) expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = saved
    }
  })

  test("passes the abort signal inside the V1 session.get options object", async () => {
    let lookupInput: unknown
    const hooks = await MeridianPlugin({
      client: {
        session: {
          get: async (input: unknown) => {
            lookupInput = input
            return { data: { id: "ses_test" } }
          },
        },
      },
    })
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!({
      sessionID: "ses_test",
      agent: "build",
      model: { providerID: "anthropic" },
      message: { id: "msg_test", sessionID: "ses_test", time: { created: Date.now() } },
    }, output)
    expect(lookupInput).toMatchObject({ path: { id: "ses_test" }, signal: expect.any(AbortSignal) })
  })

  test("scrubs mixed-case spoofed attestations before a fail-closed decision", async () => {
    const headers = await routingHeaders({
      agent: "explore",
      initial: { "X-Meridian-OpenCode-Turn": "spoofed" },
    })
    expect(headers["X-Meridian-OpenCode-Turn"]).toBeUndefined()
    expect(headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()
  })
})
