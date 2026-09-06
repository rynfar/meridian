/**
 * Namespaced (MCP) and custom tools on the Responses API — Codex 0.153 ships
 * every MCP server as one `{type:"namespace", tools:[…]}` entry and its
 * freeform `apply_patch` as `{type:"custom"}`; a translator that keeps only
 * `type:"function"` silently loses all of them. Wire shapes mirror a request
 * captured from Codex Desktop 0.153.4 (25 tools, 12 namespaces).
 */

import { describe, it, expect } from "bun:test"
import {
  translateResponsesToAnthropic,
  translateAnthropicToResponses,
  createResponsesSseTranslator,
  buildResponsesToolAliases,
  responsesToolAlias,
  RESPONSES_TOOL_ALIAS_MAX,
} from "../proxy/openaiResponses"
import { PASSTHROUGH_MCP_PREFIX } from "../proxy/passthroughTools"

const iskronNamespace = {
  type: "namespace",
  name: "mcp__iskron-bridge",
  description: "Graph tools.",
  tools: [
    { type: "function", name: "iskron_orient", description: "Orient in a realm.", strict: false, parameters: { type: "object", properties: { realm: { type: "string" } }, required: ["realm"] } },
    { type: "function", name: "iskron_look", description: "Read one node.", strict: false, parameters: { type: "object", properties: { node_id: { type: "string" } } } },
  ],
}
const applyPatch = {
  type: "custom",
  name: "apply_patch",
  description: "The `apply_patch` tool can be used to edit files.",
  format: { type: "grammar", syntax: "lark", definition: "start: begin_patch hunk+ end_patch" },
}
const tools = [
  { type: "function", name: "shell", description: "run", strict: false, parameters: { type: "object", properties: {} } },
  applyPatch,
  iskronNamespace,
  { type: "web_search", external_web_access: true } as unknown as { type: string; name: string },
]

describe("responsesToolAlias", () => {
  it("leaves the alias budget for the passthrough MCP prefix", () => {
    expect(RESPONSES_TOOL_ALIAS_MAX).toBe(64 - PASSTHROUGH_MCP_PREFIX.length)
  })

  it("joins namespace and name, sanitizing characters Claude rejects", () => {
    expect(responsesToolAlias("mcp__iskron-bridge", "iskron_orient")).toBe("mcp__iskron-bridge__iskron_orient")
    expect(responsesToolAlias("mcp__a.b", "x y")).toBe("mcp__a_b__x_y")
    expect(responsesToolAlias(undefined, "apply_patch")).toBe("apply_patch")
  })

  it("hashes names over the budget deterministically", () => {
    const long = responsesToolAlias("mcp__codex_apps__codex_document_control", "codex_document_control_list_sections")
    expect(long.length).toBeLessThanOrEqual(RESPONSES_TOOL_ALIAS_MAX)
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(long).toBe(responsesToolAlias("mcp__codex_apps__codex_document_control", "codex_document_control_list_sections"))
    expect(long).not.toBe(responsesToolAlias("mcp__codex_apps__codex_document_control", "codex_document_control_list_section"))
  })
})

describe("buildResponsesToolAliases", () => {
  it("lists nested and custom tools, not top-level functions", () => {
    const aliases = buildResponsesToolAliases(tools)
    expect([...aliases.keys()].sort()).toEqual(["apply_patch", "mcp__iskron-bridge__iskron_look", "mcp__iskron-bridge__iskron_orient"])
    expect(aliases.get("mcp__iskron-bridge__iskron_orient")).toEqual({ namespace: "mcp__iskron-bridge", name: "iskron_orient", kind: "function" })
    expect(aliases.get("apply_patch")).toEqual({ name: "apply_patch", kind: "custom" })
  })
})

describe("translateResponsesToAnthropic with namespaces", () => {
  it("flattens namespace tools and exposes custom tools as a single-string function", () => {
    const r = translateResponsesToAnthropic({ model: "m", input: "x", tools })!
    expect(r.tools!.map((t) => t.name)).toEqual(["shell", "apply_patch", "mcp__iskron-bridge__iskron_orient", "mcp__iskron-bridge__iskron_look"])
    const orient = r.tools!.find((t) => t.name === "mcp__iskron-bridge__iskron_orient")!
    expect(orient.description).toBe("[mcp__iskron-bridge] Orient in a realm.")
    expect(orient.input_schema).toEqual({ type: "object", properties: { realm: { type: "string" } }, required: ["realm"] })
    const patch = r.tools!.find((t) => t.name === "apply_patch")!
    expect(patch.description).toContain("edit files")
    expect(patch.description).toContain("Input grammar (lark)")
    expect((patch.input_schema as { required: string[] }).required).toEqual(["input"])
  })

  it("replays namespaced and custom calls from history under the same aliases", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      tools,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", name: "iskron_orient", namespace: "mcp__iskron-bridge", arguments: '{"realm":"r60"}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "ГРАФ: merkazim [60]" },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch\n", call_id: "call_2" },
        { type: "custom_tool_call_output", call_id: "call_2", output: "Done!" },
      ] as never,
    })!
    const assistant = r.messages.filter((m) => m.role === "assistant").flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
    expect(assistant).toEqual([
      { type: "tool_use", id: "call_1", name: "mcp__iskron-bridge__iskron_orient", input: { realm: "r60" } },
      { type: "tool_use", id: "call_2", name: "apply_patch", input: { input: "*** Begin Patch\n*** End Patch\n" } },
    ])
    const results = r.messages.filter((m) => m.role === "user").flatMap((m) => m.content as unknown as Array<Record<string, unknown>>).filter((b) => b.type === "tool_result")
    expect(results.map((b) => b.tool_use_id)).toEqual(["call_1", "call_2"])
  })
})

