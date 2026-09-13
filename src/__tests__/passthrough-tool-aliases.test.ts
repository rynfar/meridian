/**
 * Passthrough tool aliasing (#967).
 *
 * Client tools are nested inside Meridian's own `oc` MCP server, so a client
 * tool whose declared name already starts with `mcp__oc__` used to be
 * advertised as `mcp__oc__mcp__oc__read` — a name the CLI lists but never
 * dispatches, so nothing was captured and the forwarded result the proxy
 * promised the model could never arrive.
 *
 * These are direct unit tests on the pure alias/reverse-map pair.
 */

import { describe, it, expect } from "bun:test"
import {
  buildPassthroughToolAliases,
  resolveClientToolName,
  createPassthroughMcpServer,
  stripMcpPrefix,
  PASSTHROUGH_MCP_PREFIX,
} from "../proxy/passthroughTools"

describe("buildPassthroughToolAliases", () => {
  it("leaves ordinary tool names untouched, so model-visible names never move", () => {
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases([
      "read",
      "write",
      "Bash",
    ])
    expect([...aliasByClientName]).toEqual([
      ["Bash", "Bash"],
      ["read", "read"],
      ["write", "write"],
    ])
    for (const [client, alias] of aliasByClientName) {
      expect(clientNameByAlias.get(alias)).toBe(client)
    }
  })

  it("drops the redundant prefix so the canonical SDK name equals the declared name", () => {
    const { aliasByClientName } = buildPassthroughToolAliases(["mcp__oc__read"])
    expect(aliasByClientName.get("mcp__oc__read")).toBe("read")
    // What the model is shown is exactly what the client declared.
    expect(`${PASSTHROUGH_MCP_PREFIX}read`).toBe("mcp__oc__read")
  })

  it("leaves a foreign mcp__ prefix alone — only our own namespace collides", () => {
    const { aliasByClientName } = buildPassthroughToolAliases(["mcp__zed__read"])
    expect(aliasByClientName.get("mcp__zed__read")).toBe("mcp__zed__read")
  })

  it("never lets an escaped name steal an identity a plain tool declared", () => {
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases([
      "read",
      "mcp__oc__read",
    ])
    expect(aliasByClientName.get("read")).toBe("read")
    expect(aliasByClientName.get("mcp__oc__read")).toBe("read_2")
    // Both directions stay exact, which is what the delivery paths rely on.
    expect(clientNameByAlias.get("read")).toBe("read")
    expect(clientNameByAlias.get("read_2")).toBe("mcp__oc__read")
  })

  it("is order-independent — the alias map cannot depend on request key order", () => {
    const a = buildPassthroughToolAliases(["read", "mcp__oc__read", "write"])
    const b = buildPassthroughToolAliases(["write", "mcp__oc__read", "read"])
    expect([...a.aliasByClientName]).toEqual([...b.aliasByClientName])
  })

  it("strips every leading copy, so an already-doubled name is still dispatchable", () => {
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases([
      "mcp__oc__mcp__oc__read",
    ])
    // Stripping only one copy would alias back to the undispatchable form.
    expect(aliasByClientName.get("mcp__oc__mcp__oc__read")).toBe("read")
    expect(clientNameByAlias.get("read")).toBe("mcp__oc__mcp__oc__read")
  })

  it("keeps a singly- and doubly-prefixed name apart", () => {
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases([
      "mcp__oc__read",
      "mcp__oc__mcp__oc__read",
    ])
    const single = aliasByClientName.get("mcp__oc__read")!
    const double = aliasByClientName.get("mcp__oc__mcp__oc__read")!
    expect(single).not.toBe(double)
    expect(clientNameByAlias.get(single)).toBe("mcp__oc__read")
    expect(clientNameByAlias.get(double)).toBe("mcp__oc__mcp__oc__read")
  })

  it("survives a degenerate name that is nothing but the prefix", () => {
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases(["mcp__oc__"])
    const alias = aliasByClientName.get("mcp__oc__")!
    expect(alias.length).toBeGreaterThan(0)
    expect(clientNameByAlias.get(alias)).toBe("mcp__oc__")
  })

  it("keeps every alias unique across a colliding set", () => {
    const names = ["read", "mcp__oc__read", "read_2", "mcp__oc__read_2"]
    const { aliasByClientName, clientNameByAlias } = buildPassthroughToolAliases(names)
    expect(new Set(aliasByClientName.values()).size).toBe(names.length)
    for (const name of names) {
      expect(clientNameByAlias.get(aliasByClientName.get(name)!)).toBe(name)
    }
  })
})

describe("resolveClientToolName", () => {
  it("round-trips a colliding name that the blind strip reduced to the wrong tool", () => {
    const { clientNameByAlias } = buildPassthroughToolAliases(["mcp__oc__read"])
    // The defect: a blind strip turns the SDK-side name into `read`, which the
    // client never declared and therefore cannot execute.
    expect(stripMcpPrefix("mcp__oc__read")).toBe("read")
    // Both shapes the SDK emits resolve back to the declared name.
    expect(resolveClientToolName("mcp__oc__read", clientNameByAlias)).toBe("mcp__oc__read")
    expect(resolveClientToolName("read", clientNameByAlias)).toBe("mcp__oc__read")
  })

  it("matches the legacy strip for ordinary tools", () => {
    const { clientNameByAlias } = buildPassthroughToolAliases(["read"])
    expect(resolveClientToolName("mcp__oc__read", clientNameByAlias)).toBe("read")
    expect(resolveClientToolName("read", clientNameByAlias)).toBe("read")
  })

  it("falls back to the legacy strip with no map, for internal SDK tools", () => {
    expect(resolveClientToolName("mcp__oc__read")).toBe("read")
    expect(resolveClientToolName("ToolSearch")).toBe("ToolSearch")
    expect(resolveClientToolName("mcp__opencode__read")).toBe("mcp__opencode__read")
  })
})

describe("createPassthroughMcpServer aliasing", () => {
  const schema = { type: "object" as const, properties: { file_path: { type: "string" as const } } }

  it("advertises a colliding tool once, not doubled", () => {
    const mcp = createPassthroughMcpServer([
      { name: "mcp__oc__read", description: "read", input_schema: schema },
    ])
    expect(mcp.toolNames).toEqual(["mcp__oc__read"])
    expect(mcp.toolNames).not.toContain("mcp__oc__mcp__oc__read")
    expect(mcp.clientNameByAlias.get("read")).toBe("mcp__oc__read")
  })

  it("leaves an ordinary tool set byte-identical", () => {
    const mcp = createPassthroughMcpServer([
      { name: "read", description: "read", input_schema: schema },
      { name: "write", description: "write", input_schema: schema },
    ])
    expect(mcp.toolNames).toEqual(["mcp__oc__read", "mcp__oc__write"])
  })

  it("keeps allowedTools names unique when a plain and a prefixed tool collide", () => {
    const mcp = createPassthroughMcpServer([
      { name: "read", description: "read", input_schema: schema },
      { name: "mcp__oc__read", description: "bridged read", input_schema: schema },
    ])
    expect(new Set(mcp.toolNames).size).toBe(2)
    expect(mcp.toolNames).toContain("mcp__oc__read")
    expect(mcp.toolNames).toContain("mcp__oc__read_2")
  })
})
