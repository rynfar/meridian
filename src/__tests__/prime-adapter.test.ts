import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  primeAdapter,
  extractPrimeCwd,
  extractFileChangesFromIpythonCell,
  extractPrimeFileChanges,
} from "../proxy/adapters/prime"
import { detectAdapter } from "../proxy/adapters/detect"
import { getAdapterTransforms } from "../proxy/transforms/registry"
import { primeTransforms } from "../proxy/transforms/prime"
import { createRequestContext, runTransformHook } from "../proxy/transform"

/**
 * The first 40 lines of a real Prime Agent 0.7.2 system prompt, captured on the
 * wire against a local recording server. Paths were neutralised; nothing else
 * was altered. Line 5 carries the working directory; line 36 mentions
 * "working directory" in prose, which is exactly the false positive the CWD
 * regex has to survive.
 */
const REAL_PROMPT_HEAD = readFileSync(
  join(import.meta.dir, "fixtures", "prime-agent-system-prompt-head.txt"),
  "utf8",
)

function ctxWith(headers: Record<string, string> = {}) {
  return {
    req: {
      header: (name?: string) => (name ? headers[name.toLowerCase()] : headers),
    },
  } as any
}

describe("extractPrimeCwd", () => {
  it("reads the RLM prompt's Working directory line", () => {
    const body = { system: "You are a general purpose agent.\nWorking directory: /home/dev/project\n" }
    expect(extractPrimeCwd(body)).toBe("/home/dev/project")
  })

  it("reads the customPrompt branch's Current working directory line", () => {
    // buildSystemPrompt's customPrompt branch appends this near the END, after
    // project context files, and emits no `Working directory:` line at all.
    const body = { system: "My own prompt.\n\n# Project Context\n\n## AGENTS.md\n\nstuff\n\nCurrent date: 2026-08-12\nCurrent working directory: /srv/app" }
    expect(extractPrimeCwd(body)).toBe("/srv/app")
  })

  it("ignores the line quoted mid-sentence in user context", () => {
    // Project context files are inlined into this same prompt, so an AGENTS.md
    // that mentions the line in passing must not be mistaken for the real cwd.
    // This is what start-of-line anchoring buys.
    const quoted = "# Project Context\n\n## AGENTS.md\n\nRemember to set Working directory: /tmp/example before running.\n"
    expect(extractPrimeCwd({ system: quoted })).toBeUndefined()
  })

  it("does not trip on the prompt's prose mention of working directories", () => {
    // Real line from the captured prompt — lowercase and no colon, so it never
    // matched. Pinned so a future loosening of the pattern has to notice.
    const prose = "use kernel-level equivalents that survive across calls: `%cd <dir>` for the working directory and `os.environ['VAR'] = '...'`"
    expect(extractPrimeCwd({ system: prose })).toBeUndefined()
  })

  it("extracts the right path from a real captured prompt", () => {
    expect(extractPrimeCwd({ system: REAL_PROMPT_HEAD })).toBe("/home/dev/project")
  })

  it("prefers the harness line over later user content", () => {
    const body = {
      system: [
        "Working directory: /real/project",
        "# Project Context",
        "## AGENTS.md",
        "Current working directory: /a/path/quoted/in/a/doc",
      ].join("\n"),
    }
    expect(extractPrimeCwd(body)).toBe("/real/project")
  })

  it("joins array-form system blocks", () => {
    const body = {
      system: [
        { type: "text", text: "You are a general purpose agent." },
        { type: "text", text: "Working directory: /home/dev/project" },
      ],
    }
    expect(extractPrimeCwd(body)).toBe("/home/dev/project")
  })

  it("returns undefined when there is no system prompt or no cwd line", () => {
    expect(extractPrimeCwd({})).toBeUndefined()
    expect(extractPrimeCwd({ system: "" })).toBeUndefined()
    expect(extractPrimeCwd({ system: "no directory here" })).toBeUndefined()
  })

  it("ignores a trailing-empty cwd value", () => {
    expect(extractPrimeCwd({ system: "Working directory:   " })).toBeUndefined()
  })
})

