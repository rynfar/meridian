/**
 * Tests for the OpenCode plugin's agent-mode header (plugin/meridian.ts).
 *
 * OpenCode >= 1.17 passes `agent` to the chat.headers hook as the agent
 * NAME (a string); older versions passed the full `{ name, mode }` object.
 * The plugin must classify subagents correctly in both shapes — a string
 * agent silently mapped to "primary" sends subagent traffic out at the
 * primary 1M tier, burning rate-limit budget and (field-observed) tripping
 * Anthropic's extra-usage metering on fresh subagent sessions.
 *
 * `headersFor` invokes the hook with OpenCode's real empty output object, then
 * composes the final wire headers from OpenCode's base headers, model headers,
 * and plugin output. It used to return only the plugin contribution, which made
 * class of change look verified when it was a no-op: a header the plugin stops
 * setting is still on the wire if OpenCode set it, and Meridian reads the wire.
 *
 * Extracted from the OpenCode 1.18.11 binary (bun-compiled; visible via
 * `strings`), for any provider whose id does not start with "opencode" — which
 * is every request that reaches Meridian:
 *
 *   headers: {
 *     ...(providerID.startsWith("opencode")
 *        ? { "x-opencode-session": sessionID, "x-opencode-request": user.id, ... }
 *        : { "x-session-affinity": sessionID, "X-Session-Id": sessionID,
 *            ...(parentSessionID ? {"x-parent-session-id": parentSessionID} : {}),
 *            "User-Agent": Ri }),
 *     ...model.headers,
 *     ...f            // f = this plugin's chat.headers output — spread LAST
 *   }
 *
 * Two facts follow, and both are load-bearing for anything that touches
 * session identity:
 *
 *   1. OpenCode ALWAYS contributes `x-session-affinity` (and `X-Session-Id`)
 *      on this path. A plugin cannot remove that key by declining to set one.
 *   2. Plugin headers are spread LAST, so a plugin CAN override it.
 */
import { describe, it, expect, test } from "bun:test"
import { Hono } from "hono"
import MeridianPlugin from "../../plugin/meridian"
import { PRIORITY_ATTESTATION_HEADER } from "../../plugin/priority-attestation"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { verifyPriorityAttestation } from "../proxy/priorityAttestation"

type Hooks = Awaited<ReturnType<typeof MeridianPlugin>>
type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>
type AgentInputForTest = Parameters<ChatHeadersHook>[0]["agent"]
type ChatHeadersOutput = Parameters<ChatHeadersHook>[1]

async function instance(cfgAgents?: Record<string, { mode?: string; hidden?: boolean }>): Promise<Hooks> {
  const hooks = await MeridianPlugin({})
  if (cfgAgents) await hooks.config?.({ agent: cfgAgents })
  return hooks
}

/** The native headers OpenCode places on the final request before plugin output. */
function openCodeBaseHeaders(sessionID: string): Record<string, string> {
  return {
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    "User-Agent": "opencode/1.18.11 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14",
  }
}

async function pluginHeadersFor(
  hooks: Hooks,
  agent: AgentInputForTest,
  providerID = "anthropic",
  sessionID = "ses_test",
): Promise<Record<string, string>> {
  const output: ChatHeadersOutput = { headers: {} }
  const hook = hooks["chat.headers"]
  if (!hook) throw new Error("chat.headers hook was not registered")
  await hook(
    {
      sessionID,
      agent,
      model: { providerID },
      message: { id: "msg_test", time: { created: Date.now() } },
    },
    output,
  )
  return output.headers
}

async function headersFor(
  hooks: Hooks,
  agent: AgentInputForTest,
  providerID = "anthropic",
  sessionID = "ses_test",
  modelHeaders: Record<string, string> = {},
): Promise<Record<string, string>> {
  const pluginHeaders = await pluginHeadersFor(hooks, agent, providerID, sessionID)
  return { ...openCodeBaseHeaders(sessionID), ...modelHeaders, ...pluginHeaders }
}

/** Resolve a header bag through a real Hono request, the way the proxy does. */
async function sessionKeyFor(headers: Record<string, string>): Promise<string | undefined> {
  let sessionKey: string | undefined
  const app = new Hono()
  app.get("/", (context) => {
    sessionKey = openCodeAdapter.getSessionId(context)
    return context.body(null)
  })
  await app.request("http://localhost/", { headers: new Headers(headers) })
  return sessionKey
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

  it("composes native, model, and plugin headers in final wire order", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "explore", "anthropic", "ses_test", {
      "x-opencode-session": "model-spoof",
      "x-opencode-request": "model-spoof",
      "x-model-header": "present",
    })
    expect(h["x-session-affinity"]).toBe("ses_test")
    expect(h["X-Session-Id"]).toBe("ses_test")
    expect(h["User-Agent"]).toStartWith("opencode/1.18.11 ")
    expect(h["x-model-header"]).toBe("present")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-opencode-request"]).toBe("msg_test")
    expect(h["x-opencode-agent-name"]).toBe("explore")
    expect(h["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("keeps plugin output empty for other providers while retaining native headers", async () => {
    const hooks = await instance()
    expect(await pluginHeadersFor(hooks, "title", "openrouter")).toEqual({})

    const h = await headersFor(hooks, "title", "openrouter")
    expect(h["x-session-affinity"]).toBe("ses_test")
    expect(h["X-Session-Id"]).toBe("ses_test")
    expect(h["User-Agent"]).toStartWith("opencode/1.18.11 ")
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

  /**
   * The proposition PR #845 believed it had proved, stated as a test.
   *
   * It stopped the plugin setting `x-opencode-session` for title/summary,
   * expecting that to detach those one-shots from the user's conversation. It
   * does not: OpenCode's own `x-session-affinity` survives, and
   * `openCodeAdapter.getSessionId` reads `x-opencode-session ?? x-session-affinity`.
   * With the old harness returning only `output.headers`, it could not see
   * this, so the change shipped green CI on a no-op.
   *
   * These assert on the key Meridian DERIVES, not on any single header, so they
   * stay true through any future reshuffle of which header carries the id.
   */
  describe("session identity as the proxy resolves it", () => {
    it("retains a session key when x-opencode-session is absent", async () => {
      const hooks = await instance()
      const headers = await headersFor(hooks, "build")
      delete headers["x-opencode-session"]
      expect(await sessionKeyFor(headers)).toBe("ses_test")
    })

    it("uses native affinity as the base for agent scoping", async () => {
      const hooks = await instance()
      const title = await headersFor(hooks, "title")
      const build = await headersFor(hooks, "build")
      delete title["x-opencode-session"]
      delete build["x-opencode-session"]

      expect(title["x-session-affinity"]).toBe(build["x-session-affinity"])
      expect(await sessionKeyFor(title)).toBe("ses_test#title")
      expect(await sessionKeyFor(build)).toBe("ses_test")
    })

    it("resolves the user's turn and each internal one-shot to exact distinct keys", async () => {
      const hooks = await instance()
      const keys: Record<string, string | undefined> = {}
      for (const agent of ["build", "title", "summary", "compaction"]) {
        keys[agent] = await sessionKeyFor(await headersFor(hooks, agent))
      }
      expect(keys).toEqual({
        build: "ses_test",
        title: "ses_test#title",
        summary: "ses_test#summary",
        compaction: "ses_test#compaction",
      })
    })
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
