/**
 * Unit tests for adapter instances (#476) — pure functions, no mocks.
 *
 * An instance = base adapter + feature overrides + optional passthrough
 * override + optional match rules. Instances let users run several
 * configurations of the same adapter side by side (e.g. one passthrough
 * variant with thinking enabled, one without) selected via
 * `x-meridian-agent: <instance-name>` or header/User-Agent match rules.
 */
import { describe, it, expect } from "bun:test"
import {
  parseAdapterInstances,
  matchesInstance,
  type AdapterInstanceDef,
} from "../proxy/adapterInstances"

describe("parseAdapterInstances", () => {
  it("parses a valid instance map", () => {
    const parsed = parseAdapterInstances(JSON.stringify({
      "oc-thinky": { base: "opencode", features: { thinking: "enabled" } },
      "lite-plain": { base: "passthrough", passthrough: true, match: { userAgentPrefix: "litellm/" } },
    }))
    expect(Object.keys(parsed)).toEqual(["oc-thinky", "lite-plain"])
    expect(parsed["oc-thinky"]!.base).toBe("opencode")
    expect(parsed["oc-thinky"]!.features).toEqual({ thinking: "enabled" })
    expect(parsed["lite-plain"]!.passthrough).toBe(true)
  })

  it("returns {} for empty/missing/malformed input (never crashes detection)", () => {
    expect(parseAdapterInstances(undefined)).toEqual({})
    expect(parseAdapterInstances("")).toEqual({})
    expect(parseAdapterInstances("not json {")).toEqual({})
    expect(parseAdapterInstances("[1,2]")).toEqual({})
    expect(parseAdapterInstances("42")).toEqual({})
  })

  it("drops instances without a string base", () => {
    const parsed = parseAdapterInstances(JSON.stringify({
      good: { base: "opencode" },
      noBase: { features: {} },
      numBase: { base: 42 },
    }))
    expect(Object.keys(parsed)).toEqual(["good"])
  })

  it("drops instances with non-object features or match", () => {
    const parsed = parseAdapterInstances(JSON.stringify({
      badFeatures: { base: "opencode", features: "yes" },
      badMatch: { base: "opencode", match: [1] },
      ok: { base: "opencode", match: { userAgentPrefix: "x/" } },
    }))
    expect(Object.keys(parsed)).toEqual(["ok"])
  })
})

describe("matchesInstance", () => {
  const def = (match: AdapterInstanceDef["match"]): AdapterInstanceDef => ({ base: "opencode", match })
  const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()]

  it("matches on User-Agent prefix", () => {
    expect(matchesInstance(def({ userAgentPrefix: "litellm/" }), headers({ "user-agent": "litellm/1.2" }))).toBe(true)
    expect(matchesInstance(def({ userAgentPrefix: "litellm/" }), headers({ "user-agent": "opencode/1.0" }))).toBe(false)
  })

  it("matches on exact header values (all must match)", () => {
    const d = def({ header: { "x-client": "webui", "x-team": "alpha" } })
    expect(matchesInstance(d, headers({ "x-client": "webui", "x-team": "alpha" }))).toBe(true)
    expect(matchesInstance(d, headers({ "x-client": "webui" }))).toBe(false)
    expect(matchesInstance(d, headers({ "x-client": "other", "x-team": "alpha" }))).toBe(false)
  })

  it("requires both header and UA rules when both are present", () => {
    const d = def({ header: { "x-client": "webui" }, userAgentPrefix: "curl/" })
    expect(matchesInstance(d, headers({ "x-client": "webui", "user-agent": "curl/8" }))).toBe(true)
    expect(matchesInstance(d, headers({ "x-client": "webui", "user-agent": "wget/1" }))).toBe(false)
  })

  it("never matches without match rules (explicit-header selection only)", () => {
    expect(matchesInstance(def(undefined), headers({ "user-agent": "anything" }))).toBe(false)
    expect(matchesInstance(def({}), headers({ "user-agent": "anything" }))).toBe(false)
  })

  it("header names are case-insensitive", () => {
    const d = def({ header: { "X-Client": "webui" } })
    expect(matchesInstance(d, headers({ "x-client": "webui" }))).toBe(true)
  })
})
