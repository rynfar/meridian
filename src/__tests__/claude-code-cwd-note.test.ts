/**
 * The client-CWD hint for Claude Code clients, against a REAL captured request.
 *
 * `claudeCodeAdapter` returns `undefined` from `extractWorkingDirectory` so the
 * SDK subprocess chdirs somewhere valid on the server, and surfaces the client's
 * real path separately: `extractClientWorkingDirectory` → `buildCwdNote` → a
 * `<meridian-note>` in the system prompt.
 *
 * When that chain breaks the model composes absolute paths from the PROXY's
 * directory, so a tool call writes to the wrong machine's tree and reports
 * success (#744). The failure is silent — nothing errors, the file the user
 * asked about is simply never touched.
 *
 * The fixture is a real request captured from the Claude Code CLI, not a
 * hand-written shape. #707's lesson: a test built from an invented shape can
 * pass while the real one fails.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"
import { buildCwdNote } from "../proxy/query"
import { resolveSdkWorkingDirectory } from "../proxy/cwd"

const FIXTURE = join(import.meta.dir, "fixtures", "claude-code-request.json")
const body = JSON.parse(readFileSync(FIXTURE, "utf8"))

/** The directory the capturing client was actually running in. */
const CLIENT_CWD =
  "/private/tmp/claude-501/-Users-rynfar-repos-meridian/0703e774-0f5f-4f53-b443-465188953fa6/scratchpad/cc-bodytest"
const PROXY_CWD = "/Users/rynfar/repos/meridian"

function cwdNote(sdkCwd: string, clientCwd?: string): string {
  return buildCwdNote(sdkCwd, clientCwd, {
    clientEnvironmentMayDifferFromProxy: claudeCodeAdapter.clientEnvironmentMayDifferFromProxy,
  })
}

describe("claude-code client CWD extraction (#744)", () => {
  it("the fixture is a real multi-block system prompt", () => {
    // Guards the instrument: a fixture reduced to a plain string would make the
    // array-walking branch untested while still passing.
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system.length).toBeGreaterThan(1)
  })

  it("extracts the client's working directory from the captured prompt", () => {
    expect(claudeCodeAdapter.extractClientWorkingDirectory?.(body)).toBe(CLIENT_CWD)
  })

  it("builds a note naming the client's directory, not the proxy's", () => {
    const note = cwdNote(PROXY_CWD, claudeCodeAdapter.extractClientWorkingDirectory?.(body))
    expect(note).toContain(CLIENT_CWD)
    expect(note).toContain("<meridian-note>")
    // The proxy path appears too — the note's job is to contrast them — but the
    // authoritative `<env>` block must carry the CLIENT's path.
    const envBlock = note.slice(note.indexOf("<env>"), note.indexOf("</env>"))
    expect(envBlock).toContain(CLIENT_CWD)
    expect(envBlock).not.toContain(PROXY_CWD)
  })

  it("keeps the SDK cwd undefined so the subprocess stays on a valid server path", () => {
    // Deliberate: the client's path may not exist on the proxy host at all.
    expect(claudeCodeAdapter.extractWorkingDirectory?.(body)).toBeUndefined()
  })

  it("keeps the client/proxy boundary when both report the same path text", () => {
    expect(cwdNote(CLIENT_CWD, CLIENT_CWD)).toContain("may not describe the client environment")
  })

  it("returns undefined rather than guessing when the prompt lacks the marker", () => {
    const stripped = {
      ...body,
      system: [{ type: "text", text: "You are a Claude agent. No environment section here." }],
    }
    expect(claudeCodeAdapter.extractClientWorkingDirectory?.(stripped)).toBeUndefined()
  })
})

describe("SDK working directory for a claude-code client (#744)", () => {
  const clientCwd = () => claudeCodeAdapter.extractClientWorkingDirectory?.(body)

  /** Mirrors the server.ts call site. */
  const resolve = (exists: (p: string) => boolean) =>
    resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: claudeCodeAdapter.extractWorkingDirectory?.(body) ?? clientCwd(),
      fallback: PROXY_CWD,
      exists,
    })

  it("chdirs into the client directory when the proxy can access it", () => {
    // Filesystem reachability does not prove that the request's client and the
    // proxy subprocess share an execution environment.
    const r = resolve(() => true)
    expect(r.workingDirectory).toBe(CLIENT_CWD)
    expect(r.fellBack).toBe(false)
    expect(cwdNote(r.workingDirectory, clientCwd())).toContain("may not describe the client environment")
  })

  it("falls back to the proxy path when the client directory is absent (#381)", () => {
    // Remote client: its filesystem layout does not exist here. Falling back is
    // what keeps the SDK from failing with a misleading "binary not found".
    const r = resolve(() => false)
    expect(r.workingDirectory).toBe(PROXY_CWD)
    expect(r.fellBack).toBe(true)
    // And the note is what carries the client's real path in that case.
    expect(cwdNote(r.workingDirectory, clientCwd())).toContain(CLIENT_CWD)
  })

  it("still prefers an adapter-supplied SDK path over the client path", () => {
    // Adapters like OpenCode return an SDK-safe cwd from extractWorkingDirectory;
    // this change must not demote them.
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/adapter/supplied",
      fallback: PROXY_CWD,
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/adapter/supplied")
  })

  it("still lets the env override win over both", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/env/override",
      adapterCwd: clientCwd(),
      fallback: PROXY_CWD,
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/env/override")
  })
})
