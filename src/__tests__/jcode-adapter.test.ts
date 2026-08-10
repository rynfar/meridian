import { describe, expect, it } from "bun:test"
import type { Context } from "hono"
import {
  extractJcodeWorkingDirectory,
  jcodeAdapter,
  normalizeJcodeSessionId,
} from "../proxy/adapters/jcode"

function makeContext(headers: Record<string, string>): Context {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return {
    req: {
      header: (name?: string) => name
        ? normalized[name.toLowerCase()]
        : { ...normalized },
    },
  } as unknown as Context
}

describe("Jcode adapter", () => {
  it("accepts only bounded wire-safe session IDs", () => {
    expect(normalizeJcodeSessionId("session_local_123")).toBe("session_local_123")
    expect(normalizeJcodeSessionId(" session:local-123 ")).toBe("session:local-123")
    expect(normalizeJcodeSessionId(" ")).toBeUndefined()
    expect(normalizeJcodeSessionId("bad session")).toBeUndefined()
    expect(normalizeJcodeSessionId("a".repeat(257))).toBeUndefined()
    expect(normalizeJcodeSessionId(undefined)).toBeUndefined()
  })

  it("extracts Jcode's plain working-directory system line", () => {
    expect(extractJcodeWorkingDirectory({
      system: "Host: macOS\nWorking directory: /repo/project\nGit branch: main",
    })).toBe("/repo/project")
    expect(extractJcodeWorkingDirectory({ system: "no directory marker" })).toBeUndefined()
  })

  it("extracts the working directory from text system blocks", () => {
    expect(extractJcodeWorkingDirectory({
      system: [
        { type: "text", text: "Host: macOS" },
        { type: "text", text: "Working directory: /repo/blocks" },
      ],
    })).toBe("/repo/blocks")
  })

  it("uses the validated Jcode session header as adapter identity", () => {
    expect(jcodeAdapter.getSessionId(makeContext({
      "x-jcode-session": "session_local_123",
    }))).toBe("session_local_123")
    expect(jcodeAdapter.getSessionId(makeContext({
      "x-jcode-session": "bad session",
    }))).toBeUndefined()
  })
})
