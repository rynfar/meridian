/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import { join } from "node:path"
import type { Options, OutputFormat, SdkBeta, SettingSource } from "@anthropic-ai/claude-agent-sdk"
import { createOpencodeMcpServer } from "../mcpTools"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"
import { env, envInt } from "../env"
import type { Effort } from "./effort"

/**
 * Env defaults that quiet the subprocess's own outbound traffic.
 *
 * The subprocess here is infrastructure, not somebody's editor: it runs
 * headless, nobody reads its usage metrics, its crash reports describe a
 * process the operator never launched by hand, and `/feedback` and the
 * session-quality survey have no interactive session to report on. The
 * auto-updater is worse than useless — a version change underneath a running
 * proxy is a source of skew, not a feature.
 *
 * Spread *before* the inherited env so anything the operator sets — including
 * setting these to "0" — still wins.
 */
const QUIET_SUBPROCESS_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
}

/**
 * Return a copy of `env` with `CLAUDE_CONFIG_DIR` removed. Used by the
 * sharedMemory branch — see the comment at the env construction site.
 *
 * Skips the strip when `CLAUDE_CODE_OAUTH_TOKEN` is present: oauth-token
 * profiles deliberately pin a per-profile config dir so the SDK's
 * 401-recovery cannot silently fall back to host `~/.claude` credentials
 * and swap a refreshed token in for the env-provided one (closes #446).
 * Stripping the pin would defeat that isolation.
 *
 * Pure function: never mutates the input.
 */
function stripConfigDir(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!("CLAUDE_CONFIG_DIR" in env)) return env
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env
  const out = { ...env }
  delete out.CLAUDE_CONFIG_DIR
  return out
}

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** SDK subprocess working directory — must exist on the proxy host. */
  workingDirectory: string
  /**
   * Client-local working directory (as reported in the request). May not
   * exist on the proxy host. When this differs from workingDirectory the
   * system prompt is augmented with a note directing the model to refer
   * to file paths using the client's path rather than the proxy's.
   */
  clientWorkingDirectory?: string
  /** System context text (may be empty) */
  systemContext: string
  /** Path to Claude executable */
  claudeExecutable: string
  /** Whether passthrough mode is enabled */
  passthrough: boolean
  /** Whether this is a streaming request */
  stream: boolean
  /** SDK agent definitions extracted from tool descriptions */
  sdkAgents: Record<string, any>
  /** Passthrough MCP server (if passthrough mode + tools present) */
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Cleaned environment variables (API keys stripped) */
  cleanEnv: Record<string, string | undefined>
  /** Per-request env overrides that must win over inherited env */
  envOverrides?: Record<string, string | undefined>
  /** Whether any passthrough tools use deferred loading */
  hasDeferredTools: boolean
  /**
   * Whether passthrough early stop is active (MERIDIAN_PASSTHROUGH_EARLY_STOP
   * != "0"). Gates the single-turn maxTurns cap: the cap is only safe when the
   * checkpoint machinery is running to capture and store the tool boundary.
   * Defaults to on — omitting it must not silently reintroduce the billed
   * digest turn.
   */
  earlyStop?: boolean
  /** SDK session ID for resume (if continuing a session) */
  resumeSessionId?: string
  /** Whether this is an undo operation */
  isUndo: boolean
  /** Resume at this SDK assistant-message UUID (undo rollback point or
   *  passthrough tool-use boundary). Maps to resumeSessionAt, which accepts
   *  SDKAssistantMessage UUIDs only; forkSession separately chooses a new ID. */
  resumeSessionAtUuid?: string
  /** Fork the resumed session instead of attaching to it (#630 busy-session
   *  fallback — the original stays registered as a bg agent; the fork gets a
   *  fresh id with the full history). */
  forkSession?: boolean
  /** SDK hooks (PreToolUse etc.) */
  sdkHooks?: any
  /** Blocked SDK built-in tools (from pipeline) */
  blockedTools: readonly string[]
  /** Agent-incompatible tools (from pipeline) */
  incompatibleTools: readonly string[]
  /** MCP server name for this adapter */
  mcpServerName: string
  /** Allowed MCP tools (from pipeline) */
  allowedMcpTools: readonly string[]
  /** Callback to receive stderr lines from the Claude subprocess */
  onStderr?: (line: string) => void
  /** Effort level — controls thinking depth (low/medium/high/xhigh/max) */
  effort?: Effort
  /** Thinking configuration — adaptive, enabled with budget, or disabled */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' }
  /** API-side task budget in tokens — model paces tool use within this limit */
  taskBudget?: { total: number }
  /** Native JSON-schema output contract for the Claude Agent SDK */
  outputFormat?: OutputFormat
  /** Beta features to enable */
  betas?: string[]
  /** SDK setting sources — controls CLAUDE.md and user settings loading */
  settingSources?: SettingSource[]
  /** Use the Claude Code system prompt preset */
  codeSystemPrompt?: boolean
  /** Include the client agent's system prompt */
  clientSystemPrompt?: boolean
  /** Enable auto-memory (read + write across sessions) */
  memory?: boolean
  /** Enable background memory consolidation (dreaming) */
  dreaming?: boolean
  /** Share memory directory with Claude Code (~/.claude) */
  sharedMemory?: boolean
  /** Run the WebFetch domain safety check (hostname sent to api.anthropic.com) */
  webFetchPreflight?: boolean
  /** Load the account's claude.ai MCP connectors (ignored in passthrough) */
  claudeAiConnectors?: boolean
  /** Per-request cost cap in USD */
  maxBudgetUsd?: number
  /** Fallback model when primary fails */
  fallbackModel?: string
  /** Enable SDK debug logging */
  sdkDebug?: boolean
  /** Additional directories Claude can access */
  additionalDirectories?: string[]
  /** Advisor model for server-side advisor tool support */
  advisorModel?: string
}

