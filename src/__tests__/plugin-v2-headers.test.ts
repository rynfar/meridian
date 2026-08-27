/**
 * Unit tests for the OpenCode V2 plugin's request identity boundary.
 */

import { describe, expect, test } from "bun:test"
import MeridianV2Plugin, {
  applyMeridianV2Headers,
  fallbackAgentTraits,
  shouldDetachFromParentSession,
  type AgentTraits,
} from "../../plugin/meridian-v2"
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
    test(`${agent} is detached from the parent session`, () => {
      const headers = rewrite(agent)

      expect(headers["x-opencode-session"]).toBeUndefined()
      expect(headers["x-session-affinity"]).toBeUndefined()
      expect(headers["X-Session-Id"]).toBeUndefined()
      expect(headers["x-parent-session-id"]).toBeUndefined()
      expect(headers["x-meridian-source"]).toBe(`subagent-${agent}`)
      expect(headers["x-opencode-agent-mode"]).toBe("subagent")
      expect(headers["x-opencode-project"]).toBe("prj_1")
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

  test("compaction remains on the primary key but gets the subagent tier", () => {
    const headers = rewrite("compaction", { mode: "primary", hidden: false })

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBe("subagent-compaction")
    expect(headers["x-opencode-agent-mode"]).toBe("primary")

    const sessionKey = Reflect.apply(openCodeAdapter.getSessionId, openCodeAdapter, [{
      req: { header: (name: string) => headers[name.toLowerCase()] },
    }])
    expect(sessionKey).toBe("ses_abc")
  })

  test("exact beta built-ins fall back to their native primary traits", () => {
    for (const agent of ["title", "summary", "compaction"]) {
      expect(fallbackAgentTraits(agent)).toEqual({ mode: "primary", hidden: true })
    }
  })
})

describe("plugin/meridian-v2.ts primary and subagent identity", () => {
  for (const agent of ["build", "plan"]) {
    test(`${agent} keeps the primary session`, () => {
      const headers = rewrite(agent)
      expect(headers["x-opencode-session"]).toBe("ses_abc")
      expect(headers["x-session-affinity"]).toBe("ses_abc")
      expect(headers["x-session-id"]).toBe("ses_abc")
      expect(headers["x-opencode-agent-mode"]).toBe("primary")
    })
  }

  for (const agent of ["general", "explore", "code-reviewer"]) {
    test(`${agent} keeps its own session as a subagent`, () => {
      const traits = agent === "code-reviewer"
        ? { mode: "subagent" as const, hidden: false }
        : fallbackAgentTraits(agent)
      const headers = rewrite(agent, traits)

      expect(headers["x-opencode-session"]).toBe("ses_abc")
      expect(headers["x-opencode-agent-name"]).toBe(agent)
      expect(headers["x-opencode-agent-mode"]).toBe("subagent")
      expect(headers["x-meridian-source"]).toBeUndefined()
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

async function installHooks(options: {
  traits?: Record<string, AgentTraits>
  lookup?: (agentID: string, call: number) => AgentTraits | Promise<AgentTraits>
  failHttpRegistration?: boolean
  disposed?: string[]
} = {}) {
  let modelHook: HookCallback | undefined
  let httpHook: HookCallback | undefined
  const disposed = options.disposed ?? []
  const lookups: string[] = []
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
    expect(hooks.lookups).toEqual(["title"])

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
