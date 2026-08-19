/**
 * Tests for the opencode **v2** plugin (plugin/meridian-v2.ts).
 *
 * The property under test is the one a v2 client gets wrong on its own: the
 * core stamps session affinity on every model request, including the
 * title/summary one-shots that run in parallel with the user's turn. The
 * plugin must take that affinity off those two and declare them as parallel
 * streams instead, while leaving every other agent's session intact.
 */

import { describe, expect, test } from "bun:test"
import MeridianV2Plugin from "../../plugin/meridian-v2"

/** Headers as v2's SessionModelHeaders.make writes them, verbatim. */
function coreHeaders(sessionID: string, parentID?: string): Record<string, string> {
  return {
    "x-session-affinity": sessionID,
    "X-Session-Id": sessionID,
    ...(parentID ? { "x-parent-session-id": parentID } : {}),
    "User-Agent": "opencode/2",
    "x-opencode-project": "prj_1",
    "x-opencode-session": sessionID,
    "x-opencode-client": "opencode",
  }
}

type Hook = (input: {
  sessionID: string
  agent: string
  model: { providerID?: string }
  headers: Record<string, string>
}) => Promise<void> | void

/** Runs the plugin's setup and returns the registered model.request hook. */
function install(agentModes: Record<string, string> = {}): Hook {
  let registered: Hook | undefined
  const context = {
    agent: {
      get: async ({ agentID }: { agentID: string }) => {
        const mode = agentModes[agentID]
        return mode ? { data: { mode } } : undefined
      },
    },
    session: {
      hook: (name: string, callback: Hook) => {
        if (name === "model.request") registered = callback
        return Promise.resolve({ dispose: async () => {} })
      },
    },
  }
  MeridianV2Plugin.setup(context)
  if (!registered) throw new Error("the plugin did not register a model.request hook")
  return registered
}

async function run(
  agent: string,
  options: { providerID?: string; parentID?: string; modes?: Record<string, string> } = {},
) {
  const headers = coreHeaders("ses_abc", options.parentID)
  await install(options.modes)({
    sessionID: "ses_abc",
    agent,
    model: { providerID: options.providerID ?? "anthropic" },
    headers,
  })
  return headers
}

describe("plugin/meridian-v2.ts parent-session one-shots", () => {
  for (const agent of ["title", "summary"]) {
    test(`${agent} goes out detached from the session`, async () => {
      const headers = await run(agent, { parentID: "ses_parent" })

      expect(headers["x-opencode-session"]).toBeUndefined()
      expect(headers["x-session-affinity"]).toBeUndefined()
      expect(headers["X-Session-Id"]).toBeUndefined()
      expect(headers["x-parent-session-id"]).toBeUndefined()
      expect(headers["x-meridian-source"]).toBe(`subagent-${agent}`)
      // Everything the request needs that is not session affinity survives.
      expect(headers["x-opencode-project"]).toBe("prj_1")
    })
  }

  for (const agent of ["build", "compaction", "general", "explore"]) {
    test(`${agent} keeps the session header`, async () => {
      const headers = await run(agent, { parentID: "ses_parent" })

      expect(headers["x-opencode-session"]).toBe("ses_abc")
      expect(headers["x-session-affinity"]).toBe("ses_abc")
      expect(headers["X-Session-Id"]).toBe("ses_abc")
      expect(headers["x-parent-session-id"]).toBe("ses_parent")
      expect(headers["x-meridian-source"]).toBeUndefined()
    })
  }

  test("an agent padded like a one-shot keeps the session header", async () => {
    const headers = await run(" title ")

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBeUndefined()
  })

  test("an agent containing a zero-width character keeps the session header", async () => {
    const headers = await run("ti\u200btle")

    expect(headers["x-opencode-session"]).toBe("ses_abc")
  })
})

describe("plugin/meridian-v2.ts agent mode", () => {
  test("a built-in subagent is not promoted to the primary tier", async () => {
    const headers = await run("explore")

    expect(headers["x-opencode-agent-name"]).toBe("explore")
    expect(headers["x-opencode-agent-mode"]).toBe("subagent")
  })

  test("a configured agent takes its mode from the runtime, not the table", async () => {
    const headers = await run("réviewer", { modes: { "réviewer": "subagent" } })

    expect(headers["x-opencode-agent-mode"]).toBe("subagent")
  })

  test("a non-ASCII agent name is sanitized only for the header", async () => {
    const headers = await run("réviewer")

    expect(headers["x-opencode-agent-name"]).toBe("rviewer")
  })

  test("an unknown agent falls back to primary", async () => {
    const headers = await run("something-custom")

    expect(headers["x-opencode-agent-mode"]).toBe("primary")
  })

  test('"all" agents are treated as primary, as the proxy-side plugin does', async () => {
    const headers = await run("switcher", { modes: { switcher: "all" } })

    expect(headers["x-opencode-agent-mode"]).toBe("primary")
  })
})

describe("plugin/meridian-v2.ts scope", () => {
  test("a request to another provider is left untouched", async () => {
    const headers = await run("title", { providerID: "openai" })

    expect(headers["x-opencode-session"]).toBe("ses_abc")
    expect(headers["x-meridian-source"]).toBeUndefined()
    expect(headers["x-opencode-agent-mode"]).toBeUndefined()
  })
})