/**
 * Build the options object for the Claude Agent SDK query() call.
 * This is called identically from both streaming and non-streaming paths,
 * with the only difference being `includePartialMessages` for streaming.
 */
export interface BuildQueryResult {
  prompt: QueryContext["prompt"]
  options: Options
}

/**
 * NOTE: agent-specific (passthrough mode).
 *
 * Compute maxTurns based on which SDK features are active.
 *
 * The default is 1, and that is the whole point. In passthrough the CLIENT
 * executes tools, so a turn that emits tool_use is already complete as far as
 * the client is concerned. Anything the SDK generates after it — the "digest"
 * turn where the model reacts to the PreToolUse denial — is discarded by the
 * proxy and still billed by Anthropic. Capping at 1 makes the SDK stop at the
 * tool-use boundary instead of generating that turn.
 *
 * A capped stop surfaces as `error_max_turns`, which is safe here precisely
 * because the SDK can only report it from a `result` message it has already
 * enqueued, and it awaits its transcript flush on `result`. So the session is
 * durably committed at the tool boundary; server.ts stores that checkpoint and
 * the next request resumes from it with the client's real tool_result. A turn
 * that ends without wanting to continue (plain text, no tools) never trips the
 * cap at all — it returns a normal success result.
 *
 * Measured against the live SDK (sonnet, one tool call), cap vs. the old base
 * of 3: 66 vs 159 output tokens and 0 vs ~127k cache-read tokens, because the
 * digest turn drags the CLI's full context along with it.
 *
 * The bumps below are the cases that genuinely need the SDK to keep going, and
 * each one turns the cap off rather than adding to it:
 *   - Deferred tools (4): a ToolSearch discovery is a real model round-trip
 *     that consumes a turn before the model can emit the real tool_use. Capping
 *     here would stop the query on the discovery turn and never reach the tool
 *     call (#547).
 *   - Advisor (+3): server-side advisor executes call + result + final answer.
 *   - Structured output: the SDK runs its internal StructuredOutput tool and
 *     needs turns to submit the result; capping strands it (HTTP 500).
 *   - Early-stop kill switch off: MERIDIAN_PASSTHROUGH_EARLY_STOP=0 restores
 *     the pre-cap wire behavior wholesale, so the budget must come back too.
 *
 * Base for those uncapped cases stays 3: turn 1 generates content (extended
 * thinking + tool_use blocks captured by PreToolUse hook); turn 2 receives the
 * deny and may emit a follow-up; turn 3 wraps the stream cleanly. Was 2
 * historically — bumped after telemetry showed opus[1m] requests with thinking
 * + tool_use exhausting the 2-turn budget mid-handoff and returning 500s on
 * fresh (non-resume) requests. Resume adds nothing: rehydration completes
 * inline within turn 1.
 */
