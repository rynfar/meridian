/**
 * Tests for adapter auto-detection.
 *
 * The proxy selects an adapter based on request headers.
 * Droid is identified by its User-Agent prefix.
 * Everything else defaults to OpenCode.
 */
import { describe, it, expect } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { droidAdapter } from "../proxy/adapters/droid"

function makeContext(userAgent: string): any {
  return {
    req: {
      header: (name: string) => name.toLowerCase() === "user-agent" ? userAgent : undefined,
    },
  }
}

describe("detectAdapter — Droid detection", () => {
  it("returns droidAdapter for 'factory-cli/0.89.0'", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(adapter).toBe(droidAdapter)
    expect(adapter.name).toBe("droid")
  })

  it("returns droidAdapter for 'factory-cli/1.0.0'", () => {
    const adapter = detectAdapter(makeContext("factory-cli/1.0.0"))
    expect(adapter).toBe(droidAdapter)
  })

  it("returns droidAdapter for any 'factory-cli/' prefix", () => {
    expect(detectAdapter(makeContext("factory-cli/0.1.0")).name).toBe("droid")
    expect(detectAdapter(makeContext("factory-cli/2.5.3")).name).toBe("droid")
    expect(detectAdapter(makeContext("factory-cli/99.99.99")).name).toBe("droid")
  })

  it("returns droidAdapter for 'factory-cli/' with extra info", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0 (darwin; arm64)"))
    expect(adapter).toBe(droidAdapter)
  })
})

describe("detectAdapter — OpenCode fallback", () => {
  it("returns openCodeAdapter for empty User-Agent", () => {
    const adapter = detectAdapter(makeContext(""))
    expect(adapter).toBe(openCodeAdapter)
    expect(adapter.name).toBe("opencode")
  })

  it("returns openCodeAdapter when User-Agent header is missing", () => {
    const ctx = { req: { header: () => undefined } }
    const adapter = detectAdapter(ctx as any)
    expect(adapter).toBe(openCodeAdapter)
  })

  it("returns openCodeAdapter for 'opencode/1.0'", () => {
    expect(detectAdapter(makeContext("opencode/1.0")).name).toBe("opencode")
  })

  it("returns openCodeAdapter for unknown User-Agent strings", () => {
    expect(detectAdapter(makeContext("curl/7.88.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("Mozilla/5.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("python-requests/2.28.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("axios/1.3.0")).name).toBe("opencode")
  })

  it("does NOT match 'factory/' without 'cli/'", () => {
    // Only exact 'factory-cli/' prefix triggers Droid
    expect(detectAdapter(makeContext("factory/1.0.0")).name).toBe("opencode")
  })

  it("does NOT match if factory-cli is not at the start", () => {
    // User-Agent with factory-cli in the middle should not trigger Droid
    expect(detectAdapter(makeContext("my-app factory-cli/0.89.0")).name).toBe("opencode")
  })
})

describe("detectAdapter — adapter contracts", () => {
  it("detected droid adapter can extract CWD from Droid-format body", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "<system-reminder>\n% pwd\n/tmp/test-project\n</system-reminder>",
        }],
      }],
    }
    expect(adapter.extractWorkingDirectory(body)).toBe("/tmp/test-project")
  })

  it("detected opencode adapter can extract CWD from OpenCode-format body", () => {
    const adapter = detectAdapter(makeContext(""))
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n</env>",
    }
    expect(adapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("detected droid adapter returns undefined for session ID", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    const ctx = { req: { header: () => "some-value" } }
    expect(adapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("detected opencode adapter extracts session from x-opencode-session", () => {
    const adapter = detectAdapter(makeContext("opencode/1.0"))
    const ctx = {
      req: { header: (name: string) => name === "x-opencode-session" ? "sess-abc" : undefined },
    }
    expect(adapter.getSessionId(ctx as any)).toBe("sess-abc")
  })

  it("detected droid adapter has droid MCP server name", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(adapter.getMcpServerName()).toBe("droid")
  })

  it("detected opencode adapter has opencode MCP server name", () => {
    const adapter = detectAdapter(makeContext(""))
    expect(adapter.getMcpServerName()).toBe("opencode")
  })

  it("detected droid adapter always returns false for usesPassthrough", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(adapter.usesPassthrough!()).toBe(false)
  })

  it("detected opencode adapter has no usesPassthrough — defers to env var", () => {
    const adapter = detectAdapter(makeContext(""))
    expect(adapter.usesPassthrough).toBeUndefined()
  })
})
