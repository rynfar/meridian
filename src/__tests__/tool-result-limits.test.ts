/**
 * toolResultLimits — size limits for client tool results, derived from the
 * model's context window.
 *
 * Pure unit tests (no mocks). The regression: a 3.8 MB grep result in a Zed
 * thread overflowed the model's context on every turn ("Prompt is too long"),
 * and nothing in the proxy bounded a single result.
 */
import { describe, it, expect } from "bun:test"
import {
  capClientToolResults,
  capStructuredToolResults,
  createToolResultBudget,
  formatBytes,
  formatWithheldNote,
  resolveToolResultLimits,
  DEFAULT_RESULT_WINDOW_PCT,
  DEFAULT_TURN_WINDOW_PCT,
  ESTIMATED_BYTES_PER_TOKEN,
} from "../proxy/toolResultLimits"

const NO_ENV: Record<string, string | undefined> = {}

describe("resolveToolResultLimits", () => {
  it("derives both limits from the model's context window", () => {
    const wide = resolveToolResultLimits(1_000_000, NO_ENV)
    expect(wide.windowTokens).toBe(1_000_000)
    expect(wide.perResultBytes).toBe(1_000_000 * DEFAULT_RESULT_WINDOW_PCT / 100 * ESTIMATED_BYTES_PER_TOKEN)
    expect(wide.perTurnBytes).toBe(1_000_000 * DEFAULT_TURN_WINDOW_PCT / 100 * ESTIMATED_BYTES_PER_TOKEN)

    const standard = resolveToolResultLimits(200_000, NO_ENV)
    expect(standard.windowTokens).toBe(200_000)
    expect(standard.perResultBytes).toBe(wide.perResultBytes / 5)
  })

  it("falls back to a 200k window when the caller has none", () => {
    expect(resolveToolResultLimits(Number.NaN, NO_ENV).windowTokens).toBe(200_000)
    expect(resolveToolResultLimits(0, NO_ENV).windowTokens).toBe(200_000)
  })

  it("honours the percentage overrides and treats 0 as unlimited", () => {
    const limits = resolveToolResultLimits(1_000_000, { MERIDIAN_MAX_TOOL_RESULT_PCT: "1", MERIDIAN_MAX_TURN_RESULTS_PCT: "0" })
    expect(limits.perResultBytes).toBe(20_000)
    expect(limits.perTurnBytes).toBe(Infinity)
  })

  it("lets an absolute byte override win over the percentage", () => {
    expect(resolveToolResultLimits(1_000_000, { MERIDIAN_MAX_TOOL_RESULT_BYTES: "65536" }).perResultBytes).toBe(65536)
    expect(resolveToolResultLimits(1_000_000, { MERIDIAN_MAX_TOOL_RESULT_BYTES: "0" }).perResultBytes).toBe(Infinity)
  })

  it("falls back to the defaults on garbage", () => {
    const limits = resolveToolResultLimits(1_000_000, { MERIDIAN_MAX_TOOL_RESULT_PCT: "lots", MERIDIAN_MAX_TOOL_RESULT_BYTES: "-3" })
    expect(limits.perResultBytes).toBe(100_000)
  })
})

