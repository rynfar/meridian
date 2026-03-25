import { describe, it, expect } from "bun:test"
import { getProxySettings, updateProxySettings } from "../keys/settings"

describe("ProxySettings", () => {
  it("returns default settings", () => {
    const s = getProxySettings()
    expect(s.maxConcurrent).toBeGreaterThan(0)
    expect(typeof s.passthrough).toBe("boolean")
    expect(typeof s.globalLimit6h).toBe("number")
    expect(typeof s.globalLimitWeekly).toBe("number")
  })

  it("updates maxConcurrent", () => {
    const before = getProxySettings().maxConcurrent
    const updated = updateProxySettings({ maxConcurrent: 42 })
    expect(updated.maxConcurrent).toBe(42)
    // Restore
    updateProxySettings({ maxConcurrent: before })
  })

  it("clamps maxConcurrent to 1-100", () => {
    const updated = updateProxySettings({ maxConcurrent: 999 })
    expect(updated.maxConcurrent).toBe(100)
    const updated2 = updateProxySettings({ maxConcurrent: -5 })
    expect(updated2.maxConcurrent).toBe(1)
    updateProxySettings({ maxConcurrent: 10 })
  })

  it("updates passthrough", () => {
    const before = getProxySettings().passthrough
    const updated = updateProxySettings({ passthrough: !before })
    expect(updated.passthrough).toBe(!before)
    updateProxySettings({ passthrough: before })
  })

  it("updates global limits", () => {
    const updated = updateProxySettings({ globalLimit6h: 50000, globalLimitWeekly: 200000 })
    expect(updated.globalLimit6h).toBe(50000)
    expect(updated.globalLimitWeekly).toBe(200000)
    updateProxySettings({ globalLimit6h: 0, globalLimitWeekly: 0 })
  })
})
