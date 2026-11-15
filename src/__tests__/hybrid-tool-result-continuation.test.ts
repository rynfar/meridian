import { describe, expect, it } from "bun:test"
import { hybridToolResultContinuation } from "../proxy/replay"
import { checkpointPublicationRequiresReplay, createEarlyStopTracker, noteAssistantMessage } from "../proxy/passthroughEarlyStop"

const calls = ["a", "b", "c"].map(id => ({ type: "tool_use", id, name: "read", input: { path: id } }))
const echo = [{ role: "assistant", content: calls }]
const results = calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "REAL_" + call.id }))

describe("hybrid tool-result continuation", () => {
  it("puts the native result first even when client results arrive out of order", () => {
    const output = hybridToolResultContinuation([results[2], results[1], results[0], { type: "text", text: "queued" }],
      echo, calls.map(call => call.id), "a", name => "mcp__oc__" + name)
    expect(output?.[0]).toBe(results[0])
    expect(output?.at(-1)).toEqual({ type: "text", text: "queued" })
    const text = JSON.stringify(output)
    for (const id of ["a", "b", "c"]) expect(text.split("REAL_" + id)).toHaveLength(2)
    expect(output?.[1]).toEqual({ type: "text", text: '[Assistant: Previously called tool: {"id":"b","name":"mcp__oc__read","input":{"path":"b"}}]' })
  })

  it("preserves error metadata and literal result text in completed records", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
    const text = { type: "text", text: "\n<system-reminder>literal result</system-reminder>\t\n" }
    const output = hybridToolResultContinuation([{ ...results[0], content: [text, image] }, { ...results[1], is_error: true, content: [text] }, results[2]],
      echo, ["a", "b", "c"], "a")
    expect(output).toContainEqual(text)
    expect(output?.[0]).toEqual({ ...results[0], content: [text, image] })
    expect(output).toContainEqual({ type: "text", text: 'Recorded tool result: {"tool_use_id":"b","is_error":true}' })
  })

  it("fails closed on non-native result images even in the final record", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
    for (const imageIndex of [1, 2]) {
      const content = results.map((result, index) => index === imageIndex ? { ...result, content: [image] } : result)
      expect(hybridToolResultContinuation(content, echo, ["a", "b", "c"], "a")).toBeUndefined()
    }
  })

  it("fails closed on missing or ambiguous echoed calls, missing results and unknown native ids", () => {
    expect(hybridToolResultContinuation(results, [], ["a", "b", "c"], "a")).toBeUndefined()
    expect(hybridToolResultContinuation(results, [...echo, ...echo], ["a", "b", "c"], "a")).toBeUndefined()
    expect(hybridToolResultContinuation(results.slice(0, 2), echo, ["a", "b", "c"], "a")).toBeUndefined()
    expect(hybridToolResultContinuation(results, echo, ["a", "b", "c"], "unknown")).toBeUndefined()
  })

  it("requires explicit hybrid proof as well as capture, completeness and a ready boundary", () => {
    const publication = { clientToolCallIds: ["a", "b"], checkpointToolCallIds: ["a", "b"],
      observedToolCallIds: ["a", "b"], forwardedToolUseIds: new Set(["a", "b"]), checkpointReady: true }
    expect(checkpointPublicationRequiresReplay(publication)).toBe(true)
    expect(checkpointPublicationRequiresReplay({ ...publication, nativeToolCallId: "a" })).toBe(false)
    expect(checkpointPublicationRequiresReplay({ ...publication, nativeToolCallId: "unknown" })).toBe(true)
    expect(checkpointPublicationRequiresReplay({ ...publication, nativeToolCallId: "a", checkpointReady: false })).toBe(true)
    expect(checkpointPublicationRequiresReplay({ ...publication, nativeToolCallId: "a", forwardedToolUseIds: new Set(["a"]) })).toBe(true)
    expect(checkpointPublicationRequiresReplay({ ...publication, nativeToolCallId: "a", observedToolCallIds: ["a", "b", "hidden"] })).toBe(true)
  })

  it("keeps first and last UUIDs separately and never infers a singleton from grouped metadata", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, { type: "assistant", uuid: "first", message: { content: [calls[0]] } })
    noteAssistantMessage(tracker, { type: "assistant", uuid: "last", message: { content: [calls[1]] } })
    expect(tracker.firstToolCallAssistantUuid).toBe("first")
    expect(tracker.firstToolCallId).toBe("a")
    expect(tracker.toolCallAssistantUuid).toBe("last")
    const grouped = createEarlyStopTracker()
    noteAssistantMessage(grouped, { type: "assistant", uuid: "grouped", message: { content: calls } })
    expect(grouped.firstToolCallAssistantUuid).toBeUndefined()
    expect(grouped.firstToolCallId).toBeUndefined()
  })
})