describe("createToolResultBudget", () => {
  const limits = { windowTokens: 200_000, perResultBytes: 1_000, perTurnBytes: 2_500 }

  it("passes a result under both limits through unchanged", () => {
    const budget = createToolResultBudget(limits)
    const text = "x".repeat(900)
    expect(budget.fit(text, "read_file")).toBe(text)
    expect(budget.cuts).toHaveLength(0)
  })

  it("replaces an oversized result by a notice that names the tool, the sizes and a sample", () => {
    const budget = createToolResultBudget(limits)
    const text = "SAMPLE-START " + "0123456789abcdef-".repeat(400)
    const fitted = budget.fit(text, "grep")
    expect(fitted).not.toBe(text)
    expect(fitted).toContain("[Tool result withheld by the proxy]")
    expect(fitted).toContain("`grep` result is 7 KB")
    expect(fitted).toContain("above the 1 KB the proxy accepts for one result")
    expect(fitted).toContain("200,000-token context")
    expect(fitted).toContain("SAMPLE-START")
    expect(fitted.length).toBeLessThan(text.length)
    expect(budget.cuts).toEqual([{ tool: "grep", originalBytes: Buffer.byteLength(text), limitBytes: 1_000, reason: "result" }])
  })

  it("enforces the per-turn total across several results in order", () => {
    const budget = createToolResultBudget(limits)
    const chunk = "y".repeat(900)
    expect(budget.fit(chunk, "read_file")).toBe(chunk)
    expect(budget.fit(chunk, "read_file")).toBe(chunk)
    const third = budget.fit(chunk, "read_file")
    expect(third).toContain("left for tool results in this turn")
    expect(budget.cuts).toHaveLength(1)
    expect(budget.cuts[0]!.reason).toBe("turn")
    expect(budget.cuts[0]!.limitBytes).toBe(700)
  })

  it("measures bytes, not characters", () => {
    const budget = createToolResultBudget({ ...limits, perResultBytes: 10 })
    expect(budget.fit("ação!", "t")).toBe("ação!") // 7 bytes
    expect(budget.fit("açãoçã!", "t")).toContain("withheld") // 11 bytes
  })

  it("formats sizes for people", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(100_000)).toBe("100 KB")
    expect(formatBytes(3_810_000)).toBe("3.81 MB")
    expect(formatBytes(Infinity)).toBe("unlimited")
  })
})

describe("formatWithheldNote", () => {
  const limits = resolveToolResultLimits(1_000_000, NO_ENV) // 100 KB / 400 KB

  it("is empty when nothing was withheld", () => {
    expect(formatWithheldNote([], limits)).toBe("")
  })

  it("names each withheld result, the limit and its share of the window, and ends with a blank line", () => {
    const note = formatWithheldNote([
      { tool: "grep", originalBytes: 127_140_000, limitBytes: 100_000, reason: "result" },
      { tool: "grep", originalBytes: 781_000, limitBytes: 100_000, reason: "result" },
    ], limits)
    expect(note).toBe(
      "[meridian] Withheld 2 tool results before they reached the model: grep 127.14 MB, grep 781 KB. " +
      "Limit: 100 KB per result (5% of the 1,000,000-token window). The model got a notice with a sample instead.\n\n",
    )
  })

  it("uses the singular and mentions the per-turn limit when that is what hit", () => {
    const note = formatWithheldNote([{ tool: "read_file", originalBytes: 90_000, limitBytes: 12_000, reason: "turn" }], limits)
    expect(note.startsWith("[meridian] Withheld 1 tool result before they reached the model: read_file 90 KB. ")).toBe(true)
    expect(note).toContain("Limit: 400 KB per turn (20% of the 1,000,000-token window).")
  })
})

describe("capStructuredToolResults", () => {
  const names = new Map([["toolu_1", { name: "grep" }], ["toolu_2", { name: "read_file" }]])
  const limits = { windowTokens: 200_000, perResultBytes: 100, perTurnBytes: Infinity }

  it("caps string and text-block results as errors, keeps images and other blocks", () => {
    const budget = createToolResultBudget(limits)
    const big = "z".repeat(500)
    const content = [
      { type: "text", text: "look at this" },
      { type: "tool_result", tool_use_id: "toolu_1", content: big },
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: big }, { type: "image", source: { type: "base64", data: "AAAA" } }] },
      { type: "tool_result", tool_use_id: "toolu_2", content: "small" },
    ]
    const capped = capStructuredToolResults(content, budget, names) as Array<Record<string, unknown>>

    expect(capped).not.toBe(content)
    expect(capped[0]).toBe(content[0])
    expect(String(capped[1]!.content)).toContain("`grep` result is 500 B")
    expect(capped[1]!.is_error).toBe(true)
    const mixed = capped[2]!.content as Array<Record<string, unknown>>
    expect(mixed).toHaveLength(2)
    expect(String(mixed[0]!.text)).toContain("`read_file` result is 500 B")
    expect(mixed[1]!.type).toBe("image")
    expect(capped[2]!.is_error).toBe(true)
    expect(capped[3]).toBe(content[3])
    expect(budget.cuts.map((c) => c.tool)).toEqual(["grep", "read_file"])
  })

  it("returns the same content when nothing is oversized, and non-array content untouched", () => {
    const budget = createToolResultBudget(limits)
    const content = [{ type: "tool_result", tool_use_id: "toolu_1", content: "small" }]
    expect(capStructuredToolResults(content, budget, names)).toBe(content)
    expect(capStructuredToolResults("plain", budget, names)).toBe("plain")
    expect(budget.cuts).toHaveLength(0)
  })
})

