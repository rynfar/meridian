/**
 * OpenCode's internal agents (title, summary, compaction) run under the USER'S
 * OpenCode session id — the plugin faithfully forwards it as
 * `x-opencode-session`, and OpenCode itself sends the same value as
 * `x-session-affinity` even with no plugin installed.
 *
 * That made two unrelated conversations share one session key: "Generate a
 * title for this conversation: …" and the user's actual chat. Observed live
 * against OpenCode 1.18.11, three runs out of three:
 *
 *   seq 1  agent=title  tools=0  x-opencode-session: ses_fe4b…
 *   seq 2  agent=build  tools=10 x-opencode-session: ses_fe4b…   ← same key
 *
 * The title turn arrives first, takes the per-session turn lease, and commits
 * its own one-message lineage under the shared key. The user's real turn then
 * waits 5–12s behind that lease and, on being granted it, finds a stored
 * lineage from a different conversation — `unrelated-history`. Since #825 that
 * is answered with HTTP 400 `session_turn_conflict`, which OpenCode reports as
 * non-retryable; before #825 it fell through to a full-history replay against
 * a cold prompt cache.
 *
 * Scoping the key by agent gives every non-primary agent its own lineage and
 * its own lease, so neither outcome is reachable.
 */
import { describe, it, expect } from "bun:test"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function ctx(headers: Record<string, string | undefined>) {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as any
}

const SESSION = "ses_fe4bfa3daffexvfr3lL7db1lcU"

describe("openCodeAdapter.getSessionId — internal agent isolation", () => {
  it("keeps the primary agent's key equal to the raw session id", () => {
    expect(openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "primary",
      "x-opencode-agent-name": "build",
    }))).toBe(SESSION)
  })

  it("gives the title agent a key distinct from the user's conversation", () => {
    const primary = openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "primary",
      "x-opencode-agent-name": "build",
    }))
    const title = openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "title",
    }))
    expect(title).toBeDefined()
    expect(title).not.toBe(primary)
  })

  it("separates distinct non-primary agents from each other", () => {
    const title = openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "title",
    }))
    const summary = openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "summary",
    }))
    expect(title).not.toBe(summary)
  })

  it("is stable across turns of the same agent", () => {
    const headers = {
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "explore",
    }
    expect(openCodeAdapter.getSessionId(ctx(headers))).toBe(openCodeAdapter.getSessionId(ctx(headers)))
  })

  it("falls back to x-session-affinity and still scopes by agent", () => {
    expect(openCodeAdapter.getSessionId(ctx({
      "x-session-affinity": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "title",
    }))).not.toBe(SESSION)
  })

  it("leaves the key unscoped when no agent name is present (older plugins)", () => {
    expect(openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
    }))).toBe(SESSION)
  })

  it("returns undefined with no session header at all", () => {
    expect(openCodeAdapter.getSessionId(ctx({ "x-opencode-agent-name": "title" }))).toBeUndefined()
  })

  it("ignores an agent name that sanitizes to nothing", () => {
    expect(openCodeAdapter.getSessionId(ctx({
      "x-opencode-session": SESSION,
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "   ",
    }))).toBe(SESSION)
  })
})

/**
 * Plugin-less OpenCode is deliberately NOT handled here.
 *
 * Captured live from OpenCode 1.18.11 with no plugin configured, the title
 * one-shot and the user's turn are separated only by request shape:
 *   seq 1  tools=0  msgs=1  x-session-affinity: ses_fe4c…   ← title one-shot
 *   seq 2  tools=10 msgs=1  x-session-affinity: ses_fe4c…   ← the user's turn
 *
 * Scoping on that shape was implemented and reverted: "tool-less, one message"
 * is equally the FIRST TURN of an ordinary tool-less chat, and keying it apart
 * left turn 2 unable to resume it. It turned five suites red, including
 * session-lineage's "resumes when messages are a strict continuation".
 *
 * So the shape is left alone, and this test pins that: an unkeyed-agent request
 * keeps the raw session id, whatever it looks like. Plugin-less OpenCode stays
 * exposed to the collision, which is consistent with `meridian setup` being
 * required. Note where that guardrail stops short: /health always reports
 * `plugin: not-configured`, but the startup warning in bin/cli.ts is gated on
 * an OpenCode config FILE existing (so meridian stays quiet for the many
 * clients that are not OpenCode). Run the documented step 2 alone —
 * `ANTHROPIC_BASE_URL=… opencode`, no config file — and there is no warning at
 * all. Closing that would mean warning at request time, when an OpenCode
 * request arrives carrying no plugin headers; deliberately not done here.
 */
describe("openCodeAdapter.getSessionId — shape is never used to infer an agent", () => {
  const AFFINITY = "ses_fe4c090d9ffeymDAOxKAoBeqQ2"

  it("keeps the raw key for a tool-less single-message request", () => {
    expect(openCodeAdapter.getSessionId(ctx({ "x-session-affinity": AFFINITY }))).toBe(AFFINITY)
  })

  it("keeps the raw key for a tool-bearing request", () => {
    expect(openCodeAdapter.getSessionId(ctx({ "x-session-affinity": AFFINITY }))).toBe(AFFINITY)
  })
})