function computePassthroughMaxTurns(
  hasDeferredTools: boolean,
  advisorModel: string | undefined,
  singleTurnHandoff: boolean,
): number {
  const deferredBump = hasDeferredTools ? 1 : 0
  const defaultBase = 3 + deferredBump
  // The base is the SDK's internal-loop budget before it must return control.
  // It's normally enough (the capture path drops re-emitted duplicates and
  // stops the loop when the model starts repeating), but wide parallel tool
  // calls — which the SDK surfaces one assistant turn each — can need more
  // headroom, and orchestration clients hit it on deep chains (#494). Allow
  // MERIDIAN_PASSTHROUGH_MAX_TURNS / CLAUDE_PROXY_PASSTHROUGH_MAX_TURNS to
  // raise (or lower) the base (incl. the deferred bump); the advisor bump
  // below is added on top and is unaffected by the override.
  const configured = envInt("PASSTHROUGH_MAX_TURNS", defaultBase)
  // An operator who pinned a budget gets it verbatim — the cap must not
  // silently override a value someone set to work around a client quirk.
  const operatorPinned = env("PASSTHROUGH_MAX_TURNS") !== undefined && configured > 0
  const advisorBump = advisorModel ? 3 : 0
  if (singleTurnHandoff && !operatorPinned) return 1
  const base = configured > 0 ? configured : defaultBase
  return base + advisorBump
}

/**
 * Build an addendum that tells the model which path belongs to the real user.
 * Applied when the SDK subprocess runs in one directory on the proxy host but
 * the client is working in a different directory on their own machine
 * (typical of a remote Claude Code → network-proxy setup). Without this note
 * the SDK's env block leaks `sdkCwd` into the model's context and Claude
 * reports that as its working directory.
 */
export function buildCwdNote(sdkCwd: string, clientCwd?: string): string {
  if (!clientCwd || clientCwd === sdkCwd) return ""
  // Emit in the `<env>Working directory: …</env>` shape the Claude Code
  // subprocess uses itself, so it doesn't auto-inject a second env block
  // pointing at its own process.cwd() (which would be the proxy host path).
  // Placed at the top of the append so it's the first env block the model
  // sees. The subsequent notice tells the model to prefer this over any
  // contradictory path that might slip through later in the context.
  return (
    `\n\n<env>\n` +
    `Working directory: ${clientCwd}\n` +
    `</env>\n` +
    `<meridian-note>\n` +
    `You are reached through a proxy. The subprocess running you resides at ` +
    `"${sdkCwd}" on the proxy host, but that is not the user's working directory. ` +
    `Always treat "${clientCwd}" as the working directory when referring to files or paths.\n` +
    `</meridian-note>`
  )
}

