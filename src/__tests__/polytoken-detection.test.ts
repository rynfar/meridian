/**
 * Polytoken detection precedence — direct unit tests over detectAdapter.
 *
 * Order (plan contract):
 *   1. valid explicit built-in override (x-meridian-agent)
 *   2. valid explicit named instance
 *   3. valid native header (X-Polytoken-Session)
 *   4. automatic instance matches
 *   5. existing heuristics/default (unchanged)
 *
 * The native header outranks OpenCode/affinity/UA signals but never shadows an
 * explicit override. UA-only Polytoken requests (Polytoken vX / Polytoken/vX)
 * select polytoken before the generic affinity fallback but do not
 * manufacture identity. Impostor prefixes ("PolytokenImpostor") must not match.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { polytokenAdapter } from "../proxy/adapters/polytoken"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { droidAdapter } from "../proxy/adapters/droid"
import { crushAdapter } from "../proxy/adapters/crush"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"

function makeContext(userAgent: string, extraHeaders?: Record<string, string>): any {
  const allHeaders: Record<string, string> = {}
  if (userAgent) allHeaders["user-agent"] = userAgent
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) allHeaders[k.toLowerCase()] = v
  }
  return {
    req: {
      header: (name?: string) => {
        if (!name) return { ...allHeaders }
        return allHeaders[name.toLowerCase()]
      },
    },
  }
}

const savedInstances = process.env.MERIDIAN_ADAPTER_INSTANCES
const savedDefaultAgent = process.env.MERIDIAN_DEFAULT_AGENT

afterEach(() => {
  if (savedInstances === undefined) delete process.env.MERIDIAN_ADAPTER_INSTANCES
  else process.env.MERIDIAN_ADAPTER_INSTANCES = savedInstances
  if (savedDefaultAgent === undefined) delete process.env.MERIDIAN_DEFAULT_AGENT
  else process.env.MERIDIAN_DEFAULT_AGENT = savedDefaultAgent
})

describe("polytoken detection — native header", () => {
  it("detects polytoken from a valid native header with any UA", () => {
    for (const ua of ["", "curl/8.0", "opencode/1.18", "claude-cli/2.0.0", "Charm-Crush/v0.87.0", "Polytoken v0.8.3"]) {
      const a = detectAdapter(makeContext(ua, { "x-polytoken-session": "sess-1" }))
      expect(a).toBe(polytokenAdapter)
    }
  })

  it("native header beats OpenCode/affinity/UA signals", () => {
    expect(detectAdapter(makeContext("opencode/1.18.0", {
      "x-polytoken-session": "p-1",
      "x-opencode-session": "oc-1",
    }))).toBe(polytokenAdapter)
    expect(detectAdapter(makeContext("curl/8", {
      "x-polytoken-session": "p-1",
      "x-session-affinity": "aff-1",
      "x-opencode-session": "oc-1",
    }))).toBe(polytokenAdapter)
  })

  it("whitespace-only header is not a match", () => {
    expect(detectAdapter(makeContext("curl/8", { "x-polytoken-session": "   " }))).toBe(openCodeAdapter)
    expect(detectAdapter(makeContext("curl/8", { "x-polytoken-session": "" }))).toBe(openCodeAdapter)
  })

  it("conflicting weak signals do not beat polytoken; stronger existing heuristics win when no valid header exists", () => {
    // No valid native header → the existing chain runs unchanged.
    expect(detectAdapter(makeContext("factory-cli/1.0", { "x-polytoken-session": "  " }))).toBe(droidAdapter)
    expect(detectAdapter(makeContext("Charm-Crush/v0.9", { "x-polytoken-session": "" }))).toBe(crushAdapter)
    expect(detectAdapter(makeContext("claude-cli/2.0", { "x-polytoken-session": " " }))).toBe(claudeCodeAdapter)
  })
})

describe("polytoken detection — precedence", () => {
  it("explicit built-in override outranks the native header", () => {
    expect(detectAdapter(makeContext("Polytoken v0.8.3", {
      "x-polytoken-session": "p-1",
      "x-meridian-agent": "opencode",
    }))).toBe(openCodeAdapter)
    expect(detectAdapter(makeContext("", {
      "x-polytoken-session": "p-1",
      "x-meridian-agent": "droid",
    }))).toBe(droidAdapter)
  })

  it("explicit instance selection outranks the native header", () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "pt-a": { base: "opencode" },
      "pt-b": { base: "polytoken" },
    })
    const a = detectAdapter(makeContext("Polytoken/0.8.3", {
      "x-polytoken-session": "p-1",
      "x-meridian-agent": "pt-a",
    }))
    expect(a.name).toBe("pt-a")
    expect(a.baseName).toBe("opencode")
  })

  it("valid native header outranks automatic instance matches", () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "team-ui": { base: "opencode", match: { userAgentPrefix: "Polytoken" } },
    })
    const a = detectAdapter(makeContext("Polytoken v0.8.3", { "x-polytoken-session": "p-1" }))
    expect(a).toBe(polytokenAdapter)
  })

  it("automatic instance match applies when no valid native header is present", () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "team-ui": { base: "polytoken", match: { userAgentPrefix: "Polytoken" } },
    })
    const a = detectAdapter(makeContext("Polytoken v0.8.3"))
    expect(a.name).toBe("team-ui")
    expect(a.baseName).toBe("polytoken")
  })

  it("invalid explicit override falls through (native header then still applies)", () => {
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      broken: { base: "no-such-adapter" },
    })
    expect(detectAdapter(makeContext("", {
      "x-meridian-agent": "broken",
      "x-polytoken-session": "p-1",
    }))).toBe(polytokenAdapter)
  })

  it("MERIDIAN_DEFAULT_AGENT=polytoken is accepted as the default agent", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "polytoken"
    // Unidentifiable UA + no session header → env default picks polytoken.
    expect(detectAdapter(makeContext("curl/8")).name).toBe("polytoken")
    // But an unambiguous other client still wins.
    expect(detectAdapter(makeContext("factory-cli/1.0"))).toBe(droidAdapter)
  })
})

describe("polytoken detection — User-Agent boundaries", () => {
  it("matches 'Polytoken <version>' UA without a session header", () => {
    expect(detectAdapter(makeContext("Polytoken v0.8.3"))).toBe(polytokenAdapter)
    expect(detectAdapter(makeContext("Polytoken v1.0.0 (linux)"))).toBe(polytokenAdapter)
  })

  it("matches 'Polytoken/<version>' UA without a session header", () => {
    expect(detectAdapter(makeContext("Polytoken/0.8.3"))).toBe(polytokenAdapter)
    expect(detectAdapter(makeContext("Polytoken/2.0"))).toBe(polytokenAdapter)
  })

  it("does NOT match impostor prefixes", () => {
    expect(detectAdapter(makeContext("PolytokenImpostor/1.0"))).toBe(openCodeAdapter)
    expect(detectAdapter(makeContext("notpolytoken/1.0"))).toBe(openCodeAdapter)
  })

  it("does not match polytoken mid-string in an unrelated UA", () => {
    expect(detectAdapter(makeContext("my-app Polytoken/1.0"))).toBe(openCodeAdapter)
  })

  it("UA-only selection does not manufacture identity", () => {
    const a = detectAdapter(makeContext("Polytoken v0.8.3"))
    expect(a).toBe(polytokenAdapter)
    const c = makeContext("Polytoken v0.8.3")
    expect(a.getSessionId(c)).toBeUndefined()
  })

  it("Polytoken UA beats the generic affinity fallback (no identity adoption)", () => {
    // x-session-affinity is OpenCode-family's fallback signal. A Polytoken UA
    // carrying it (a shared gateway stamping affinity blindly) must select
    // polytoken — not OpenCode with an unrelated affinity key as identity.
    const a = detectAdapter(makeContext("Polytoken v0.8.3", { "x-session-affinity": "aff-77" }))
    expect(a).toBe(polytokenAdapter)
    expect(a.getSessionId(makeContext("Polytoken v0.8.3", { "x-session-affinity": "aff-77" }))).toBeUndefined()
  })

  it("native header still beats affinity; affinity alone still selects OpenCode", () => {
    expect(detectAdapter(makeContext("Polytoken v0.8.3", {
      "x-session-affinity": "aff-1",
      "x-polytoken-session": "p-1",
    }))).toBe(polytokenAdapter)
    expect(detectAdapter(makeContext("some-unknown-client/9", { "x-session-affinity": "ses_abc" }))).toBe(openCodeAdapter)
  })

  it("registers polytoken for explicit selection and default-agent resolution", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "polytoken" }))).toBe(polytokenAdapter)
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "POLYTOKEN" }))).toBe(polytokenAdapter)
  })
})