/**
 * Unit tests for the OpenCode V2 plugin's request identity boundary.
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import MeridianV2Plugin, {
  applyMeridianV2Headers,
  fallbackAgentTraits,
  findLatestV2HumanMessageId,
  isRootV2Session,
  shouldDetachFromParentSession,
  type AgentTraits,
} from "../../plugin/meridian-v2"
import { PRIORITY_ATTESTATION_HEADER } from "../../plugin/priority-attestation"
import { verifyPriorityAttestation } from "../proxy/priorityAttestation"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function coreHeaders(sessionID: string, parentID = "ses_parent"): Record<string, string> {
  return {
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    "x-parent-session-id": parentID,
    "User-Agent": "opencode/2",
    "x-opencode-project": "prj_1",
    "x-opencode-session": sessionID,
    "x-opencode-client": "opencode",
  }
}

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

function rewrite(
  agent: string,
  traits: AgentTraits = fallbackAgentTraits(agent),
  headers: Record<string, string> = coreHeaders("ses_abc"),
): Record<string, string> {
  applyMeridianV2Headers(headers, { sessionID: "ses_abc", agent, traits })
  return headers
}

describe("plugin/meridian-v2.ts export", () => {
  test("uses the V2 object contract", () => {
    expect(MeridianV2Plugin.id).toBe("meridian")
    expect(typeof MeridianV2Plugin.setup).toBe("function")
  })
})

describe("plugin/meridian-v2.ts hidden parent-session one-shots", () => {
  for (const agent of ["title", "summary"]) {
    test(`${agent} is detached from the parent session`, async () => {
      const headers = rewrite(agent)

      expect(headers["x-opencode-session"]).toBeUndefined()
      expect(headers["x-session-affinity"]).toBeUndefined()
      expect(headers["X-Session-Id"]).toBeUndefined()
      expect(headers["x-parent-session-id"]).toBeUndefined()
      expect(headers["x-meridian-source"]).toBe(`subagent-${agent}`)
      expect(headers["x-opencode-agent-mode"]).toBe("subagent")
      expect(headers["x-opencode-project"]).toBe("prj_1")
      expect(await sessionKeyFor(headers)).toBeUndefined()
    })
  }

  test("the hidden title agent detaches even when V2 reports mode primary", () => {
    const headers = rewrite("title", { mode: "primary", hidden: true })

    expect(headers["x-opencode-session"]).toBeUndefined()
    expect(headers["x-meridian-source"]).toBe("subagent-title")
    expect(headers["x-opencode-agent-mode"]).toBe("subagent")
  })

  test("the built-in title job still detaches when configured visible", () => {
    const headers = rewrite("title", { mode: "primary", hidden: false })

    expect(headers["x-opencode-session"]).toBeUndefined()
    expect(headers["x-meridian-source"]).toBe("subagent-title")
  })

  test("a padded one-shot lookalike remains attached", () => {
    const headers = rewrite(" title ", { mode: "subagent", hidden: true })

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBeUndefined()
  })

  test("a zero-width one-shot lookalike remains attached", () => {
    const headers = rewrite("ti​tle", { mode: "subagent", hidden: true })

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBeUndefined()
  })

  test("compaction remains on the primary key but gets the subagent tier", async () => {
    const headers = rewrite("compaction", { mode: "primary", hidden: false })

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBe("subagent-compaction")
    expect(headers["x-opencode-agent-mode"]).toBe("primary")
    expect(await sessionKeyFor(headers)).toBe("ses_abc")
  })

  test("exact beta built-ins fall back to their native primary traits", () => {
    for (const agent of ["title", "summary", "compaction"]) {
      expect(fallbackAgentTraits(agent)).toEqual({ mode: "primary", hidden: true })
    }
  })
})

describe("plugin/meridian-v2.ts primary and subagent identity", () => {
  for (const agent of ["build", "plan"]) {
    test(`${agent} keeps the primary session`, async () => {
      const headers = rewrite(agent)
      expect(headers["x-opencode-session"]).toBe("ses_abc")
      expect(headers["x-session-affinity"]).toBe("ses_abc")
      expect(headers["x-session-id"]).toBe("ses_abc")
      expect(headers["x-opencode-agent-mode"]).toBe("primary")
      expect(await sessionKeyFor(headers)).toBe("ses_abc")
    })
  }

  for (const agent of ["general", "explore", "code-reviewer"]) {
    test(`${agent} keeps its own session as a subagent`, async () => {
      const traits = agent === "code-reviewer"
        ? { mode: "subagent" as const, hidden: false }
        : fallbackAgentTraits(agent)
      const headers = rewrite(agent, traits)

      expect(headers["x-opencode-session"]).toBe("ses_abc")
      expect(headers["x-opencode-agent-name"]).toBe(agent)
      expect(headers["x-opencode-agent-mode"]).toBe("subagent")
      expect(headers["x-meridian-source"]).toBeUndefined()
      expect(await sessionKeyFor(headers)).toBe(`ses_abc#${agent}`)
    })
  }

  test("a non-ASCII agent name is sanitized only at the header boundary", () => {
    const headers = rewrite("réviewer", { mode: "subagent", hidden: false })
    expect(headers["x-opencode-agent-name"]).toBe("rviewer")
    expect(headers["x-opencode-agent-mode"]).toBe("subagent")
  })

  test("unknown agents preserve V1's primary fallback", () => {
    expect(fallbackAgentTraits("something-custom")).toEqual({ mode: "primary", hidden: false })
  })
})

describe("plugin/meridian-v2.ts spoof resistance", () => {
  test("removes control headers case-insensitively before writing trusted values", () => {
    const headers = rewrite("build", fallbackAgentTraits("build"), {
      "X-OpenCode-Session": "spoofed",
      "X-SESSION-AFFINITY": "spoofed",
      "x-SESSION-id": "spoofed",
      "X-Parent-Session-ID": "spoofed-parent",
      "X-Meridian-Source": "subagent-spoofed",
      "X-OpenCode-Agent-Name": "spoofed",
      "X-OpenCode-Agent-Mode": "subagent",
    })

    expect(headers).toEqual({
      "x-opencode-session": "ses_abc",
      "x-session-affinity": "ses_abc",
      "x-session-id": "ses_abc",
      "x-opencode-agent-name": "build",
      "x-opencode-agent-mode": "primary",
    })
  })

  test("the final HTTP Headers boundary enforces the same identity", () => {
    const headers = new Headers({
      "X-OpenCode-Session": "spoofed",
      "X-Meridian-Source": "fork-spoofed",
      "X-OpenCode-Agent-Mode": "subagent",
    })

    applyMeridianV2Headers(headers, {
      sessionID: "ses_final",
      agent: "build",
      traits: fallbackAgentTraits("build"),
    })

    expect(headers.get("x-opencode-session")).toBe("ses_final")
    expect(headers.get("x-session-affinity")).toBe("ses_final")
    expect(headers.get("x-session-id")).toBe("ses_final")
    expect(headers.get("x-meridian-source")).toBeNull()
    expect(headers.get("x-opencode-agent-mode")).toBe("primary")
  })
})

describe("plugin/meridian-v2.ts classification", () => {
  test("only hidden subagent title and summary requests detach", () => {
    expect(shouldDetachFromParentSession("title", { mode: "subagent", hidden: true })).toBe(true)
    expect(shouldDetachFromParentSession("summary", { mode: "subagent", hidden: true })).toBe(true)
    expect(shouldDetachFromParentSession("title", { mode: "primary", hidden: true })).toBe(true)
    expect(shouldDetachFromParentSession("title", { mode: "subagent", hidden: false })).toBe(true)
    expect(shouldDetachFromParentSession("compaction", { mode: "subagent", hidden: true })).toBe(false)
  })
})


type ModelHookInput = {
  sessionID: string
  agent: string
  model: { providerID: string }
  headers: Record<string, string>
}

type HttpHookInput = {
  sessionID: string
  agent: string
  model: { providerID: string }
  request: Request
}

type HookInput = ModelHookInput | HttpHookInput
type HookCallback = (input: HookInput) => Promise<void>
type HookOptions = { providerID?: string }

type LookupTraits = { mode: "primary" | "subagent" | "all"; hidden: boolean }

async function installHooks(options: {
  traits?: Record<string, LookupTraits>
  lookup?: (agentID: string, call: number) => LookupTraits | Promise<LookupTraits>
  sessionInfo?: Record<string, unknown>
  contextMessages?: unknown[]
  failHttpRegistration?: boolean
  disposed?: string[]
} = {}) {
  let modelHook: HookCallback | undefined
  let httpHook: HookCallback | undefined
  const disposed = options.disposed ?? []
  const lookups: string[] = []
  const sessionLookups: string[] = []
  const contextLookups: string[] = []
  const registrations: Array<{ name: string; providerID: string | undefined }> = []

  const context = {
    agent: {
      get: async ({ agentID }: { agentID: string }) => {
        lookups.push(agentID)
        const traits = options.lookup
          ? await options.lookup(agentID, lookups.length)
          : options.traits?.[agentID] ?? fallbackAgentTraits(agentID)
        return { data: traits }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionLookups.push(sessionID)
        return options.sessionInfo ?? { id: sessionID }
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        contextLookups.push(sessionID)
        return options.contextMessages ?? []
      },
      hook: async (name: string, callback: HookCallback, hookOptions?: HookOptions) => {
        registrations.push({ name, providerID: hookOptions?.providerID })
        if (hookOptions?.providerID === "anthropic" && name === "model.request") modelHook = callback
        if (hookOptions?.providerID === "anthropic" && name === "http.request") {
          if (options.failHttpRegistration) throw new Error("http hook unavailable")
          httpHook = callback
        }
        const registration = `${hookOptions?.providerID ?? "unscoped"}:${name}`
        return { dispose: async () => { disposed.push(registration) } }
      },
    },
  }

  const cleanup = await Reflect.apply(MeridianV2Plugin.setup, MeridianV2Plugin, [context])
  return {
    model: () => {
      if (!modelHook) throw new Error("model.request hook was not registered")
      return modelHook
    },
    http: () => {
      if (!httpHook) throw new Error("http.request hook was not registered")
      return httpHook
    },
    cleanup: () => {
      if (typeof cleanup !== "function") throw new Error("plugin setup did not return cleanup")
      return cleanup()
    },
    disposed,
    lookups,
    sessionLookups,
    contextLookups,
    registrations,
  }
}

describe("plugin/meridian-v2.ts V2 hook registration", () => {
  test("enforces trusted identity in both model and final HTTP hooks", async () => {
    const hooks = await installHooks({
      traits: { title: { mode: "primary", hidden: true } },
    })
    const modelInput: ModelHookInput = {
      sessionID: "ses_real",
      agent: "title",
      model: { providerID: "anthropic" },
      headers: coreHeaders("ses_spoofed"),
    }

    await hooks.model()(modelInput)
    expect(modelInput.headers["x-opencode-session"]).toBeUndefined()
    expect(modelInput.headers["x-meridian-source"]).toBe("subagent-title")

    const request = new Request("http://127.0.0.1/v1/messages", {
      headers: {
        "X-OpenCode-Session": "spoofed-after-model-hook",
        "X-Meridian-Source": "spoofed-source",
      },
    })
    await hooks.http()({
      sessionID: "ses_real",
      agent: "title",
      model: { providerID: "anthropic" },
      request,
    })

    expect(request.headers.get("x-opencode-session")).toBeNull()
    expect(request.headers.get("x-meridian-source")).toBe("subagent-title")
    expect(hooks.lookups).toEqual(["title", "title"])

    await hooks.cleanup()
    expect(hooks.disposed.sort()).toEqual([
      "anthropic:http.request",
      "anthropic:model.request",
      "meridian:http.request",
      "meridian:model.request",
    ])
  })

  test("scopes every hook registration to a Meridian provider", async () => {
    const hooks = await installHooks()
    expect(hooks.registrations).toEqual([
      { name: "model.request", providerID: "anthropic" },
      { name: "http.request", providerID: "anthropic" },
      { name: "model.request", providerID: "meridian" },
      { name: "http.request", providerID: "meridian" },
    ])
    expect(hooks.registrations.every(registration => registration.providerID !== undefined)).toBe(true)
    await hooks.cleanup()
  })

  test("retries a transient trait lookup at the final request boundary", async () => {
    const hooks = await installHooks({
      lookup: (_agentID, call) => {
        if (call === 1) throw new Error("transient lookup failure")
        return { mode: "subagent", hidden: false }
      },
    })
    const modelInput: ModelHookInput = {
      sessionID: "ses_child",
      agent: "custom-reviewer",
      model: { providerID: "anthropic" },
      headers: {},
    }

    await hooks.model()(modelInput)
    expect(modelInput.headers["x-opencode-agent-mode"]).toBe("primary")

    const request = new Request("http://127.0.0.1/v1/messages")
    await hooks.http()({
      sessionID: "ses_child",
      agent: "custom-reviewer",
      model: { providerID: "anthropic" },
      request,
    })
    expect(request.headers.get("x-opencode-agent-mode")).toBe("subagent")
    expect(hooks.lookups).toEqual(["custom-reviewer", "custom-reviewer"])
    await hooks.cleanup()
  })

  test("does not rewrite requests for unrelated providers", async () => {
    const hooks = await installHooks()
    const input: ModelHookInput = {
      sessionID: "ses_real",
      agent: "title",
      model: { providerID: "openai" },
      headers: coreHeaders("ses_original"),
    }

    await hooks.model()(input)
    expect(input.headers["x-opencode-session"]).toBe("ses_original")
    expect(input.headers["x-meridian-source"]).toBeUndefined()
    expect(hooks.lookups).toEqual([])
    await hooks.cleanup()
  })

  test("disposes an earlier hook if later registration fails", async () => {
    const disposed: string[] = []
    const installed = installHooks({ failHttpRegistration: true, disposed })
    await expect(installed).rejects.toThrow("http hook unavailable")
    expect(disposed).toEqual(["anthropic:model.request"])
  })
})


describe("plugin/meridian-v2.ts trusted routing attestation", () => {
  const key = Buffer.alloc(32, 13)

  test("classifies only the latest genuine human context initiator", () => {
    expect(findLatestV2HumanMessageId([
      { id: "msg_human", type: "user", time: { created: Date.now() } },
      { id: "msg_assistant", type: "assistant" },
    ])).toBe("msg_human")
    for (const type of ["synthetic", "compaction", "skill", "shell", "system", "unknown"]) {
      expect(findLatestV2HumanMessageId([
        { id: "msg_human", type: "user", time: { created: Date.now() } },
        { id: `msg_${type}`, type },
      ])).toBeUndefined()
    }
    expect(findLatestV2HumanMessageId(new Array(2_049).fill({ id: "msg_human", type: "user", time: { created: Date.now() } })))
      .toBeUndefined()
  })

  test("recognizes only a root non-fork session", () => {
    expect(isRootV2Session({ id: "ses_root" }, "ses_root")).toBe(true)
    expect(isRootV2Session({ id: "ses_root", parentID: "ses_parent" }, "ses_root")).toBe(false)
    expect(isRootV2Session({ id: "ses_root", fork: { sessionID: "ses_parent" } }, "ses_root")).toBe(false)
    expect(isRootV2Session({ id: "ses_other" }, "ses_root")).toBe(false)
  })

  test("signs at final HTTP boundary, not the model boundary", async () => {
    const saved = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
    const createdAt = Date.now()
    const hooks = await installHooks({
      traits: { build: { mode: "primary", hidden: false } },
      sessionInfo: { id: "ses_real" },
      contextMessages: [
        { id: "msg_human", type: "user", time: { created: createdAt } },
        { id: "msg_assistant", type: "assistant" },
      ],
    })
    try {
      const modelInput: ModelHookInput = {
        sessionID: "ses_real",
        agent: "build",
        model: { providerID: "anthropic" },
        headers: { "X-Meridian-OpenCode-Turn": "spoofed" },
      }
      await hooks.model()(modelInput)
      expect(modelInput.headers["X-Meridian-OpenCode-Turn"]).toBeUndefined()
      expect(modelInput.headers[PRIORITY_ATTESTATION_HEADER]).toBeUndefined()

      const request = new Request("http://127.0.0.1/v1/messages", {
        headers: { "X-Meridian-OpenCode-Turn": "spoofed-after-model" },
      })
      await hooks.http()({
        sessionID: "ses_real",
        agent: "build",
        model: { providerID: "anthropic" },
        request,
      })
      const attestation = verifyPriorityAttestation(
        request.headers.get(PRIORITY_ATTESTATION_HEADER) ?? undefined,
        key,
      )
      expect(attestation?.generation).toBe("oc2b18314")
      expect(attestation?.sessionId).toBe("ses_real")
      expect(attestation?.agentId).toBe("build")
      expect(attestation?.issuedAt).toBe(Math.floor(createdAt / 1000))
      expect(hooks.sessionLookups).toEqual(["ses_real"])
      expect(hooks.contextLookups).toEqual(["ses_real"])
    } finally {
      await hooks.cleanup()
      if (saved === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = saved
    }
  })


  test("re-reads visibility at the final boundary and withholds stale authorization", async () => {
    const saved = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
    const hooks = await installHooks({
      lookup: (_agentID, call) => ({ mode: "primary", hidden: call >= 2 }),
      sessionInfo: { id: "ses_real" },
      contextMessages: [{ id: "msg_human", type: "user", time: { created: Date.now() } }],
    })
    try {
      await hooks.model()({
        sessionID: "ses_real",
        agent: "build",
        model: { providerID: "anthropic" },
        headers: {},
      })
      const request = new Request("http://127.0.0.1/v1/messages")
      await hooks.http()({
        sessionID: "ses_real",
        agent: "build",
        model: { providerID: "anthropic" },
        request,
      })
      expect(hooks.lookups).toEqual(["build", "build"])
      expect(request.headers.get(PRIORITY_ATTESTATION_HEADER)).toBeNull()
      expect(hooks.sessionLookups).toEqual([])
      expect(hooks.contextLookups).toEqual([])
    } finally {
      await hooks.cleanup()
      if (saved === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = saved
    }
  })

  test("scrubs but does not sign excluded hidden, internal, fork, synthetic, all, or pinned turns", async () => {
    const saved = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = key.toString("base64url")
    const cases: Array<{
      agent: string
      traits: LookupTraits
      sessionInfo?: Record<string, unknown>
      messages?: unknown[]
      pinned?: boolean
    }> = [
      { agent: "title", traits: { mode: "primary", hidden: false } },
      { agent: "summary", traits: { mode: "primary", hidden: false } },
      { agent: "compaction", traits: { mode: "primary", hidden: false } },
      { agent: "build", traits: { mode: "primary", hidden: true } },
      { agent: "build", traits: { mode: "all", hidden: false } },
      { agent: "build", traits: { mode: "subagent", hidden: false } },
      { agent: "build", traits: { mode: "primary", hidden: false }, sessionInfo: { id: "ses_real", parentID: "ses_parent" } },
      { agent: "build", traits: { mode: "primary", hidden: false }, sessionInfo: { id: "ses_real", fork: { sessionID: "ses_parent" } } },
      { agent: "build", traits: { mode: "primary", hidden: false }, messages: [{ id: "msg_synthetic", type: "synthetic" }] },
      { agent: "build", traits: { mode: "primary", hidden: false }, pinned: true },
    ]
    try {
      for (const item of cases) {
        const hooks = await installHooks({
          traits: { [item.agent]: item.traits },
          sessionInfo: item.sessionInfo ?? { id: "ses_real" },
          contextMessages: item.messages ?? [{ id: "msg_human", type: "user", time: { created: Date.now() } }],
        })
        const request = new Request("http://127.0.0.1/v1/messages", {
          headers: {
            "X-Meridian-OpenCode-Turn": "spoofed",
            ...(item.pinned ? { "X-Meridian-Profile": "work" } : {}),
          },
        })
        await hooks.http()({
          sessionID: "ses_real",
          agent: item.agent,
          model: { providerID: "anthropic" },
          request,
        })
        expect(request.headers.get(PRIORITY_ATTESTATION_HEADER)).toBeNull()
        await hooks.cleanup()
      }
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
      else process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = saved
    }
  })
})