/**
 * Correct the provenance claim on the preset's `gitStatus` block.
 *
 * The `claude_code` preset injects a `gitStatus:` section stating verbatim that
 * it is "the git status at the start of the conversation" and "will not update
 * during the conversation". In the real Claude Code CLI that holds: one
 * long-lived process serves the whole conversation, so the snapshot really is
 * from its start.
 *
 * Meridian breaks that invariant. Every turn is a separate HTTP request and a
 * separate `query()`, so the SDK recomputes the block each time while it keeps
 * asserting it is the conversation's starting state. Files the model created in
 * earlier turns therefore reappear as apparently pre-existing work, and the
 * model concludes it overwrote the user's uncommitted changes — #694, where it
 * reported destroying two work-in-progress files it had written itself.
 *
 * Verified live: a file created by a third party after session start appears in
 * the block under the "start of the conversation" caveat, on a session whose
 * lineage is an unbroken continuation chain. This is not a history-loss bug, so
 * the resume fixes (#705, #719) do not address it.
 *
 * Only meaningful alongside the preset — it is the preset that injects the block
 * being corrected — so it is appended in that branch only.
 */
export const GIT_STATUS_PROVENANCE_NOTE =
  `\n\n<meridian-note>\n` +
  `You are reached through a proxy that issues a separate request per turn, so ` +
  `the \`gitStatus\` block in your system prompt is recomputed at the start of ` +
  `every turn — despite its claim to describe "the start of the conversation". ` +
  `Read it as the working tree as of this turn and nothing more. It is not ` +
  `evidence that a file predates the conversation: files you yourself created or ` +
  `edited in earlier turns appear in it exactly like pre-existing changes. To ` +
  `judge whether something predates the conversation, rely on the conversation ` +
  `history and your own prior tool calls, and run \`git status\` when you need ` +
  `the current tree.\n` +
  `</meridian-note>`

function resolveSystemPrompt(
  systemContext: string | undefined,
  passthrough: boolean,
  settingSources: SettingSource[] | undefined,
  codeSystemPrompt: boolean | undefined,
  clientSystemPrompt: boolean | undefined,
  cwdNote: string,
): { systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string } } {
  const hasSettings = settingSources != null && settingSources.length > 0
  const usePreset = codeSystemPrompt ?? (hasSettings || (!passthrough && !!systemContext))
  const includeClient = clientSystemPrompt ?? true
  const clientContext = includeClient ? systemContext : undefined

  if (usePreset) {
    // Always non-empty: the gitStatus correction applies to every preset
    // request, whether or not the client sent a system prompt.
    const append = [clientContext, cwdNote, GIT_STATUS_PROVENANCE_NOTE].filter(Boolean).join("")
    return { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } }
  }
  const append = [clientContext, cwdNote].filter(Boolean).join("") || undefined
  if (append) return { systemPrompt: append }
  // Defensive: when `codeSystemPrompt: false` is explicit and there's
  // nothing to append, force an empty-string system prompt so the SDK
  // can't fall back to the claude_code preset. Returning `{}` would leave
  // `systemPrompt` undefined and let downstream defaults reintroduce the
  // preset. (#489 follow-up — low impact in practice since most callers
  // send a `system` field; belt-and-suspenders for the empty case.)
  if (codeSystemPrompt === false) return { systemPrompt: "" }
  return {}
}

