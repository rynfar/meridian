/**
 * The client-CWD hint for OpenCode clients, against a REAL captured request.
 *
 * OpenCode reports its working directory in an `<env>` block, and
 * `extractClientCwd` has parsed that shape since before the adapter split. The
 * adapter wired it to `extractWorkingDirectory` only, where
 * `MERIDIAN_WORKDIR` / `CLAUDE_PROXY_WORKDIR` outranks it. On a deployment that
 * pins the SDK directory, `claimedWorkingDirectory` therefore becomes the
 * pinned path, `server.ts` falls back to it, and `buildCwdNote` compares that
 * path against itself and emits nothing. The model then reads the proxy's
 * directory out of the SDK's own env block and reports it as its cwd.
 *
 * The fixture is a real request captured from OpenCode 1.18.22 on Windows
 * through a recording proxy, with the working directory redacted and the tool
 * list removed. Nothing on the parse path reads `tools`. #707's lesson: a test
 * built from an invented shape can pass while the real one fails.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { buildCwdNote } from "../proxy/query"
import { resolveSdkWorkingDirectory } from "../proxy/cwd"

const FIXTURE = join(import.meta.dir, "fixtures", "opencode-request.json")
const body = JSON.parse(readFileSync(FIXTURE, "utf8"))

/** The directory the capturing client was running in, after redaction. */
const CLIENT_CWD = "C:\\projects\\example-app"
/** The container WORKDIR this proxy is normally pinned to. */
const PROXY_CWD = "/app"

/** A Windows client path never exists on a Linux proxy host. */
const existsOnProxy = (path: string) => path === PROXY_CWD

function resolve(envOverride: string | undefined) {
  const resolution = resolveSdkWorkingDirectory({
    envOverride,
    adapterCwd:
      openCodeAdapter.extractWorkingDirectory(body) ??
      openCodeAdapter.extractClientWorkingDirectory?.(body),
    fallback: PROXY_CWD,
    exists: existsOnProxy,
  })
  // Mirrors server.ts: the adapter's own answer wins, the resolution is the
  // fallback for adapters that do not implement it.
  const clientWorkingDirectory =
    openCodeAdapter.extractClientWorkingDirectory?.(body) ||
    resolution.claimedWorkingDirectory
  return {
    ...resolution,
    clientWorkingDirectory,
    note: buildCwdNote(resolution.workingDirectory, clientWorkingDirectory),
  }
}

describe("opencode client CWD extraction", () => {
  it("the fixture is a real request carrying an <env> block", () => {
    // Guards the instrument. A fixture whose system prompt lost the block
    // would make every assertion below pass for the wrong reason.
    expect(Array.isArray(body.system)).toBe(true)
    const text = body.system.map((b: { text?: string }) => b.text ?? "").join("\n")
    expect(text).toContain("<env>")
    expect(text).toContain(`Working directory: ${CLIENT_CWD}`)
  })

  it("extracts the client's working directory from the captured prompt", () => {
    expect(openCodeAdapter.extractClientWorkingDirectory?.(body)).toBe(CLIENT_CWD)
  })

  it("keeps the SDK out of a directory that does not exist on the proxy", () => {
    const { workingDirectory, fellBack } = resolve(undefined)
    expect(workingDirectory).toBe(PROXY_CWD)
    expect(fellBack).toBe(true)
  })

  it("names the client's directory in the note, not the proxy's", () => {
    const { note } = resolve(undefined)
    expect(note).toContain(CLIENT_CWD)
    expect(note).toContain("<meridian-note>")
  })

  it("still names the client's directory when the SDK cwd is pinned", () => {
    // The regression. With the override the resolution reports the pinned path
    // as both the SDK cwd and the claimed path, so the note survives only
    // because the adapter answers independently of it.
    const { workingDirectory, claimedWorkingDirectory, clientWorkingDirectory, note } =
      resolve(PROXY_CWD)
    expect(workingDirectory).toBe(PROXY_CWD)
    expect(claimedWorkingDirectory).toBe(PROXY_CWD)
    expect(clientWorkingDirectory).toBe(CLIENT_CWD)
    expect(note).toContain(CLIENT_CWD)
  })

  it("emits no note when the client and the SDK share a directory", () => {
    expect(buildCwdNote(PROXY_CWD, PROXY_CWD)).toBe("")
  })
})
