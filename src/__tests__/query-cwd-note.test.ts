/**
 * Tests for buildCwdNote — the helper that emits an `<env>` addendum so the
 * model reports the client's real working directory, not the SDK subprocess'
 * cwd on the proxy host. This bridges the gap for remote clients whose CWDs
 * don't exist on the proxy box.
 */
import { describe, it, expect } from "bun:test"
import { buildCwdNote } from "../proxy/query"

describe("buildCwdNote", () => {
  it("returns an empty string when clientCwd is undefined", () => {
    expect(buildCwdNote("/srv/proxy")).toBe("")
  })

  it("returns an empty string when both sides match (same-host client)", () => {
    expect(buildCwdNote("/same/path", "/same/path")).toBe("")
  })

  it("emits an <env> block with the client's path when they differ", () => {
    const note = buildCwdNote("/srv/proxy", "/Users/alice/app")
    expect(note).toContain("<env>")
    expect(note).toContain("Working directory: /Users/alice/app")
    expect(note).toContain("</env>")
  })

  it("includes a follow-up note identifying the proxy path", () => {
    const note = buildCwdNote("/srv/proxy", "/Users/alice/app")
    expect(note).toContain("<meridian-note>")
    expect(note).toContain("/srv/proxy")
    expect(note).toContain("/Users/alice/app")
    expect(note).toContain("</meridian-note>")
  })

  it("places the <env> override before the meridian-note so the subprocess sees it first", () => {
    const note = buildCwdNote("/srv/proxy", "/Users/alice/app")
    const envIdx = note.indexOf("<env>")
    const noteIdx = note.indexOf("<meridian-note>")
    expect(envIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeGreaterThan(envIdx)
  })

  it("handles paths containing spaces or special characters", () => {
    const note = buildCwdNote("/srv", "/Users/alice/My Projects/app (v2)")
    expect(note).toContain("Working directory: /Users/alice/My Projects/app (v2)")
  })

  it("treats an empty clientCwd as no-op", () => {
    expect(buildCwdNote("/srv/proxy", "")).toBe("")
  })
})
