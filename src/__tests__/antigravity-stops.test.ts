import { describe, expect, it } from "bun:test"
import { AgTextStops } from "../proxy/backends/antigravityStops"

describe("Antigravity text stop boundary", () => {
  it("never emits a stop prefix across any chunk boundary", () => {
    const text = "before🧪STOPafter"
    for (let split = 0; split <= text.length; split++) {
      const stops = new AgTextStops(["🧪STOP"])
      expect(stops.push(text.slice(0, split)) + stops.push(text.slice(split)) + stops.flush()).toBe("before")
      expect(stops.matched).toBe("🧪STOP")
    }
  })
  it("selects the first stop and flushes unfinished prefixes", () => {
    const stops = new AgTextStops(["END", "STOP"])
    expect(stops.push("aSTOPbENDc")).toBe("a")
    expect(stops.matched).toBe("STOP")
    const incomplete = new AgTextStops(["STOP"])
    expect(incomplete.push("textST")).toBe("text")
    expect(incomplete.flush()).toBe("ST")
  })
})
