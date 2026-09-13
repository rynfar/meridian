import { describe, expect, it } from "bun:test"
import { computeLineageHash, matchesStoredLineagePrefix } from "../proxy/session/lineage"

describe("durable checkpoint prefix proof", () => {
  const prefix = [{ role: "user", content: "original instruction" }, { role: "system", content: [{ type: "text", text: "reminder" }] }]
  const stored = { messageCount: prefix.length, lineageHash: computeLineageHash(prefix) }

  it("accepts complete unchanged prefixes and equivalent text representations", () => {
    expect(matchesStoredLineagePrefix(stored, [...prefix, { role: "assistant", content: "new call" }])).toBe(true)
    expect(matchesStoredLineagePrefix(stored, [prefix[0]!, { role: "system", content: "reminder" }])).toBe(true)
  })

  it("rejects edits, removals and role changes before the pending call", () => {
    expect(matchesStoredLineagePrefix(stored, [{ role: "user", content: "revised instruction" }, prefix[1]!])).toBe(false)
    expect(matchesStoredLineagePrefix(stored, [prefix[0]!])).toBe(false)
    expect(matchesStoredLineagePrefix(stored, [prefix[0]!, { role: "user", content: "reminder" }])).toBe(false)
  })

  it("requires a valid nonempty stored count and current digest", () => {
    for (const messageCount of [undefined, 0, -1, 1.5, Infinity, NaN]) {
      expect(matchesStoredLineagePrefix({ ...stored, messageCount }, prefix)).toBe(false)
    }
    expect(matchesStoredLineagePrefix({ messageCount: 2 }, prefix)).toBe(false)
    expect(matchesStoredLineagePrefix({ messageCount: 2, lineageHash: "legacy" }, prefix)).toBe(false)
  })
})
