/**
 * Per-adapter passthrough MCP namespace (#893).
 *
 * In passthrough mode the client's tools are nested inside an SDK MCP server,
 * so the model reads them as `mcp__<namespace>__<tool>`. That namespace was the
 * module constant `oc` on EVERY adapter — including the LiteLLM/`passthrough`
 * adapter, whose own file has documented `mcp__litellm__*` since it was written
 * and whose `getMcpServerName()` was computed and then discarded on exactly the
 * path where client tools are registered.
 *
 * The default stays `oc`. Reusing `getMcpServerName()` was rejected: for
 * OpenCode it returns "opencode", so it would rename every client tool from
 * `mcp__oc__read` to `mcp__opencode__read` — moving the model-visible prompt,
 * and the prompt cache, for the entire existing user base — and collide with
 * the `mcp__opencode__*` names `passthroughEarlyStop` excludes precisely
 * because they are internal.
 */

import { describe, it, expect } from "bun:test"
import {
  PASSTHROUGH_MCP_NAME,
  PASSTHROUGH_MCP_PREFIX,
  passthroughMcpPrefix,
  stripMcpPrefix,
  buildPassthroughToolAliases,
  resolveClientToolName,
} from "../proxy/passthroughTools"
import { RESPONSES_TOOL_ALIAS_MAX } from "../proxy/openaiResponses"
import { isClientForwardedToolUse } from "../proxy/passthroughEarlyStop"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { passthroughAdapter } from "../proxy/adapters/passthrough"
import { codexAdapter } from "../proxy/adapters/codex"

describe("passthroughMcpPrefix", () => {
  it("defaults to the historical namespace", () => {
    expect(PASSTHROUGH_MCP_NAME).toBe("oc")
    expect(passthroughMcpPrefix()).toBe(PASSTHROUGH_MCP_PREFIX)
    expect(passthroughMcpPrefix()).toBe("mcp__oc__")
  })

  it("builds the prefix for a declared namespace", () => {
    expect(passthroughMcpPrefix("litellm")).toBe("mcp__litellm__")
  })
})

describe("adapter namespaces", () => {
  // The whole point of the default: OpenCode's model-visible tool names must
  // not move, or every existing session pays a cold prompt cache.
  it("leaves OpenCode on the default namespace", () => {
    const name = openCodeAdapter.getPassthroughMcpName?.() ?? PASSTHROUGH_MCP_NAME
    expect(name).toBe("oc")
    expect(passthroughMcpPrefix(name)).toBe("mcp__oc__")
  })

  it("does NOT reuse getMcpServerName, which would rename OpenCode's tools", () => {
    expect(openCodeAdapter.getMcpServerName()).toBe("opencode")
    const passthroughName = openCodeAdapter.getPassthroughMcpName?.() ?? PASSTHROUGH_MCP_NAME
    expect(passthroughName).not.toBe(openCodeAdapter.getMcpServerName())
  })

  it("gives the LiteLLM adapter the namespace its own file documents", () => {
    expect(passthroughAdapter.getPassthroughMcpName?.()).toBe("litellm")
    expect(passthroughMcpPrefix(passthroughAdapter.getPassthroughMcpName!())).toBe("mcp__litellm__")
  })

  it("leaves Codex on the default, which the Responses alias budget assumes", () => {
    const name = codexAdapter.getPassthroughMcpName?.() ?? PASSTHROUGH_MCP_NAME
    expect(name).toBe("oc")
    // The Responses route is Codex-only and its alias budget subtracts the
    // default prefix length. A longer Codex namespace would push an alias past
    // Claude's 64-character tool-name limit, so pin the pairing here too.
    expect(RESPONSES_TOOL_ALIAS_MAX).toBe(64 - passthroughMcpPrefix(name).length)
  })
})

describe("name translation under a non-default namespace", () => {
  it("strips the declared prefix, not the default one", () => {
    expect(stripMcpPrefix("mcp__litellm__read", "litellm")).toBe("read")
    // The default stripper must NOT touch another namespace's name.
    expect(stripMcpPrefix("mcp__litellm__read")).toBe("mcp__litellm__read")
  })

  it("round-trips a colliding client name within its own namespace", () => {
    const { aliasByClientName, clientNameByAlias } =
      buildPassthroughToolAliases(["mcp__litellm__read"], "litellm")
    expect(aliasByClientName.get("mcp__litellm__read")).toBe("read")
    expect(resolveClientToolName("mcp__litellm__read", clientNameByAlias, "litellm"))
      .toBe("mcp__litellm__read")
  })

  it("leaves a foreign namespace alone under a custom namespace", () => {
    const { aliasByClientName } = buildPassthroughToolAliases(["mcp__oc__read"], "litellm")
    // Under the litellm namespace, `mcp__oc__read` is just an ordinary name.
    expect(aliasByClientName.get("mcp__oc__read")).toBe("mcp__oc__read")
  })
})

describe("early-stop client-tool detection follows the namespace", () => {
  const call = (name: string) => ({ type: "tool_use", id: "t1", name })

  it("accepts a client tool in the declared namespace", () => {
    expect(isClientForwardedToolUse(call("mcp__litellm__read"), "mcp__litellm__")).toBe(true)
  })

  // This is the failure the parameter exists to prevent: with the hardcoded
  // default, a LiteLLM client tool looks like an INTERNAL MCP tool and never
  // arms the tracker, so its forwarded call is silently dropped.
  it("would reject that same tool under the default prefix", () => {
    expect(isClientForwardedToolUse(call("mcp__litellm__read"))).toBe(false)
  })

  it("still rejects a genuinely internal MCP tool", () => {
    expect(isClientForwardedToolUse(call("mcp__opencode__read"), "mcp__litellm__")).toBe(false)
  })

  it("still accepts a bare name, which the SDK emits on some paths", () => {
    expect(isClientForwardedToolUse(call("read"), "mcp__litellm__")).toBe(true)
  })

  it("keeps the default behaviour when no prefix is passed", () => {
    expect(isClientForwardedToolUse(call("mcp__oc__read"))).toBe(true)
    expect(isClientForwardedToolUse(call("ToolSearch"))).toBe(false)
  })
})
