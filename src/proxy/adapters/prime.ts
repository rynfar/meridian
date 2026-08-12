/**
 * Prime Agent adapter.
 *
 * Prime Agent (npm `prime-agent`) is a FORK of Pi, not Pi. Its dependencies are
 * `@earendil-works/pi-agent-core` / `pi-ai` / `pi-tui` — republished Pi packages
 * — and its transport layer is Pi's unchanged: the official `@anthropic-ai/sdk`,
 * `stream: true` on every request, the same OAuth-vs-API-key client branch.
 *
 * Everything above the transport differs, which is why it gets its own adapter
 * rather than riding Pi's. Measured on 2026-08-12 by capturing real traffic
 * against a local recording server (prime-agent 0.7.2):
 *
 * - User-Agent (API-key mode): `Anthropic/JS <version>` — NOT `claude-cli/`.
 * - No session header, and no `metadata` on the wire by default.
 * - Exactly ONE tool is offered: `ipython` ({ code: string }). Not Pi's
 *   read/write/edit/bash/glob/grep. `bash` and `edit` exist only when a user
 *   opts into them with `-t`.
 * - System prompt ~17-19KB, one text block, opening "You are a general purpose
 *   agent that uses code to solve tasks."
 * - CWD arrives as `Working directory: <path>` — no `Current` prefix.
 *
 * Detection: the User-Agent is the generic Anthropic SDK one, shared with every
 * other SDK client, so a UA heuristic would misroute unrelated traffic. Select
 * with `x-meridian-agent: prime` (set in the provider config) or
 * `MERIDIAN_DEFAULT_AGENT=prime`. Running Prime Agent with an OAuth token makes
 * it send `claude-cli/<version>`, which the existing env-var tiebreaker in
 * detect.ts already resolves.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"
import { resolvePassthrough } from "../../env"
import { extractClaudeCodeSessionId } from "./claudecode"

const PRIME_MCP_SERVER_NAME = "prime"

/**
 * Internal-mode fallback tools.
 *
 * Prime Agent's real tool is `ipython`, a persistent kernel living in the
 * client — the proxy cannot provide it over MCP. Passthrough is therefore the
 * only mode in which Prime Agent works as designed. This set exists so that a
 * user who explicitly sets MERIDIAN_PASSTHROUGH=0 still gets a usable file/shell
 * surface rather than nothing, and is documented as a degraded mode.
 */
const PRIME_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PRIME_MCP_SERVER_NAME}__read`,
  `mcp__${PRIME_MCP_SERVER_NAME}__write`,
  `mcp__${PRIME_MCP_SERVER_NAME}__edit`,
  `mcp__${PRIME_MCP_SERVER_NAME}__bash`,
  `mcp__${PRIME_MCP_SERVER_NAME}__glob`,
  `mcp__${PRIME_MCP_SERVER_NAME}__grep`,
]

/**
 * The RLM prompt's own working-directory line (default branch of
 * buildSystemPrompt), emitted near the top — line 5 in every capture, ahead of
 * any user-supplied context.
 */
const RLM_CWD_LINE = /^Working directory:[ \t]*(.+)$/m

/**
 * The customPrompt branch's form, appended near the END, after project context
 * files. Prime Agent never emits both: the default branch produces only
 * `Working directory:`, the customPrompt branch only `Current working
 * directory:`.
 */
const CUSTOM_PROMPT_CWD_LINE = /^Current working directory:[ \t]*(.+)$/m

/**
 * Extract the client's working directory from Prime Agent's system prompt.
 *
 * Both patterns are anchored to start-of-line. In harness-generated text that
 * anchoring is not currently load-bearing — a capture of the real prompt
 * contains exactly one `Working directory:` occurrence and it is already at
 * line start (the prompt does discuss "the working directory" in prose, but
 * lowercase and without a colon, so it never matched either way).
 *
 * The anchor guards user-supplied content instead. Project context files are
 * inlined into this same prompt under `# Project Context`, so an AGENTS.md that
 * quotes the line mid-sentence — "set Working directory: /tmp/example first" —
 * would otherwise be read as the client's real cwd.
 *
 * `Working directory:` is tried first because in the common (default-prompt)
 * case it sits at line 5, ahead of any user content that might introduce the
 * other spelling. The customPrompt branch emits no such line, so it falls
 * through to `Current working directory:`.
 */
function extractPrimeCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body?.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body?.system)) {
    systemText = body.system
      .filter((b: any) => b?.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  if (!systemText) return undefined

  const match = systemText.match(RLM_CWD_LINE) ?? systemText.match(CUSTOM_PROMPT_CWD_LINE)
  return match?.[1]?.trim() || undefined
}

/**
 * `await edit(path="...", old_str=..., new_str=...)` — Prime Agent's
 * pre-imported targeted-edit skill, called from inside an IPython cell.
 * Both quote styles, optional `await`, optional whitespace.
 */
const EDIT_SKILL_CALL = /\bedit\s*\(\s*path\s*=\s*(['"])(.+?)\1/g

/** `!cmd` IPython shell escapes. Discouraged by the prompt, but they execute. */
const SHELL_ESCAPE_LINE = /^[ \t]*!(.+)$/

/**
 * Map an `ipython` cell to file changes.
 *
 * Handles the two forms that are cheap to read accurately:
 *
 *   1. `%%bash` cells. A cell magic must be the first line of the cell (Prime
 *      Agent's own prompt states this), so the whole remaining cell is shell
 *      and goes through the existing bash extractor.
 *   2. `edit(path=...)` calls and `!cmd` shell escapes inside a Python cell.
 *
 * It deliberately does NOT parse arbitrary Python writes — `open(p, "w")`,
 * `Path.write_text`, library calls, anything behind a variable. That would need
 * real dataflow analysis, and a parser that silently half-works is worse than a
 * documented gap: file-change summaries are a reporting nicety here, not
 * correctness. The limitation is stated in docs/agents.md.
 */
function extractFileChangesFromIpythonCell(code: string): FileChange[] {
  const lines = code.split("\n")
  const firstMeaningful = lines.find((l) => l.trim().length > 0) ?? ""

  if (/^[ \t]*%%bash\b/.test(firstMeaningful)) {
    const bodyStart = lines.indexOf(firstMeaningful) + 1
    return extractFileChangesFromBash(lines.slice(bodyStart).join("\n"))
  }

  const changes: FileChange[] = []

  for (const line of lines) {
    const escaped = line.match(SHELL_ESCAPE_LINE)
    if (escaped?.[1]) changes.push(...extractFileChangesFromBash(escaped[1]))
  }

  // matchAll rather than exec-in-a-loop: it iterates over an internal clone, so
  // the module-scoped /g regex can never carry lastIndex between calls.
  for (const m of code.matchAll(EDIT_SKILL_CALL)) {
    if (m[2]) changes.push({ operation: "edited", path: m[2] })
  }

  return changes
}

/**
 * Map a client-side tool_use block to file changes.
 *
 * In passthrough mode the SDK never executes tools, so PostToolUse hooks never
 * fire and file changes have to be read back out of the conversation.
 *
 * `ipython` is the only tool Prime Agent offers by default; `bash` and `edit`
 * appear only when a user opts into them with `-t`.
 *
 * Shared with transforms/prime.ts so the two cannot drift.
 */
function extractPrimeFileChanges(toolName: string, toolInput: unknown): FileChange[] {
  const input = toolInput as Record<string, unknown> | null | undefined

  if (toolName === "ipython" && typeof input?.code === "string") {
    return extractFileChangesFromIpythonCell(input.code)
  }

  const filePath = input?.path ?? input?.file_path ?? input?.filePath
  if (toolName === "edit" && filePath) {
    return [{ operation: "edited", path: String(filePath) }]
  }
  if (toolName === "write" && filePath) {
    return [{ operation: "wrote", path: String(filePath) }]
  }
  if (toolName === "bash" && input?.command) {
    return extractFileChangesFromBash(String(input.command))
  }
  return []
}

export const primeAdapter: AgentAdapter = {
  name: "prime",

  /**
   * `x-session-affinity` stays authoritative for orchestrators that set it.
   *
   * The body fallback is what makes recursive subagents and daemon mode work.
   * Prime Agent sends no session identity of its own, and under passthrough
   * every tool round ends in `user[tool_result]` — which trips the
   * `isClientDrivenLoop` bypass in server.ts: no session key means an
   * independent request, so no lineage lookup and a fresh SDK session every
   * tool round.
   *
   * Measured: a 19-round tool loop with no key logged `lineage=new
   * session=new` on every single round. #734 attributes prompt-cache decay to
   * exactly this shape; that consequence was NOT reproduced here, because the
   * probe conversation was too small to tell a static-prefix floor apart from
   * "there was nothing more to cache" (cache_read sat at 7k throughout, but so
   * did the whole conversation). Treat the churn as the established fact and
   * the cost consequence as reported-but-unverified at this scale.
   *
   * That bypass is CORRECT and stays: N concurrent RLM children, all
   * headerless, would otherwise collide on one (firstUserMessage, cwd)
   * fingerprint and resume each other's sessions. The fix is for the client to
   * declare a key, which a Prime Agent extension does from
   * `before_provider_request` using `ctx.sessionManager.getSessionId()`.
   *
   * Verified on the wire: a root agent and its RLM child carry distinct
   * `metadata.user_id` session ids, so children get distinct keys rather than
   * colliding. `extractClaudeCodeSessionId` is strict — `metadata.user_id` must
   * be, or parse to, an object with a non-empty string `session_id` — so
   * clients that don't opt in are unaffected.
   */
  getSessionId(c: Context, body?: unknown): string | undefined {
    return c.req.header("x-session-affinity") ?? extractClaudeCodeSessionId(body)
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractPrimeCwd(body)
  },

  /**
   * Prime Agent normally runs on the same host as the proxy, so the SDK
   * subprocess can chdir into the client's project. Exposing the same parse
   * here decouples fingerprint bucketing from MERIDIAN_WORKDIR, so two
   * unrelated Prime Agent projects don't share a fingerprint namespace just
   * because the proxy is pinned to one cwd.
   */
  extractClientWorkingDirectory(body: any): string | undefined {
    return extractPrimeCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * Prime Agent's tool is lowercase `ipython`, which doesn't collide with the
   * SDK's PascalCase built-ins. Block them anyway to prevent ambiguity.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return PRIME_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return PRIME_ALLOWED_MCP_TOOLS
  },

  /**
   * Prime Agent spawns subagents through its own RLM runtime (`await
   * rlm('sub-task')`), which are separate conversations making their own API
   * calls. That is not SDK agent routing, so there are no definitions to build.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /** Prime Agent renders thinking, and supports adaptive thinking levels. */
  supportsThinking(): boolean {
    return true
  },

  /** No PreToolUse hooks — Prime Agent executes its own tools. */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Passthrough is effectively required, not merely preferred: Prime Agent's
   * only tool is a persistent IPython kernel living in the client, which the
   * proxy cannot execute on its behalf. In internal mode the client's `ipython`
   * tool is dropped and only the MCP fallback set above is exposed.
   *
   * Default ON, opt out via MERIDIAN_PASSTHROUGH=0 — same shape as the
   * pi/claudecode/opencode adapters, so the escape hatch stays available even
   * though it is a degraded mode.
   */
  usesPassthrough(): boolean {
    return resolvePassthrough(true)
  },

  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    return extractPrimeFileChanges(toolName, toolInput)
  },
}

/**
 * Exported so transforms/prime.ts can share the exact same implementations
 * rather than keeping a hand-copied duplicate in step (the transform-parity
 * test catches drift, but not sharing is simply better). The import direction
 * is transforms → adapters, matching transforms/cherry.ts; the adapter
 * deliberately does NOT re-export primeTransforms, which would close the cycle.
 */
export {
  extractPrimeCwd,
  extractFileChangesFromIpythonCell,
  extractPrimeFileChanges,
  PRIME_ALLOWED_MCP_TOOLS,
}
