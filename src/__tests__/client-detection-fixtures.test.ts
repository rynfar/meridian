/**
 * Adapter detection against REAL captured client headers.
 *
 * `adapter-detection.test.ts` covers detection with hand-written headers, which
 * proves the logic behaves as its author intended. It cannot catch the failure
 * that actually shipped: a CLIENT changing what it sends.
 *
 * Crush 0.87 added `x-session-affinity`, which detection checked ahead of the
 * User-Agent chain, so every Crush request silently resolved to the OpenCode
 * adapter — OpenCode's transforms, tool config and session semantics applied to
 * a client with its own (#733). Nothing failed. No user could connect
 * "sessions feel wrong" to header precedence.
 *
 * This file pins detection against header sets captured from real clients, so
 * a change to detection ordering fails here. The client side is covered by
 * `scripts/e2e-client-detection.mjs`, which re-captures from installed clients
 * and diffs against the same fixture.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { detectAdapter } from "../proxy/adapters/detect"

interface Capture {
  client: string
  version: string
  capturedAt: string
  expectedAdapter: string
  note?: string
  headers: Record<string, string>
}

const FIXTURE = join(import.meta.dir, "fixtures", "client-headers.json")
const captures: Capture[] = JSON.parse(readFileSync(FIXTURE, "utf8")).captures

function contextFor(headers: Record<string, string>): any {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    req: {
      header: (name?: string) => (name ? lower[name.toLowerCase()] : { ...lower }),
    },
  }
}

describe("adapter detection against captured client headers", () => {
  it("has fixtures to check", () => {
    // Guards the instrument: an empty or unreadable fixture would make every
    // test below pass vacuously.
    expect(captures.length).toBeGreaterThan(0)
    for (const c of captures) {
      expect(c.headers && Object.keys(c.headers).length).toBeGreaterThan(0)
      expect(c.expectedAdapter).toBeTruthy()
    }
  })

  for (const c of captures) {
    it(`routes ${c.client} ${c.version} to the ${c.expectedAdapter} adapter`, () => {
      const adapter = detectAdapter(contextFor(c.headers))
      expect(adapter.name).toBe(c.expectedAdapter)
    })
  }

  it("does not let a shared session header decide between two clients", () => {
    // The precise shape of #733, stated as a property rather than a single
    // case: opencode and crush both send x-session-affinity + x-session-id, so
    // any rule keying on those alone cannot tell them apart. Whatever
    // distinguishes them must be something else — today, the User-Agent.
    const shared = captures.filter(c =>
      c.headers["x-session-affinity"] && !c.headers["x-opencode-session"])
    const distinctAdapters = new Set(shared.map(c => c.expectedAdapter))

    expect(shared.length).toBeGreaterThanOrEqual(2)
    expect(distinctAdapters.size).toBeGreaterThanOrEqual(2)

    for (const c of shared) {
      expect(detectAdapter(contextFor(c.headers)).name).toBe(c.expectedAdapter)
    }
  })

  it("still routes correctly with the session headers stripped", () => {
    // Isolates the User-Agent's contribution: if detection silently came to
    // depend on a session header, this would break while the cases above pass.
    for (const c of captures) {
      if (c.headers["x-opencode-session"]) continue // that header IS the signal
      const { "x-session-affinity": _a, "x-session-id": _b, ...rest } = c.headers
      expect(detectAdapter(contextFor(rest)).name).toBe(c.expectedAdapter)
    }
  })
})