describe("extractFileChangesFromIpythonCell", () => {
  it("treats a %%bash cell as shell", () => {
    const cell = "%%bash\necho hi > /tmp/out.txt"
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([
      { operation: "wrote", path: "/tmp/out.txt" },
    ])
  })

  it("tolerates blank lines before the %%bash magic", () => {
    const cell = "\n\n%%bash\necho hi > /tmp/out.txt"
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([
      { operation: "wrote", path: "/tmp/out.txt" },
    ])
  })

  it("picks up the pre-imported edit skill", () => {
    const cell = 'old = "a"\nnew = "b"\nawait edit(path="src/index.ts", old_str=old, new_str=new)'
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([
      { operation: "edited", path: "src/index.ts" },
    ])
  })

  it("handles both quote styles and repeated edits", () => {
    const cell = "await edit(path='a.ts', old_str=x, new_str=y)\nawait edit(path=\"b.ts\", old_str=x, new_str=y)"
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([
      { operation: "edited", path: "a.ts" },
      { operation: "edited", path: "b.ts" },
    ])
  })

  it("is not stateful across calls", () => {
    // The edit regex is module-scoped with /g. matchAll keeps it stateless;
    // this pins that, so a future switch back to exec-with-an-early-break
    // (which would leave lastIndex dangling) gets caught.
    const cell = 'await edit(path="a.ts", old_str=x, new_str=y)'
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([{ operation: "edited", path: "a.ts" }])
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([{ operation: "edited", path: "a.ts" }])
  })

  it("picks up ! shell escapes inside a Python cell", () => {
    const cell = 'x = 1\n!echo hi > /tmp/escaped.txt\nprint(x)'
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([
      { operation: "wrote", path: "/tmp/escaped.txt" },
    ])
  })

  it("returns nothing for a plain Python write — the documented gap", () => {
    // Deliberate: parsing arbitrary Python writes needs dataflow analysis, and
    // a parser that silently half-works is worse than a stated limitation.
    const cell = 'open("/tmp/x.txt", "w").write("hi")'
    expect(extractFileChangesFromIpythonCell(cell)).toEqual([])
  })

  it("returns nothing for a read-only cell", () => {
    expect(extractFileChangesFromIpythonCell('src = open("a.ts").read()')).toEqual([])
  })
})

describe("extractPrimeFileChanges", () => {
  it("routes the ipython tool through the cell extractor", () => {
    expect(extractPrimeFileChanges("ipython", { code: "%%bash\necho hi > /tmp/a" })).toEqual([
      { operation: "wrote", path: "/tmp/a" },
    ])
  })

  it("handles opt-in edit / write / bash tools", () => {
    expect(extractPrimeFileChanges("edit", { path: "/a.ts" })).toEqual([
      { operation: "edited", path: "/a.ts" },
    ])
    expect(extractPrimeFileChanges("write", { file_path: "/b.ts" })).toEqual([
      { operation: "wrote", path: "/b.ts" },
    ])
    expect(extractPrimeFileChanges("bash", { command: "echo hi > /c.txt" })).toEqual([
      { operation: "wrote", path: "/c.txt" },
    ])
  })

  it("ignores unknown tools and malformed input", () => {
    expect(extractPrimeFileChanges("websearch", { query: "x" })).toEqual([])
    expect(extractPrimeFileChanges("ipython", {})).toEqual([])
    expect(extractPrimeFileChanges("ipython", null)).toEqual([])
    expect(extractPrimeFileChanges("edit", {})).toEqual([])
  })
})

