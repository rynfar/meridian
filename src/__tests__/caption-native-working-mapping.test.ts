import { describe, expect, test } from "bun:test"
import { Context } from "hono"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"
import { selectWorkingMapping } from "../../scripts/e2e-claude-code-progress-captions/working-mapping"

function workingIdentity(session: string, agent?: string) {
  const headers = new Headers()
  if (agent !== undefined) headers.set("x-claude-code-agent-id", agent)
  const context = new Context(new Request("http://observer.invalid/v1/messages", { headers }))
  const key = claudeCodeAdapter.getSessionId(context, { metadata: { user_id: JSON.stringify({ session_id: session }) } })
  if (key === undefined) throw new Error("Valid native identity was not derived")
  return key
}

describe("native caption working mapping observer", () => {
  test("observes an agent mutation while the root remains unchanged", () => {
    const session = "owned-session"
    const key = workingIdentity(session, "worker-1")
    expect(key).toBeDefined()
    expect(key).not.toBe(session)
    const root = { revision: 1 }
    const before = { [`task:${key}`]: { revision: 1 }, [`task:${session}`]: root }
    const after = { [`task:${key}`]: { revision: 2 }, [`task:${session}`]: root }
    expect(selectWorkingMapping(key, "task", before).mapping).not.toEqual(selectWorkingMapping(key, "task", after).mapping)
  })

  test("ignores root changes when the agent slot is preserved", () => {
    const session = "owned-session"
    const key = workingIdentity(session, "worker-1")
    const working = { revision: 7 }
    const before = { [`task:${key}`]: working, [`task:${session}`]: { revision: 1 } }
    const after = { [`task:${key}`]: working, [`task:${session}`]: { revision: 2 } }
    expect(selectWorkingMapping(key, "task", before)).toEqual(selectWorkingMapping(key, "task", after))
  })

  test("refuses a root, old concatenated slot, sibling or other profile as evidence", () => {
    const session = "owned-session"
    const key = workingIdentity(session, "worker-1")
    const sibling = workingIdentity(session, "worker-2")
    const slots = {
      [session]: { revision: 1 },
      [`task:${session}`]: { revision: 2 },
      [`task:${session}:agent:worker-1`]: { revision: 3 },
      [`task:${sibling}`]: { revision: 4 },
      [`other:${key}`]: { revision: 5 },
      [`${key}`]: { revision: 6 },
    }
    expect(() => selectWorkingMapping(key, "task", slots)).toThrow("owned-working-mapping-missing")
  })

  test("keeps a reserved-prefix main identity separate from the native agent", () => {
    const session = "meridian-claude-code:1:reserved"
    const main = workingIdentity(session)
    const agent = workingIdentity(session, "worker")
    expect(main).not.toBe(session)
    expect(agent).not.toBe(main)
    const slots = { [`task:${main}`]: "main", [`task:${agent}`]: "agent", [`task:${session}`]: "raw" }
    expect(selectWorkingMapping(agent, "task", slots).mapping).toBe("agent")
    expect(selectWorkingMapping(main, "task", slots).mapping).toBe("main")
  })

  test("uses an exact raw slot for default and refuses a different profile", () => {
    const key = workingIdentity("main-session")
    const selected = selectWorkingMapping(key, "default", { "main-session": "owned", "other:main-session": "other" })
    expect(selected).toEqual({ adapterSessionId: key, key: "main-session", mapping: "owned" })
    expect(() => selectWorkingMapping(key, "default", { "other:main-session": "other" })).toThrow("owned-working-mapping-missing")
  })

  test("requires identity, profile and an own mapping entry", () => {
    expect(() => selectWorkingMapping(undefined, "task", {})).toThrow("working-adapter-session-missing")
    expect(() => selectWorkingMapping("session", "", {})).toThrow("working-profile-missing")
    expect(() => selectWorkingMapping("session", "task", { "task:session": null })).toThrow("owned-working-mapping-missing")
    const inherited = Object.create({ "task:session": "inherited" })
    expect(() => selectWorkingMapping("session", "task", inherited)).toThrow("owned-working-mapping-missing")
  })
})
