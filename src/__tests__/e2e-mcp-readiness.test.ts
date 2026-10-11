import { describe, expect, test } from "bun:test"
import { createQueryMcpReadinessWitness } from "../../scripts/lib/e2eMcpReadiness.mjs"

const options = { mcpServers: { oc: { type: "sdk" } }, allowedTools: ["mcp__oc__Read", "mcp__oc__Bash"] }
const init = () => ({ type: "system", subtype: "init", session_id: "owned-session", mcp_servers: [{ name: "oc", status: "connected" }], tools: ["mcp__oc__Read", "mcp__oc__Bash"] })
const result = () => ({ type: "result", subtype: "success", is_error: false, session_id: "owned-session" })

describe("public per-query MCP readiness", () => {
  test("binds the complete declared catalog and connected server to the original final session", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe(init())
    expect(witness.summary().ready).toBe(false)
    witness.observe(result())
    const facts = witness.summary()
    expect(facts.ready).toBe(true)
    expect(facts.declaredToolCount).toBe(2)
    expect(facts.advertisedToolCount).toBe(2)
    expect(facts.advertisedToolDigest).toBe(facts.declaredToolDigest)
    expect(facts.statuses).toEqual([{ name: "oc", status: "connected" }])
  })

  for (const status of ["failed", "pending", "disabled", "needs-auth", "unknown-status"]) {
    test(`canonical success cannot conceal ${status} readiness`, () => {
      const witness = createQueryMcpReadinessWitness(options)
      witness.observe({ ...init(), mcp_servers: [{ name: "oc", status }] })
      witness.observe(result())
      expect(witness.summary().ready).toBe(false)
    })
  }

  test("canonical success cannot conceal the baseline's empty tool catalog", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), tools: [] })
    witness.observe(result())
    expect(witness.summary().missingTools).toBe(2)
    expect(witness.summary().ready).toBe(false)
  })

  test("another connected server cannot satisfy the declared server", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), mcp_servers: [{ name: "another", status: "connected" }] })
    witness.observe(result())
    expect(witness.summary().missingServers).toBe(1)
    expect(witness.summary().ready).toBe(false)
  })

  test("an extra server cannot disappear from the evidence", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), mcp_servers: [...init().mcp_servers, { name: "another", status: "failed" }] })
    witness.observe(result())
    expect(witness.summary().unconfiguredServers).toBe(1)
    expect(witness.summary().ready).toBe(false)
  })

  test("a duplicate name cannot mask a failed connection", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), mcp_servers: [{ name: "oc", status: "connected" }, { name: "oc", status: "failed" }] })
    witness.observe(result())
    expect(witness.summary().duplicateServers).toBe(true)
    expect(witness.summary().ready).toBe(false)
  })

  test("a later init cannot repair the original failed connection", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), mcp_servers: [{ name: "oc", status: "failed" }] })
    witness.observe(init())
    witness.observe(result())
    expect(witness.summary().statuses).toEqual([{ name: "oc", status: "failed" }])
    expect(witness.summary().ready).toBe(false)
  })

  test("no query can borrow a receipt from another final session", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe(init())
    witness.observe({ ...result(), session_id: "another-session" })
    expect(witness.summary().sessionMatched).toBe(false)
    expect(witness.summary().ready).toBe(false)
  })

  test("a second result cannot qualify a different invocation", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe(init())
    witness.observe(result())
    witness.observe(result())
    expect(witness.summary().ready).toBe(false)
  })

  test("missing init stays unproven", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe(result())
    expect(witness.summary().ready).toBe(false)
  })

  for (const event of [
    { ...init(), mcp_servers: undefined },
    { ...init(), mcp_servers: {} },
    { ...init(), mcp_servers: [{ name: "oc", status: undefined }] },
    { ...init(), tools: undefined },
    { ...init(), tools: [null] },
    { ...init(), session_id: undefined },
  ]) {
    test("malformed public init cannot qualify readiness", () => {
      const witness = createQueryMcpReadinessWitness(options)
      witness.observe(event)
      witness.observe(result())
      expect(witness.summary().ready).toBe(false)
    })
  }

  test("duplicate owned tools do not count as catalog continuity", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), tools: [...init().tools, "mcp__oc__Read"] })
    witness.observe(result())
    expect(witness.summary().duplicateTools).toBe(true)
    expect(witness.summary().ready).toBe(false)
  })

  test("unexpected owned tools remain a failure rather than a filtered success", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), tools: [...init().tools, "mcp__oc__Unknown"] })
    witness.observe(result())
    expect(witness.summary().unexpectedTools).toBe(1)
    expect(witness.summary().ready).toBe(false)
  })

  test("an explicitly tool-free classifier still needs its own init and final session", () => {
    const witness = createQueryMcpReadinessWitness({})
    witness.observe({ ...init(), mcp_servers: [], tools: ["SDKBuiltin"] })
    witness.observe(result())
    expect(witness.summary().declaredServers).toEqual([])
    expect(witness.summary().ready).toBe(true)
  })

  test("independent queries retain independent immutable expectations", () => {
    const declared = { mcpServers: { oc: {} }, allowedTools: ["mcp__oc__Read"] }
    const first = createQueryMcpReadinessWitness(declared)
    declared.allowedTools.push("mcp__oc__Bash")
    const second = createQueryMcpReadinessWitness(declared)
    first.observe({ ...init(), tools: ["mcp__oc__Read"] })
    first.observe(result())
    second.observe({ ...init(), tools: ["mcp__oc__Read"] })
    second.observe(result())
    expect(first.summary().ready).toBe(true)
    expect(second.summary().ready).toBe(false)
  })

  test("mutating a public summary cannot repair the original failed witness", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), mcp_servers: [{ name: "oc", status: "failed" }] })
    witness.observe(result())
    const exposed = witness.summary()
    exposed.declaredServers.length = 0
    exposed.statuses[0].status = "connected"
    expect(witness.summary().declaredServers).toEqual(["oc"])
    expect(witness.summary().statuses).toEqual([{ name: "oc", status: "failed" }])
    expect(witness.summary().ready).toBe(false)
  })

  test("only declared names, counts and digests leave memory", () => {
    const witness = createQueryMcpReadinessWitness(options)
    const privateText = "PRIVATE_PROVIDER_DIAGNOSTIC_DO_NOT_PERSIST"
    witness.observe({ ...init(), cwd: privateText, mcp_servers: [{ name: "oc", status: "connected", config: { secret: privateText } }, { name: privateText, status: privateText }], tools: [...init().tools, `mcp__oc__${privateText}`], session_id: privateText })
    witness.observe({ ...result(), session_id: privateText })
    expect(JSON.stringify(witness.summary())).not.toContain(privateText)
    expect(witness.summary().ready).toBe(false)
  })

  test("unbounded native init does not qualify", () => {
    const witness = createQueryMcpReadinessWitness(options)
    witness.observe({ ...init(), tools: Array.from({ length: 1001 }, () => "mcp__oc__Read") })
    witness.observe(result())
    expect(witness.summary().ready).toBe(false)
  })
})
