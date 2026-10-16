/**
 * Under Bun the proxy is never told of a client that goes away before the
 * first byte of its response, so the model runs on. Startup says so.
 */
import { describe, it, expect } from "bun:test"
import { PROBED_BUN_VERSIONS, runtimeCancelWarning } from "../proxy/runtimeCancelWarning"

describe("runtimeCancelWarning", () => {
  it("names the cost and the way out under Bun", () => {
    const warning = runtimeCancelWarning({ ...process.versions, bun: "1.3.14" })
    expect(warning).toContain("Running under Bun 1.3.14")
    expect(warning).toContain("runs on to the end of its turn")
  })

  it("scopes the claim to the Bun releases actually probed", () => {
    const warning = runtimeCancelWarning({ ...process.versions, bun: "9.9.9" })
    expect(warning).toContain("Running under Bun 9.9.9")
    expect(warning).toContain(`checked on Bun ${PROBED_BUN_VERSIONS.join(", ")}`)
  })

  it("names the remedy for both a source checkout and an npm install", () => {
    const warning = runtimeCancelWarning({ ...process.versions, bun: "1.3.14" })
    expect(warning).toContain("from a source checkout, npm run build && npm run start")
    expect(warning).toContain("from an npm install, start meridian with Node (not bunx --bun)")
  })

  it("says nothing under Node", () => {
    const { bun: _bun, ...node } = process.versions
    expect(runtimeCancelWarning(node)).toBeUndefined()
  })
})