describe("capClientToolResults", () => {
  const names = new Map([["toolu_1", { name: "grep" }], ["toolu_2", { name: "read_file" }], ["toolu_3", { name: "read_file" }]])
  const result = (id: string, text: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] })
  const call = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: names.get(id)!.name, input: {} }] })

  it("applies the per-result limit to history and the live turn alike", () => {
    const limits = { windowTokens: 200_000, perResultBytes: 100, perTurnBytes: Infinity }
    const big = "h".repeat(300)
    const messages = [
      { role: "user", content: "start" },
      call("toolu_1"), result("toolu_1", big),
      call("toolu_2"), result("toolu_2", big),
    ]
    const capped = capClientToolResults(messages, limits, names)
    expect(capped.cuts.map((c) => c.tool)).toEqual(["grep", "read_file"])
    expect(String((capped.messages[2]!.content as Array<{ content: string }>)[0]!.content)).toContain("withheld")
    expect(String((capped.messages[4]!.content as Array<{ content: string }>)[0]!.content)).toContain("withheld")
    expect(capped.messages[0]).toBe(messages[0])
    expect(capped.messages[1]).toBe(messages[1])
  })

  it("charges the per-turn limit only to the live turn, so a replayed history keeps its newest results", () => {
    const limits = { windowTokens: 200_000, perResultBytes: 1_000, perTurnBytes: 500 }
    const chunk = "r".repeat(400)
    const messages = [
      { role: "user", content: "start" },
      call("toolu_1"), result("toolu_1", chunk),
      call("toolu_2"), result("toolu_2", chunk),
      call("toolu_3"), { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_3", content: chunk },
        { type: "tool_result", tool_use_id: "toolu_3", content: chunk },
      ] },
    ]
    const capped = capClientToolResults(messages, limits, names)
    // History: two 400 B results, each under the per-result limit, both kept.
    expect(capped.messages[2]).toBe(messages[2])
    expect(capped.messages[4]).toBe(messages[4])
    // Live turn: the first 400 B fits in the 500 B turn budget, the second does not.
    const live = capped.messages[6]!.content as Array<{ content: string; is_error?: boolean }>
    expect(live[0]!.content).toBe(chunk)
    expect(live[1]!.content).toContain("left for tool results in this turn")
    expect(live[1]!.is_error).toBe(true)
    expect(capped.cuts).toEqual([{ tool: "read_file", originalBytes: 400, limitBytes: 100, reason: "turn" }])
  })

  it("returns an equal array and no cuts when nothing is oversized", () => {
    const limits = { windowTokens: 200_000, perResultBytes: 1_000, perTurnBytes: 5_000 }
    const messages = [{ role: "user", content: "start" }, call("toolu_1"), result("toolu_1", "ok")]
    const capped = capClientToolResults(messages, limits, names)
    expect(capped.messages).toEqual(messages)
    expect(capped.messages[2]).toBe(messages[2])
    expect(capped.cuts).toHaveLength(0)
  })
})
