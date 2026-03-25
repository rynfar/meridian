import { describe, it, expect, afterEach } from "bun:test"
import { env } from "../env"

describe("env() helper", () => {
  afterEach(() => {
    delete process.env.MERIDIAN_TEST_VAR
    delete process.env.CLAUDE_PROXY_TEST_VAR
  })

  it("returns undefined when neither is set", () => {
    expect(env("TEST_VAR")).toBeUndefined()
  })

  it("reads CLAUDE_PROXY_ prefix", () => {
    process.env.CLAUDE_PROXY_TEST_VAR = "old-value"
    expect(env("TEST_VAR")).toBe("old-value")
  })

  it("reads MERIDIAN_ prefix", () => {
    process.env.MERIDIAN_TEST_VAR = "new-value"
    expect(env("TEST_VAR")).toBe("new-value")
  })

  it("MERIDIAN_ takes priority over CLAUDE_PROXY_", () => {
    process.env.CLAUDE_PROXY_TEST_VAR = "old"
    process.env.MERIDIAN_TEST_VAR = "new"
    expect(env("TEST_VAR")).toBe("new")
  })

  it("falls back to CLAUDE_PROXY_ when MERIDIAN_ is not set", () => {
    process.env.CLAUDE_PROXY_TEST_VAR = "fallback"
    expect(env("TEST_VAR")).toBe("fallback")
  })
})