describe("translateAnthropicToResponses with aliases", () => {
  const ctx = { responseId: "resp_1", model: "m", created: 1, toolAliases: buildResponsesToolAliases(tools) }

  it("turns an aliased tool_use into a namespaced function_call", () => {
    const out = translateAnthropicToResponses({
      content: [{ type: "tool_use", id: "toolu_1", name: "mcp__iskron-bridge__iskron_orient", input: { realm: "r60" } }],
      stop_reason: "tool_use",
    }, ctx)
    expect((out.output as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function_call", id: "fc_toolu_1", call_id: "toolu_1", name: "iskron_orient", namespace: "mcp__iskron-bridge",
      arguments: '{"realm":"r60"}', status: "completed",
    })
  })

  it("turns a custom tool_use into a custom_tool_call carrying the raw input", () => {
    const out = translateAnthropicToResponses({
      content: [{ type: "tool_use", id: "toolu_2", name: "apply_patch", input: { input: "*** Begin Patch\n*** End Patch\n" } }],
      stop_reason: "tool_use",
    }, ctx)
    expect((out.output as Array<Record<string, unknown>>)[0]).toEqual({
      type: "custom_tool_call", id: "fc_toolu_2", call_id: "toolu_2", name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch\n", status: "completed",
    })
  })

  it("leaves top-level function tools untouched", () => {
    const out = translateAnthropicToResponses({
      content: [{ type: "tool_use", id: "toolu_3", name: "shell", input: { command: ["ls"] } }],
      stop_reason: "tool_use",
    }, ctx)
    const item = (out.output as Array<Record<string, unknown>>)[0]!
    expect(item.type).toBe("function_call")
    expect(item.name).toBe("shell")
    expect("namespace" in item).toBe(false)
  })
})

describe("createResponsesSseTranslator with aliases", () => {
  const ctx = { responseId: "resp_s", model: "m", created: 1, toolAliases: buildResponsesToolAliases(tools) }
  function run(events: Array<Record<string, unknown>>) {
    const translate = createResponsesSseTranslator(ctx)
    return events.flatMap((e) => translate(e as never))
  }
  const start = { type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } }
  const end = [
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]

  it("streams a namespaced function_call with argument deltas", () => {
    const out = run([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "mcp__iskron-bridge__iskron_orient", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"realm":"r60"}' } },
      ...end,
    ])
    const added = out.find((e) => e.event === "response.output_item.added")!.data.item as Record<string, unknown>
    expect(added).toMatchObject({ type: "function_call", name: "iskron_orient", namespace: "mcp__iskron-bridge", call_id: "toolu_9" })
    expect(out.filter((e) => e.event === "response.function_call_arguments.delta")).toHaveLength(1)
    const done = out.find((e) => e.event === "response.output_item.done")!.data.item as Record<string, unknown>
    expect(done).toMatchObject({ type: "function_call", name: "iskron_orient", namespace: "mcp__iskron-bridge", arguments: '{"realm":"r60"}', status: "completed" })
    const completed = out.find((e) => e.event === "response.completed")!.data.response as { output: Array<Record<string, unknown>> }
    expect(completed.output[0]).toMatchObject({ type: "function_call", namespace: "mcp__iskron-bridge" })
  })

  it("streams a custom tool as one custom_tool_call item without argument deltas", () => {
    const out = run([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_p", name: "apply_patch", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"*** Begin ' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'Patch\\n*** End Patch\\n"}' } },
      ...end,
    ])
    const added = out.find((e) => e.event === "response.output_item.added")!.data.item as Record<string, unknown>
    expect(added).toMatchObject({ type: "custom_tool_call", name: "apply_patch", call_id: "toolu_p", status: "in_progress" })
    expect(out.some((e) => e.event === "response.function_call_arguments.delta")).toBe(false)
    expect(out.some((e) => e.event === "response.function_call_arguments.done")).toBe(false)
    const done = out.find((e) => e.event === "response.output_item.done")!.data.item as Record<string, unknown>
    expect(done).toEqual({ type: "custom_tool_call", id: "fc_toolu_p", call_id: "toolu_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch\n", status: "completed" })
  })
})

describe("function_call_output content items", () => {
  // MCP tool results come back from Codex as content items, not a string
  // (FunctionCallOutputBody::ContentItems); a verbatim pass-through reached
  // Anthropic as `tool_result.content[0].type = "input_text"` → 400.
  it("maps input_text and data-URL input_image items to tool_result blocks", () => {
    const png = "data:image/png;base64,iVBORw0KGgo="
    const r = translateResponsesToAnthropic({
      model: "m",
      tools,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", name: "iskron_orient", namespace: "mcp__iskron-bridge", arguments: "{}", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: [
          { type: "input_text", text: "ГРАФ: merkazim [60]" },
          { type: "input_image", image_url: png },
          { type: "encrypted_content", encrypted_content: "opaque" },
        ] },
      ] as never,
    })!
    const result = (r.messages.at(-1)!.content as unknown as Array<Record<string, unknown>>).find((b) => b.type === "tool_result")!
    expect(result.tool_use_id).toBe("call_1")
    expect(result.content).toEqual([
      { type: "text", text: "ГРАФ: merkazim [60]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "[Unsupported encrypted_content tool output part omitted]" },
    ])
  })

  it("keeps string outputs as strings and turns an empty item list into an empty string", () => {
    const r = translateResponsesToAnthropic({
      model: "m",
      input: [
        { type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "call_2" },
        { type: "function_call_output", call_id: "call_2", output: [] },
      ] as never,
    })!
    const results = r.messages.flatMap((m) => m.content as unknown as Array<Record<string, unknown>>).filter((b) => b.type === "tool_result")
    expect(results.map((b) => b.content)).toEqual(["a.txt", ""])
  })
})
