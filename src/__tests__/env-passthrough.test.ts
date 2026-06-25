/**
 * Tests for envBool("PASSTHROUGH") behavior.
 *
 * Verifies that the passthrough env var is parsed correctly — in particular
 * that "0" and "false" disable passthrough (Boolean("0") is true in JS,
 * which was the original bug).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { envBool, resolvePassthrough } from "../env"

describe("envBool — PASSTHROUGH", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.MERIDIAN_PASSTHROUGH = process.env.MERIDIAN_PASSTHROUGH
    saved.CLAUDE_PROXY_PASSTHROUGH = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  afterEach(() => {
    if (saved.MERIDIAN_PASSTHROUGH !== undefined) {
      process.env.MERIDIAN_PASSTHROUGH = saved.MERIDIAN_PASSTHROUGH
    } else {
      delete process.env.MERIDIAN_PASSTHROUGH
    }
    if (saved.CLAUDE_PROXY_PASSTHROUGH !== undefined) {
      process.env.CLAUDE_PROXY_PASSTHROUGH = saved.CLAUDE_PROXY_PASSTHROUGH
    } else {
      delete process.env.CLAUDE_PROXY_PASSTHROUGH
    }
  })

  it("returns true for MERIDIAN_PASSTHROUGH=1", () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    expect(envBool("PASSTHROUGH")).toBe(true)
  })

  it("returns true for MERIDIAN_PASSTHROUGH=true", () => {
    process.env.MERIDIAN_PASSTHROUGH = "true"
    expect(envBool("PASSTHROUGH")).toBe(true)
  })

  it("returns true for MERIDIAN_PASSTHROUGH=yes", () => {
    process.env.MERIDIAN_PASSTHROUGH = "yes"
    expect(envBool("PASSTHROUGH")).toBe(true)
  })

  it("returns false for MERIDIAN_PASSTHROUGH=0 (Boolean('0') bug)", () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    expect(envBool("PASSTHROUGH")).toBe(false)
  })

  it("returns false for MERIDIAN_PASSTHROUGH=false", () => {
    process.env.MERIDIAN_PASSTHROUGH = "false"
    expect(envBool("PASSTHROUGH")).toBe(false)
  })

  it("returns false for MERIDIAN_PASSTHROUGH=no", () => {
    process.env.MERIDIAN_PASSTHROUGH = "no"
    expect(envBool("PASSTHROUGH")).toBe(false)
  })

  it("returns false for empty string", () => {
    process.env.MERIDIAN_PASSTHROUGH = ""
    expect(envBool("PASSTHROUGH")).toBe(false)
  })

  it("returns false when neither env var is set", () => {
    expect(envBool("PASSTHROUGH")).toBe(false)
  })

  it("falls back to CLAUDE_PROXY_PASSTHROUGH when MERIDIAN_ is not set", () => {
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
    expect(envBool("PASSTHROUGH")).toBe(true)
  })

  it("MERIDIAN_ takes precedence over CLAUDE_PROXY_", () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
    expect(envBool("PASSTHROUGH")).toBe(false)
  })
})

describe("resolvePassthrough", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.MERIDIAN_PASSTHROUGH = process.env.MERIDIAN_PASSTHROUGH
    saved.CLAUDE_PROXY_PASSTHROUGH = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  afterEach(() => {
    if (saved.MERIDIAN_PASSTHROUGH !== undefined) {
      process.env.MERIDIAN_PASSTHROUGH = saved.MERIDIAN_PASSTHROUGH
    } else {
      delete process.env.MERIDIAN_PASSTHROUGH
    }
    if (saved.CLAUDE_PROXY_PASSTHROUGH !== undefined) {
      process.env.CLAUDE_PROXY_PASSTHROUGH = saved.CLAUDE_PROXY_PASSTHROUGH
    } else {
      delete process.env.CLAUDE_PROXY_PASSTHROUGH
    }
  })

  it("returns the default when neither env var is set", () => {
    expect(resolvePassthrough(true)).toBe(true)
    expect(resolvePassthrough(false)).toBe(false)
  })

  it("returns the default for an unrecognized value", () => {
    process.env.MERIDIAN_PASSTHROUGH = "maybe"
    expect(resolvePassthrough(true)).toBe(true)
    expect(resolvePassthrough(false)).toBe(false)
  })

  it("explicit truthy values override a false default (opt-in)", () => {
    for (const v of ["1", "true", "yes"]) {
      process.env.MERIDIAN_PASSTHROUGH = v
      expect(resolvePassthrough(false)).toBe(true)
    }
  })

  it("explicit falsy values override a true default (opt-out)", () => {
    for (const v of ["0", "false", "no"]) {
      process.env.MERIDIAN_PASSTHROUGH = v
      expect(resolvePassthrough(true)).toBe(false)
    }
  })

  it("MERIDIAN_ takes precedence over CLAUDE_PROXY_", () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
    expect(resolvePassthrough(true)).toBe(false)
  })

  it("falls back to CLAUDE_PROXY_ when MERIDIAN_ is unset", () => {
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
    expect(resolvePassthrough(false)).toBe(true)
  })
})