export function buildQueryOptions(ctx: QueryContext, abortController?: AbortController): BuildQueryResult {
  const {
    prompt, model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv, hasDeferredTools,
    resumeSessionId, isUndo, resumeSessionAtUuid, forkSession, sdkHooks, blockedTools, incompatibleTools,
    mcpServerName, allowedMcpTools, onStderr,
    effort, thinking, taskBudget, outputFormat, betas, settingSources, codeSystemPrompt, clientSystemPrompt,
    memory, dreaming, sharedMemory, maxBudgetUsd, fallbackModel, sdkDebug, additionalDirectories,
  } = ctx
  const cwdNote = buildCwdNote(workingDirectory, clientWorkingDirectory)

  const allBlockedTools = [...blockedTools, ...incompatibleTools]

  return {
    prompt,
    options: {
      // Force Node as the executable. The claude-agent-sdk auto-detects Bun
      // via process.versions.bun and defaults to spawning `bun cli.js`.
      // Hosts like OpenCode embed Bun, so the check fires even when `bun`
      // is not in PATH — causing subprocess spawns to fail.
      executable: "node" as const,
      maxTurns: passthrough
        ? computePassthroughMaxTurns(
            hasDeferredTools,
            ctx.advisorModel,
            // Every condition here is one that needs the SDK to keep going
            // past the tool boundary; see computePassthroughMaxTurns.
            ctx.earlyStop !== false && !hasDeferredTools && !ctx.advisorModel && !outputFormat,
          )
        : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(abortController ? { abortController } : {}),
      // Passthrough needs them on BOTH paths, not just streaming: the deny-hold
      // and the early-stop checkpoint both key off the turn-generation boundary,
      // and `message_start`/`message_delta` are the only place it is observable.
      // Without them non-stream releases its holds on the first assistant
      // message and freezes the checkpoint there, so a parallel turn hands the
      // client the first call and silently drops the rest (measured 1 of 3).
      ...(stream || passthrough ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...resolveSystemPrompt(systemContext, passthrough, settingSources, codeSystemPrompt, clientSystemPrompt, cwdNote),
      ...(passthrough
        ? {
            // Strip the SDK's ~25k-token built-in tool catalog from the
            // upstream request. Passthrough mode never intends to invoke
            // SDK built-ins (Read/Write/Bash/etc.) — those are the calling
            // client's responsibility. `disallowedTools` below blocks
            // invocation at runtime; it does NOT remove the definitions
            // from the upstream payload. Setting `tools: []` elides the
            // catalog from the request body. Closes #489 (diagnosis by
            // @albe-jj).
            tools: [],
            disallowedTools: [...allBlockedTools],
            ...(passthroughMcp ? {
              allowedTools: [...passthroughMcp.toolNames],
              mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
            } : {}),
          }
        : {
            disallowedTools: [...allBlockedTools],
            allowedTools: [...allowedMcpTools],
            mcpServers: { [mcpServerName]: createOpencodeMcpServer() },
          }),
      plugins: [],
      // #634: `settings` (the --settings flag domain) is independent of
      // `settingSources` (file domains) — never couple them. The memory
      // controls must reach the SDK even when no setting files are loaded;
      // gating them on settingSources silently re-enabled auto-memory (the
      // SDK's built-in default) whenever claudeMd was "off".
      settings: {
        autoMemoryEnabled: ctx.memory ?? true,
        autoDreamEnabled: ctx.dreaming ?? false,
        // Always explicit, for the same reason as the memory keys above: an
        // omitted key falls back to the subprocess default, which is to run
        // the check. `webFetchPreflight` is the positive form the settings
        // UI shows; the SDK setting is the negative one.
        skipWebFetchPreflight: ctx.webFetchPreflight === false,
      },
      // #634/#490: always explicit. Empty array → SDK emits
      // `--setting-sources=` → subprocess loads nothing. Omitting the key
      // makes claude-code fall back to its built-in default (user + project
      // + local) and slurp CLAUDE.md from the PROXY HOST's cwd into the
      // system prompt regardless of claudeMd:"off" — #490 fixed this for
      // passthrough; this extends the same guarantee to every adapter.
      settingSources: settingSources ?? [],
      ...(onStderr ? { stderr: onStderr } : {}),
      env: {
        // First, so an operator-set value of any kind overrides it.
        ...QUIET_SUBPROCESS_ENV,
        // sharedMemory: the user wants the SDK to use Claude Code's default
        // config dir so memories sync. Counter-intuitively we DON'T set
        // CLAUDE_CONFIG_DIR=$HOME/.claude here — explicitly setting it (even
        // to the default value) changes the SDK's Keychain lookup key and
        // breaks OAuth (issue #453, upstream anthropics/claude-code#20553).
        // Instead, strip any inherited custom CLAUDE_CONFIG_DIR from the
        // profile env so the SDK falls back to its own default. That achieves
        // the "share memory with Claude Code" intent without poisoning
        // Keychain auth.
        ...(sharedMemory ? stripConfigDir(cleanEnv) : cleanEnv),
        ENABLE_TOOL_SEARCH: hasDeferredTools ? "true" : "false",
        // claude.ai connectors: MCP servers attached to the account's
        // claude.ai profile (Drive, Gmail, Calendar, …). The subprocess
        // otherwise fetches them from /v1/mcp_servers and connects each one
        // through mcp-proxy.anthropic.com, so a caller that asked for none of
        // that gets third-party tools in its session. Off unless opted in.
        //
        // Passthrough forces it off regardless: there the CLIENT executes
        // tools, and it cannot run one that only exists inside the subprocess
        // — the same mismatch that made CLAUDE_CODE_USE_POWERSHELL_TOOL a bug
        // (#441). This was the pre-existing behaviour for passthrough; the
        // change is that every other adapter now defaults to it too.
        //
        // Always explicit, never omitted — same reason as the `settings` keys
        // above (#634). Expressing "on" by leaving the variable out would make
        // the opt-in mean "whatever the subprocess defaults to", so an upstream
        // default flip would silently re-enable connectors for everyone who
        // opted in, and silently disable them for everyone who did not.
        ENABLE_CLAUDEAI_MCP_SERVERS:
          !passthrough && ctx.claudeAiConnectors === true ? "true" : "false",
        // Passthrough: suppress the CLI's "# Scratchpad Directory" context
        // block (#627). It advertises a PROXY-HOST path, but the CLIENT
        // executes the tools — OpenCode 1.18+ permission-blocks writes to
        // that alien path (external_directory), dead-ending headless runs.
        // The CLI skips the block when CLAUDE_CODE_SESSION_KIND=bg — its own
        // headless-background mode, which is semantically what this
        // subprocess is. All other "bg" effects are TUI rendering (no TUI
        // here) or CLAUDE_JOB_DIR-gated bookkeeping (we don't set it) —
        // audited against the bundled CLI. Kill switch:
        // MERIDIAN_SUPPRESS_SCRATCHPAD=0. Profile envOverrides spread below
        // and win if the operator sets an explicit value.
        ...(passthrough && process.env.MERIDIAN_SUPPRESS_SCRATCHPAD !== "0"
          ? { CLAUDE_CODE_SESSION_KIND: "bg" }
          : {}),
        // When running as root (Docker, Unraid, NAS), set IS_SANDBOX=1 to
        // bypass the SDK's root check. Without this, the SDK exits with:
        // "--dangerously-skip-permissions cannot be used with root/sudo"
        // See: https://github.com/rynfar/meridian/issues/256
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
        ...ctx.envOverrides,
      },
      ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // A passthrough checkpoint sits immediately before a persisted
      // PreToolUse denial. resumeSessionAt rewinds that tail for one query but
      // does not replace it in the source transcript; forking makes the rewind
      // durable so the client's real tool_result becomes the new ancestry.
      ...(isUndo || forkSession || (passthrough && resumeSessionAtUuid) ? { forkSession: true } : {}),
      ...(resumeSessionAtUuid ? { resumeSessionAt: resumeSessionAtUuid } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking } : {}),
      ...(taskBudget ? { taskBudget } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(betas && betas.length > 0 ? { betas: betas as SdkBeta[] } : {}),
      ...(maxBudgetUsd && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(sdkDebug ? { debug: true } : {}),
      ...(additionalDirectories && additionalDirectories.length > 0 ? { additionalDirectories } : {}),
      ...(ctx.advisorModel ? { advisorModel: ctx.advisorModel } : {}),
    }
  }
}
