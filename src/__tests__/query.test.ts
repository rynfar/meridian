/**
 * Tests for the SDK query options builder.
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, GIT_STATUS_PROVENANCE_NOTE, resolveQueryConfigDir, type QueryContext } from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"
import { CHERRY_BLOCKED_BUILTIN_TOOLS, CHERRY_INCOMPATIBLE_TOOLS, CHERRY_WEB_TOOLS } from "../proxy/adapters/cherry"

function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet[1m]",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    envOverrides: undefined,
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}


describe("resolveQueryConfigDir", () => {
  it("uses the exact custom profile root", () => {
    expect(resolveQueryConfigDir({ CLAUDE_CONFIG_DIR: "/profiles/custom", HOME: "/home/test" }, false))
      .toBe("/profiles/custom")
  })

  it("uses the child HOME default when shared memory strips a custom root", () => {
    expect(resolveQueryConfigDir({ CLAUDE_CONFIG_DIR: "/profiles/custom", HOME: "/home/test" }, true))
      .toBe("/home/test/.claude")
  })

  it("resolves a relative custom root from the SDK child working directory", () => {
    expect(resolveQueryConfigDir(
      { CLAUDE_CONFIG_DIR: "profiles/custom", HOME: "/home/test" },
      false,
      "/srv/project",
    )).toBe("/srv/project/profiles/custom")
  })

  it("keeps oauth-token profile isolation with shared memory", () => {
    expect(resolveQueryConfigDir({
      CLAUDE_CONFIG_DIR: "/profiles/oauth",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      HOME: "/home/test",
    }, true)).toBe("/profiles/oauth")
  })
  it("resolves a relative HOME from the SDK child working directory", () => {
    expect(resolveQueryConfigDir({ HOME: "relative-home" }, false, "/srv/project"))
      .toBe("/srv/project/relative-home/.claude")
  })
})

describe("buildQueryOptions", () => {
  it("forces node as the executable to avoid bun auto-detection on embedded hosts", () => {
    // The SDK defaults to spawning 'bun' whenever process.versions.bun is set,
    // even when bun is not in PATH (e.g. OpenCode embeds Bun in its native binary).
    // Explicitly setting executable: 'node' prevents ENOENT spawn failures.
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).executable).toBe("node")
  })

  it("builds basic non-streaming options", () => {
    const result = buildQueryOptions(makeContext())
    expect(result.prompt).toBe("Hello")
    expect(result.options.model).toBe("sonnet[1m]")
    expect(result.options.cwd).toBe("/tmp/test")
    expect(result.options.maxTurns).toBe(200)
    expect(result.options.permissionMode).toBe("bypassPermissions")
    expect((result.options as any).includePartialMessages).toBeUndefined()
  })

  // The subprocess runs headless behind the proxy — its metrics, crash
  // reports, feedback uploads and surveys describe a session no human is in.
  it("quiets the subprocess's non-essential outbound traffic by default", () => {
    const env = buildQueryOptions(makeContext()).options.env ?? {}
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
    expect(env.DISABLE_TELEMETRY).toBe("1")
    expect(env.DISABLE_ERROR_REPORTING).toBe("1")
    expect(env.DISABLE_FEEDBACK_COMMAND).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1")
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1")
  })

  it("lets the inherited env opt back into telemetry", () => {
    const result = buildQueryOptions(makeContext({
      cleanEnv: { DISABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "0" },
    }))
    expect(result.options.env?.DISABLE_TELEMETRY).toBe("0")
    expect(result.options.env?.DISABLE_ERROR_REPORTING).toBe("0")
    // Untouched keys keep the quiet default.
    expect(result.options.env?.DISABLE_FEEDBACK_COMMAND).toBe("1")
  })

  it("lets envOverrides opt back into telemetry", () => {
    const result = buildQueryOptions(makeContext({
      envOverrides: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" },
    }))
    expect(result.options.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("0")
  })

  it("keeps the quiet defaults in passthrough mode", () => {
    const env = buildQueryOptions(makeContext({ passthrough: true })).options.env ?? {}
    expect(env.DISABLE_TELEMETRY).toBe("1")
  })

  it("applies envOverrides after inherited env", () => {
    const result = buildQueryOptions(makeContext({
      cleanEnv: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" },
      envOverrides: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7" },
    }))
    expect(result.options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7")
  })

  it("sets includePartialMessages for streaming", () => {
    const result = buildQueryOptions(makeContext({ stream: true }))
    expect((result.options as any).includePartialMessages).toBe(true)
  })

  it("caps maxTurns at 1 in passthrough mode so the SDK stops at the tool handoff instead of generating a billed digest turn", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect(result.options.maxTurns).toBe(1)
  })

  it("caps maxTurns at 1 in passthrough mode with resume (rehydration is inline and needs no extra turn)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, resumeSessionId: "sess-123" }))
    expect(result.options.maxTurns).toBe(1)
  })

  it("restores the multi-turn budget when the early-stop kill switch is off", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, earlyStop: false }))
    expect(result.options.maxTurns).toBe(3)
  })

  it("keeps the multi-turn budget when a structured output contract needs internal SDK turns", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      outputFormat: { type: "json_schema", schema: { type: "object" } } as any,
    }))
    expect(result.options.maxTurns).toBe(3)
  })

  it("lets an explicit PASSTHROUGH_MAX_TURNS override win over the single-turn cap", () => {
    const prev = process.env.MERIDIAN_PASSTHROUGH_MAX_TURNS
    process.env.MERIDIAN_PASSTHROUGH_MAX_TURNS = "5"
    try {
      const result = buildQueryOptions(makeContext({ passthrough: true }))
      expect(result.options.maxTurns).toBe(5)
    } finally {
      if (prev === undefined) delete process.env.MERIDIAN_PASSTHROUGH_MAX_TURNS
      else process.env.MERIDIAN_PASSTHROUGH_MAX_TURNS = prev
    }
  })

  it("keeps maxTurns at 4 with deferred tools — ToolSearch discovery is a real round-trip, so the cap must not apply (#547)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: true }))
    expect(result.options.maxTurns).toBe(4)
  })

  it("sets maxTurns to 4 in passthrough mode when resume AND deferred tools are both active (resume rehydration is inline; only the discovery turn adds)", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      resumeSessionId: "sess-123",
      hasDeferredTools: true,
    }))
    expect(result.options.maxTurns).toBe(4)
  })

  it("keeps maxTurns at 6 with advisor — the advisor executes call/result/answer, so the cap must not apply", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7" }))
    expect(result.options.maxTurns).toBe(6)
  })

  it("sets maxTurns to 6 in passthrough mode with advisor + resume", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7", resumeSessionId: "sess-123" }))
    expect(result.options.maxTurns).toBe(6)
  })

  it("sets maxTurns to 7 in passthrough mode with advisor + deferred tools (base 3 + discovery 1 + advisor 3)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7", hasDeferredTools: true }))
    expect(result.options.maxTurns).toBe(7)
  })

  it("sets maxTurns to 7 in passthrough mode with advisor + resume + deferred tools (all three active)", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      advisorModel: "claude-opus-4-7",
      resumeSessionId: "sess-123",
      hasDeferredTools: true,
    }))
    expect(result.options.maxTurns).toBe(7)
  })

  it("does not bump maxTurns in non-passthrough mode when advisor is set", () => {
    const result = buildQueryOptions(makeContext({ advisorModel: "claude-opus-4-7" }))
    expect(result.options.maxTurns).toBe(200)
  })

  it("includes system prompt as preset in normal mode", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "Be helpful" }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBeDefined()
    expect(sp.type).toBe("preset")
    expect(sp.append).toStartWith("Be helpful")
    // Every preset request also carries the gitStatus provenance note (#694).
    expect(sp.append).toContain(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("uses raw system prompt in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, systemContext: "Be helpful" }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBe("Be helpful")
  })

  it("omits system prompt when empty", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "" }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("includes resume session ID when provided", () => {
    const result = buildQueryOptions(makeContext({ resumeSessionId: "sdk-123" }))
    expect((result.options as any).resume).toBe("sdk-123")
  })

  it("omits resume when not provided", () => {
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).resume).toBeUndefined()
  })

  it("sets fork options for undo", () => {
    const result = buildQueryOptions(makeContext({
      isUndo: true,
      resumeSessionAtUuid: "uuid-abc",
    }))
    expect((result.options as any).forkSession).toBe(true)
    expect((result.options as any).resumeSessionAt).toBe("uuid-abc")
  })

  it("forks a passthrough assistant-boundary resume with its journaled target ID", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      resumeSessionId: "sdk-123",
      resumeSessionAtUuid: "assistant-uuid",
      forkSessionId: "11111111-1111-4111-8111-111111111111",
    }))
    expect((result.options as any).resume).toBe("sdk-123")
    expect((result.options as any).resumeSessionAt).toBe("assistant-uuid")
    expect((result.options as any).forkSession).toBe(true)
    expect((result.options as { sessionId?: string }).sessionId).toBe("11111111-1111-4111-8111-111111111111")
  })

  it("applies a preallocated target ID to a fresh session without enabling fork", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111"
    const result = buildQueryOptions(makeContext({ forkSessionId: sessionId }))
    expect((result.options as { forkSession?: boolean }).forkSession).toBeUndefined()
    expect((result.options as { sessionId?: string }).sessionId).toBe(sessionId)
  })

  it("includes agents when provided", () => {
    const agents = { explore: { model: "sonnet" } }
    const result = buildQueryOptions(makeContext({ sdkAgents: agents }))
    expect((result.options as any).agents).toEqual(agents)
  })

  it("omits agents when empty", () => {
    const result = buildQueryOptions(makeContext({ sdkAgents: {} }))
    expect((result.options as any).agents).toBeUndefined()
  })

  it("uses adapter's blocked tools in normal mode", () => {
    const result = buildQueryOptions(makeContext())
    const disallowed = (result.options as any).disallowedTools as string[]
    expect(disallowed).toContain("Read")
    expect(disallowed).toContain("TodoWrite")
    expect(disallowed).toContain("Agent")
  })

  it("uses adapter's allowed MCP tools in normal mode", () => {
    const result = buildQueryOptions(makeContext())
    const allowed = (result.options as any).allowedTools as string[]
    expect(allowed).toContain("mcp__opencode__read")
    expect(allowed).toContain("mcp__opencode__bash")
  })

  it("uses passthrough MCP tools when in passthrough mode", () => {
    const mockPassthroughMcp = {
      toolNames: ["mcp__passthrough__custom_tool"],
      server: {} as any,
      hasDeferredTools: false,
    }
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      passthroughMcp: mockPassthroughMcp,
    }))
    const allowed = (result.options as any).allowedTools as string[]
    expect(allowed).toContain("mcp__passthrough__custom_tool")
  })

  // ─── tools catalog stripping in passthrough — issue #489 ──────────────
  //
  // The SDK option `tools` controls which built-in tool *definitions* are
  // sent upstream to Claude. Distinct from `disallowedTools` which only
  // blocks invocation at runtime. Without `tools: []`, the SDK ships its
  // full ~25k-token built-in catalog on every request even when we don't
  // intend to use it. Passthrough mode should send an empty catalog so
  // the upstream payload only carries the user's actual content +
  // whatever MCP tools the client supplied. (Diagnosis by @albe-jj.)

  it("strips the SDK built-in tool catalog in passthrough mode (tools=[])", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect((result.options as any).tools).toEqual([])
  })

  it("strips the catalog even when passthroughMcp tools are present", () => {
    const mockPassthroughMcp = {
      toolNames: ["mcp__passthrough__custom_tool"],
      server: {} as any,
      hasDeferredTools: false,
    }
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      passthroughMcp: mockPassthroughMcp,
    }))
    // Catalog is empty — built-ins disabled.
    expect((result.options as any).tools).toEqual([])
    // MCP tools still flow through allowedTools (separate channel).
    const allowed = (result.options as any).allowedTools as string[]
    expect(allowed).toContain("mcp__passthrough__custom_tool")
  })

  it("does NOT set tools: [] in non-passthrough mode (catalog must remain available)", () => {
    // OpenCode and other coding-agent adapters need the SDK to invoke
    // built-ins like Read/Write/Bash. The catalog stays the SDK default.
    const result = buildQueryOptions(makeContext({ passthrough: false }))
    expect((result.options as any).tools).toBeUndefined()
  })

  // ─── settingSources stripping in passthrough — #489 follow-up ────────
  //
  // When `claudeMd: "off"` (the passthrough default), server.ts produces
  // `settingSources = []`. The lower spread block in query.ts gates on
  // `length > 0`, so the empty array is silently dropped and the SDK
  // never emits `--setting-sources=`. Without that flag, claude-code's
  // subprocess falls back to its built-in default and loads
  // user/project/local CLAUDE.md — adding ~hundreds-to-thousands of
  // tokens of unintended context to every passthrough request. Found
  // during the E2E audit while verifying the tools-catalog fix above
  // (response said "I've got the context from your CLAUDE.md file"
  // even with codeSystemPrompt: false). Pin `settingSources: []`
  // explicitly in the passthrough branch so the empty array survives.

  it("forces settingSources: [] in passthrough mode so claude-code skips CLAUDE.md", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect((result.options as any).settingSources).toEqual([])
  })

  it("settingSources from caller still wins in passthrough when claudeMd is project/full", () => {
    // server.ts resolves claudeMd="project" → settingSources=["project"];
    // the later spread block in buildQueryOptions overwrites the
    // passthrough default of `[]` because object spread keeps the last
    // assignment. This preserves the user's explicit opt-in to load
    // their project CLAUDE.md.
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      settingSources: ["project"] as any,
    }))
    expect((result.options as any).settingSources).toEqual(["project"])
  })

  // ─── resolveSystemPrompt defensive empty-string ───────────────────────
  //
  // If `codeSystemPrompt: false` is set explicitly AND there's no client
  // system prompt AND no cwdNote to append, the previous code returned
  // `{}` (no systemPrompt option) and let the SDK fall back to whatever
  // default was in effect. Force an empty string so the preset can't
  // sneak back in via that path.

  it("returns systemPrompt: '' when codeSystemPrompt=false and there's nothing to append", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      codeSystemPrompt: false,
      systemContext: "",
      // No clientWorkingDirectory so cwdNote is empty
    }))
    expect((result.options as any).systemPrompt).toBe("")
  })

  it("strips API keys from environment", () => {
    const result = buildQueryOptions(makeContext({
      cleanEnv: { HOME: "/home/user", SOME_VAR: "value" },
    }))
    const env = (result.options as any).env
    expect(env.HOME).toBe("/home/user")
    expect(env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("disables Claude.ai MCP servers in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
  })

  it("disables Claude.ai MCP servers in normal mode too, by default", () => {
    const result = buildQueryOptions(makeContext({ passthrough: false }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
  })

  // Explicit "true", not an omitted key (#634). Expressing the opt-in by
  // leaving the variable out would make it mean "whatever the subprocess
  // defaults to" — an upstream flip would then silently re-enable connectors
  // for opted-in users and disable them for everyone else.
  it("loads Claude.ai MCP servers when explicitly opted in", () => {
    const result = buildQueryOptions(makeContext({ passthrough: false, claudeAiConnectors: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("true")
  })

  it("always emits the connector variable, never relying on omission (#634)", () => {
    for (const ctx of [
      { passthrough: false },
      { passthrough: false, claudeAiConnectors: true },
      { passthrough: true, claudeAiConnectors: true },
    ]) {
      const env = (buildQueryOptions(makeContext(ctx)).options as any).env
      expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBeDefined()
    }
  })

  // Passthrough wins over the opt-in: the client executes tools there and
  // cannot run one that only exists inside the subprocess.
  it("keeps Claude.ai MCP servers off in passthrough even when opted in", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, claudeAiConnectors: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
  })

  it("includes hooks when provided", () => {
    const hooks = { PreToolUse: [{ matcher: "Task", hooks: [] }] }
    const result = buildQueryOptions(makeContext({ sdkHooks: hooks }))
    expect((result.options as any).hooks).toEqual(hooks)
  })

  it("sets ENABLE_TOOL_SEARCH=true when hasDeferredTools is true", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("sets ENABLE_TOOL_SEARCH=false when hasDeferredTools is false", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: false }))
    const env = (result.options as any).env
    expect(env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  // ── systemPrompt × settingSources matrix ──────────────────────────

  it("uses preset with append when systemContext + settingSources both set", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "Be helpful",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toStartWith("Be helpful")
    // Every preset request also carries the gitStatus provenance note (#694).
    expect(sp.append).toContain(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("uses preset with append in passthrough + settingSources", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Be helpful",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toStartWith("Be helpful")
    // Every preset request also carries the gitStatus provenance note (#694).
    expect(sp.append).toContain(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("appends only Meridian's own note when settingSources set but no systemContext", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    // No client context to append, so the gitStatus note (#694) stands alone.
    expect(sp.append).toBe(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("omits systemPrompt when no systemContext and no settingSources", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "", settingSources: [] }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("passes settingSources and memory settings to SDK options", () => {
    const result = buildQueryOptions(makeContext({
      settingSources: ["user", "project"],
      memory: true,
      dreaming: true,
    }))
    const opts = result.options as any
    expect(opts.settingSources).toEqual(["user", "project"])
    expect(opts.settings.autoMemoryEnabled).toBe(true)
    expect(opts.settings.autoDreamEnabled).toBe(true)
  })

  // #634: settings (the --settings flag domain) is independent of
  // settingSources (file domains). Empty sources must still send the memory
  // controls — otherwise memory:false is silently ignored and the SDK's
  // built-in default injects MEMORY.md into every session.
  it("sends settings even when settingSources is empty (#634)", () => {
    const result = buildQueryOptions(makeContext({ settingSources: [], memory: false, dreaming: false }))
    const opts = result.options as any
    expect(opts.settings.autoMemoryEnabled).toBe(false)
    expect(opts.settings.autoDreamEnabled).toBe(false)
  })

  // WebFetch preflight: the subprocess sends each fetch target's hostname to
  // api.anthropic.com before retrieving it. The setting is emitted on every
  // request for the same reason the memory keys are — an omitted key falls
  // back to the subprocess default, which runs the check.
  it("skips the WebFetch preflight when webFetchPreflight is false", () => {
    const result = buildQueryOptions(makeContext({ webFetchPreflight: false }))
    expect((result.options as any).settings.skipWebFetchPreflight).toBe(true)
  })

  it("runs the WebFetch preflight when webFetchPreflight is true", () => {
    const result = buildQueryOptions(makeContext({ webFetchPreflight: true }))
    expect((result.options as any).settings.skipWebFetchPreflight).toBe(false)
  })

  it("defaults to running the WebFetch preflight when unset", () => {
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).settings.skipWebFetchPreflight).toBe(false)
  })

  it("carries the WebFetch preflight setting into passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, webFetchPreflight: false }))
    expect((result.options as any).settings.skipWebFetchPreflight).toBe(true)
  })

  // The setting above only *reaches* the subprocess — it changes nothing
  // unless the subprocess can actually invoke the SDK's built-in WebFetch,
  // because that is where the preflight lives. These three lock in which
  // adapter shapes can, so the toggle's real scope can't drift silently.
  // Documented in docs/configuration.md under "WebFetch preflight".
  describe("WebFetch preflight scope", () => {
    const canRunBuiltinWebFetch = (opts: any): boolean => {
      const builtinsDisabled = Array.isArray(opts.tools) && opts.tools.length === 0
      return !builtinsDisabled && !(opts.disallowedTools ?? []).includes("WebFetch")
    }

    it("passthrough adapters disable every built-in, so the toggle is inert", () => {
      // `tools: []` is documented by the SDK as "disable all built-in tools".
      const opts = buildQueryOptions(makeContext({
        passthrough: true, blockedTools: [], incompatibleTools: [],
      })).options as any
      expect(opts.tools).toEqual([])
      expect(canRunBuiltinWebFetch(opts)).toBe(false)
    })

    it("internal-mode adapters block WebFetch outright, so the toggle is inert", () => {
      const opts = buildQueryOptions(makeContext({ passthrough: false })).options as any
      expect(opts.disallowedTools).toContain("WebFetch")
      expect(canRunBuiltinWebFetch(opts)).toBe(false)
    })

    it("cherry leaves the built-in WebFetch runnable, so the toggle bites there (#481)", () => {
      const opts = buildQueryOptions(makeContext({
        passthrough: false,
        blockedTools: CHERRY_BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CHERRY_INCOMPATIBLE_TOOLS,
        allowedMcpTools: [...CHERRY_WEB_TOOLS],
      })).options as any
      expect(opts.disallowedTools).not.toContain("WebFetch")
      expect(canRunBuiltinWebFetch(opts)).toBe(true)
    })
  })

  it("emits an explicit empty settingSources so the subprocess loads nothing (#634/#490)", () => {
    const result = buildQueryOptions(makeContext({ settingSources: [] }))
    expect((result.options as any).settingSources).toEqual([])
  })

  it("emits explicit empty settingSources when the caller passes none at all", () => {
    const result = buildQueryOptions(makeContext({ settingSources: undefined }))
    expect((result.options as any).settingSources).toEqual([])
  })

  it("honors memory:false in passthrough mode too (#634)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, settingSources: [], memory: false }))
    const opts = result.options as any
    expect(opts.settings.autoMemoryEnabled).toBe(false)
    expect(opts.settingSources).toEqual([])
  })

  // sharedMemory env handling — see issue #453 (and upstream
  // anthropics/claude-code#20553). Setting CLAUDE_CONFIG_DIR=$HOME/.claude
  // explicitly — even though it's the default — changes the SDK's Keychain
  // lookup key and breaks OAuth. So when sharedMemory is on, we DO NOT set
  // CLAUDE_CONFIG_DIR; we instead strip any inherited custom value so the
  // SDK falls back to its own default (which is ~/.claude).

  it("does NOT set CLAUDE_CONFIG_DIR when sharedMemory=true and profile env is empty (regression #453)", () => {
    const result = buildQueryOptions(makeContext({ sharedMemory: true, cleanEnv: {} }))
    const env = (result.options as any).env
    // Was the bug: previously this asserted env.CLAUDE_CONFIG_DIR contained
    // ".claude". Setting it explicitly broke macOS Keychain auth.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("strips inherited CLAUDE_CONFIG_DIR when sharedMemory=true (custom profile case)", () => {
    // sharedMemory's intent is "use the SDK's default ~/.claude so memories
    // sync with Claude Code". When a profile inherits a custom config dir,
    // we need that custom path REMOVED — not overridden — so the SDK's own
    // default takes over without the explicit-set bug.
    const result = buildQueryOptions(makeContext({
      sharedMemory: true,
      cleanEnv: { CLAUDE_CONFIG_DIR: "/custom/profile/dir", SOMETHING_ELSE: "keep-me" },
    }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    // Other inherited env vars are preserved.
    expect(env.SOMETHING_ELSE).toBe("keep-me")
  })

  it("preserves CLAUDE_CONFIG_DIR from profile when sharedMemory=false", () => {
    const result = buildQueryOptions(makeContext({
      sharedMemory: false,
      cleanEnv: { CLAUDE_CONFIG_DIR: "/custom/profile/dir" },
    }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/profile/dir")
  })

  it("omits CLAUDE_CONFIG_DIR when sharedMemory is false and profile env is empty", () => {
    const result = buildQueryOptions(makeContext({ sharedMemory: false, cleanEnv: {} }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  // sharedMemory must NOT strip CLAUDE_CONFIG_DIR when the profile carries an
  // explicit CLAUDE_CODE_OAUTH_TOKEN. Stripping it lets the SDK's 401-recovery
  // silently fall back to host ~/.claude credentials and swap a refreshed
  // token in for the env-provided one — making the oauth-token profile a
  // no-op against any host with an active claude login.
  // The whole point of pinning the per-profile isolation dir (see
  // buildResolvedProfile in profiles.ts) is to prevent that fallback.
  it("preserves CLAUDE_CONFIG_DIR with sharedMemory=true when CLAUDE_CODE_OAUTH_TOKEN is present", () => {
    const result = buildQueryOptions(makeContext({
      sharedMemory: true,
      cleanEnv: {
        CLAUDE_CONFIG_DIR: "/Users/me/.config/meridian/profiles/ci",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
        SOMETHING_ELSE: "keep-me",
      },
    }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.config/meridian/profiles/ci")
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test")
    expect(env.SOMETHING_ELSE).toBe("keep-me")
  })

  // ── codeSystemPrompt / clientSystemPrompt controls ────────────────

  it("forces preset when codeSystemPrompt is true even in passthrough", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toStartWith("Agent instructions")
    // Every preset request also carries the gitStatus provenance note (#694).
    expect(sp.append).toContain(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("skips preset when codeSystemPrompt is false in normal mode", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: false,
      systemContext: "Agent instructions",
      codeSystemPrompt: false,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBe("Agent instructions")
  })

  it("forces systemPrompt='' when codeSystemPrompt false and no systemContext (defensive against preset fallback)", () => {
    // Previously this asserted `undefined` — but leaving systemPrompt
    // undefined lets the SDK fall back to the claude_code preset by
    // default. The defensive empty-string form forecloses that path
    // (#489 follow-up).
    const result = buildQueryOptions(makeContext({
      systemContext: "",
      codeSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBe("")
  })

  it("drops the client prompt from the append when clientSystemPrompt is false", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
      clientSystemPrompt: false,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    // The guard: the client's prompt is suppressed. Meridian's own gitStatus
    // note is not client content, so it stays.
    expect(sp.append).not.toContain("Agent instructions")
    expect(sp.append).toBe(GIT_STATUS_PROVENANCE_NOTE)
  })

  it("strips client prompt when clientSystemPrompt is false in passthrough", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      clientSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("includes client prompt when clientSystemPrompt is true (default)", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      clientSystemPrompt: true,
    }))
    expect((result.options as any).systemPrompt).toBe("Agent instructions")
  })

  it("all three controls work together: preset + client + settingSources", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
      clientSystemPrompt: true,
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.append).toStartWith("Agent instructions")
    // Every preset request also carries the gitStatus provenance note (#694).
    expect(sp.append).toContain(GIT_STATUS_PROVENANCE_NOTE)
    const opts = result.options as any
    expect(opts.settingSources).toEqual(["user", "project"])
  })

  it("disabling both prompts forces systemPrompt='' (defensive against preset fallback)", () => {
    // Same defensive change as above — explicit empty rather than
    // undefined so the SDK can't reintroduce the preset.
    const result = buildQueryOptions(makeContext({
      systemContext: "Agent instructions",
      codeSystemPrompt: false,
      clientSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBe("")
  })
})