describe("primeAdapter.getSessionId", () => {
  it("prefers an explicit x-session-affinity header", () => {
    const c = ctxWith({ "x-session-affinity": "orchestrator-key" })
    const body = { metadata: { user_id: JSON.stringify({ session_id: "from-body" }) } }
    expect(primeAdapter.getSessionId(c, body)).toBe("orchestrator-key")
  })

  it("falls back to metadata.user_id, the shape the extension supplies", () => {
    // Captured verbatim from the wire: before_provider_request stamps
    // ctx.sessionManager.getSessionId() into metadata.user_id.
    const body = {
      metadata: { user_id: JSON.stringify({ session_id: "019ff7d8-a616-745d-8cb2-97544a6accac" }) },
    }
    expect(primeAdapter.getSessionId(ctxWith(), body)).toBe("019ff7d8-a616-745d-8cb2-97544a6accac")
  })

  it("gives an RLM child a different key from its parent", () => {
    // Both ids are real, captured from one run: root at depth 0, child at
    // depth 1. Distinct keys are what stop concurrent children colliding on a
    // shared fingerprint.
    const parent = { metadata: { user_id: JSON.stringify({ session_id: "019ff7d8-a616-745d-8cb2-97544a6accac" }) } }
    const child = { metadata: { user_id: JSON.stringify({ session_id: "019ff7d8-ace2-7060-91dd-0212014a849e" }) } }
    const a = primeAdapter.getSessionId(ctxWith(), parent)
    const b = primeAdapter.getSessionId(ctxWith(), child)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it("returns undefined for a stock request that does not opt in", () => {
    // Prime Agent without the extension sends no session identity at all.
    expect(primeAdapter.getSessionId(ctxWith(), { model: "x", messages: [] })).toBeUndefined()
    expect(primeAdapter.getSessionId(ctxWith(), { metadata: { user_id: "plain-string" } })).toBeUndefined()
    expect(primeAdapter.getSessionId(ctxWith(), { metadata: { user_id: JSON.stringify({}) } })).toBeUndefined()
  })
})

describe("prime adapter configuration", () => {
  it("uses its own MCP server name", () => {
    expect(primeAdapter.getMcpServerName()).toBe("prime")
  })

  it("defaults to passthrough — its only tool lives in the client", () => {
    expect(primeAdapter.usesPassthrough!()).toBe(true)
  })

  it("forwards thinking blocks", () => {
    expect(primeAdapter.supportsThinking!()).toBe(true)
  })

  it("registers no SDK subagents — RLM children are the client's own", () => {
    expect(primeAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("prime adapter detection", () => {
  const savedDefault = process.env.MERIDIAN_DEFAULT_AGENT
  beforeEach(() => { delete process.env.MERIDIAN_DEFAULT_AGENT })
  afterEach(() => {
    if (savedDefault === undefined) delete process.env.MERIDIAN_DEFAULT_AGENT
    else process.env.MERIDIAN_DEFAULT_AGENT = savedDefault
  })

  it("selects prime via x-meridian-agent", () => {
    expect(detectAdapter(ctxWith({ "x-meridian-agent": "prime" })).name).toBe("prime")
  })

  it("accepts the npm package name as an alias", () => {
    expect(detectAdapter(ctxWith({ "x-meridian-agent": "prime-agent" })).name).toBe("prime")
  })

  it("does NOT select prime from the Anthropic SDK User-Agent", () => {
    // Prime Agent sends `Anthropic/JS <version>` in API-key mode. So does every
    // other SDK client, which is why there is no UA heuristic — matching on it
    // would misroute unrelated traffic.
    const adapter = detectAdapter(ctxWith({ "user-agent": "Anthropic/JS 0.91.1" }))
    expect(adapter.name).not.toBe("prime")
  })

  it("resolves the claude-cli collision in favour of prime when configured", () => {
    // Prime Agent run with an OAuth token sends claude-cli/<version>, same as
    // Pi. The existing env tiebreaker covers it.
    process.env.MERIDIAN_DEFAULT_AGENT = "prime"
    expect(detectAdapter(ctxWith({ "user-agent": "claude-cli/1.2.3" })).name).toBe("prime")
  })
})

describe("prime transform parity", () => {
  function makeCtx(body: any = {}) {
    return createRequestContext({
      adapter: "prime",
      body,
      headers: new Headers(),
      model: "sonnet",
      messages: [],
      stream: false,
      workingDirectory: "/tmp",
    })
  }

  it("is registered under the adapter name", () => {
    expect(getAdapterTransforms("prime")).toBe(primeTransforms)
  })

  it("matches allowedMcpTools", () => {
    const ctx = runTransformHook(primeTransforms, "onRequest", makeCtx(), "prime")
    expect([...ctx.allowedMcpTools]).toEqual([...primeAdapter.getAllowedMcpTools()])
  })

  it("matches blockedTools and incompatibleTools", () => {
    const ctx = runTransformHook(primeTransforms, "onRequest", makeCtx(), "prime")
    expect([...ctx.blockedTools]).toEqual([...primeAdapter.getBlockedBuiltinTools()])
    expect([...ctx.incompatibleTools]).toEqual([...primeAdapter.getAgentIncompatibleTools()])
  })

  it("matches supportsThinking and passthrough", () => {
    const ctx = runTransformHook(primeTransforms, "onRequest", makeCtx(), "prime")
    expect(ctx.supportsThinking).toBe(primeAdapter.supportsThinking!())
    expect(ctx.passthrough).toBe(primeAdapter.usesPassthrough!())
  })

  it("shares one file-change implementation with the adapter", () => {
    const ctx = runTransformHook(primeTransforms, "onRequest", makeCtx(), "prime")
    const cell = { code: 'await edit(path="a.ts", old_str=x, new_str=y)' }
    expect(ctx.extractFileChangesFromToolUse!("ipython", cell))
      .toEqual(primeAdapter.extractFileChangesFromToolUse!("ipython", cell))
  })
})
