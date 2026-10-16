/**
 * Claude Code agent adapter.
 *
 * Claude Code (claude-cli) is unusual among meridian clients in two ways:
 *   1. It typically runs on a different machine than the proxy (pointing at
 *      ANTHROPIC_BASE_URL over the network), so its CWD doesn't exist on the
 *      proxy host.
 *   2. It states its working directory as `Primary working directory: <path>`
 *      inside a `# Environment` block — different from OpenCode's
 *      `<env>Working directory: <path></env>` — which older clients put in the
 *      system prompt and 2.1.290 sends among the messages.
 *
 * Consequently this adapter:
 *   - Returns `undefined` from extractWorkingDirectory so the SDK subprocess
 *     chdirs into `process.cwd()` (a valid server path) rather than the
 *     client's local filesystem layout.
 *   - Parses the client's local CWD via extractClientWorkingDirectory for
 *     fingerprinting and a system-prompt hint (see server.ts + query.ts).
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"
import { resolvePassthrough } from "../../env"
import { isClaudeCodeProgressSummary } from "./claudecodeProgress"

/**
 * Extract Claude Code's client-local working directory from the request.
 * Claude Code states it in a block like:
 *
 *   # Environment
 *   You have been invoked in the following environment:
 *    - Primary working directory: /Users/alice/projects/myapp
 *    - ...
 *
 * NOTE: agent-specific (claude-code). Where the block is has moved. Older
 * clients put it in the system prompt. 2.1.290 sends it as a `system` message
 * after the first user message for a model that takes system turns, and as a
 * `<system-reminder>` block opening the first user message for one that does
 * not (Haiku 4.5). Read from the system prompt alone, no request of that
 * client had a directory: the SDK subprocess ran in the proxy's own, and the
 * prompt told the model the client's was unknown, so the model composed paths
 * against the proxy's tree.
 *
 * The first block of the conversation is the one. The SDK session is filed
 * under the directory it was created in, so a conversation whose directory
 * changed part-way could not be resumed. Among the messages only the client's
 * own framing is read: `system` turns, and the run of reminder blocks that
 * opens the first user message. Nothing the user typed, the assistant said or
 * a tool returned is read.
 *
 * Returns the path if found, or undefined to fall back to the SDK CWD.
 */
function extractClaudeCodeClientCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body?.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body?.system)) {
    systemText = body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  const fromSystemPrompt = systemText.match(/Primary working directory:\s*([^\n<]+)/i)?.[1]?.trim()
  if (fromSystemPrompt) return fromSystemPrompt

  if (!Array.isArray(body?.messages)) return undefined
  let firstUserMessageSeen = false
  for (const message of body.messages) {
    let texts: string[] = []
    if (message?.role === "system") {
      texts = textBlocksOf(message.content)
    } else if (message?.role === "user" && !firstUserMessageSeen) {
      firstUserMessageSeen = true
      texts = Array.isArray(message.content) ? leadingReminderTexts(message.content) : []
    }
    for (const text of texts) {
      const found = text.match(ENVIRONMENT_BLOCK_CWD)?.[1]?.trim()
      if (found) return found
    }
  }
  return undefined
}

/** The environment block as the client writes it among the messages. */
const ENVIRONMENT_BLOCK_CWD =
  /(?:^|\n)# Environment\nYou have been invoked in the following environment:[ \t]*\n[ \t]*- Primary working directory:[ \t]*([^\n<]+)/
const SYSTEM_REMINDER_OPEN = "<system-reminder>"

/**
 * The reminder blocks the client opens a user message with: text blocks up to
 * the first text block that is not a reminder. What follows is what the user
 * typed, even when it looks like a reminder.
 */
function leadingReminderTexts(content: unknown[]): string[] {
  const reminders: string[] = []
  for (const text of textBlocksOf(content)) {
    if (!text.startsWith(SYSTEM_REMINDER_OPEN)) break
    reminders.push(text)
  }
  return reminders
}

/** The text of a message's content: the string itself, or its top-level text blocks. */
function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    const candidate = block as { type?: unknown; text?: unknown } | null
    return candidate?.type === "text" && typeof candidate.text === "string" ? [candidate.text] : []
  })
}

/**
 * Session identity declared in `metadata.user_id`.
 *
 * `sessionId` is the whole of the session key — nothing is appended, prefixed,
 * or normalized — because it is what every cached mapping is already stored
 * under. `parentSessionId` is additive: a client that does not stamp it gets
 * exactly the identity it got before the field existed.
 */
export interface ClaudeCodeSessionIdentity {
  readonly sessionId: string
  /**
   * The IMMEDIATE parent's session id, when the client declares subagent
   * lineage. Deeper trees are expressed by each level naming its own parent, so
   * consumers walk the chain rather than expecting a root here.
   */
  readonly parentSessionId?: string
}

/**
 * Parse the identity envelope Claude Code (and Prime Agent's extension) embeds
 * in `metadata.user_id`.
 *
 * Strict by design: `user_id` must be, or parse to, an object carrying a
 * non-empty string `session_id`. Anything else yields undefined and the caller
 * falls back to fingerprint resume, so unrelated Anthropic-API clients that put
 * their own value in `user_id` are never mistaken for a keyed session.
 */
export function extractClaudeCodeSessionIdentity(body: unknown): ClaudeCodeSessionIdentity | undefined {
  if (!body || typeof body !== "object") return undefined

  const metadata = (body as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return undefined

  const rawUserId = (metadata as { user_id?: unknown }).user_id
  let userMetadata: unknown = rawUserId

  if (typeof rawUserId === "string") {
    try {
      userMetadata = JSON.parse(rawUserId)
    } catch {
      return undefined
    }
  }

  if (!userMetadata || typeof userMetadata !== "object") return undefined
  const sessionId = (userMetadata as { session_id?: unknown }).session_id
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined

  const parentSessionId = (userMetadata as { parent_session_id?: unknown }).parent_session_id
  // A node that names itself as its own parent is not a tree edge, and treating
  // it as one would make a request its own cancellation target.
  const parent = typeof parentSessionId === "string"
    && parentSessionId.length > 0
    && parentSessionId !== sessionId
    ? parentSessionId
    : undefined

  return parent ? { sessionId, parentSessionId: parent } : { sessionId }
}

/** Extract the stable conversation ID embedded by Claude Code in metadata.user_id. */
export function extractClaudeCodeSessionId(body: unknown): string | undefined {
  return extractClaudeCodeSessionIdentity(body)?.sessionId
}

/** Extract the immediate parent session key, when the client declares lineage. */
export function extractClaudeCodeParentSessionId(body: unknown): string | undefined {
  return extractClaudeCodeSessionIdentity(body)?.parentSessionId
}

/** The agent context Claude Code runs a request under; absent on the main conversation. */
export const CLAUDE_CODE_AGENT_ID_HEADER = "x-claude-code-agent-id"

/** Agent ids are short opaque tokens. Anything else is ignored, never keyed. */
const CLAUDE_CODE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The session key for one Claude Code request.
 *
 * NOTE: agent-specific (claude-code). An Agent-tool subagent sends its parent
 * conversation's `metadata.user_id` session id while running a multi-turn
 * conversation of its own, and background subagents overlap the parent's
 * turns. Under one key each history read as `unrelated-history` to the other,
 * so neither resumed, and both queued on one turn lease. The CLI stamps
 * `x-claude-code-agent-id` on every subagent request — stable across that
 * subagent's turns, distinct between subagents, and sent without gateway hint
 * headers (verified against 2.1.287) — so a subagent is keyed
 * `<sid>:agent:<agentId>`. The main conversation, and any request whose agent
 * id is missing or malformed, keeps the bare session id. An agent id never
 * creates a key on its own: without a metadata session id there is none.
 *
 * A backgrounded main session (and a fork-of-main subagent) also gets a fresh
 * agent id but carries the whole transcript, so its first request under the
 * new key is one full-history replay; later turns resume on that key.
 */
export function claudeCodeSessionKey(agentId: string | undefined, body: unknown): string | undefined {
  const sessionId = extractClaudeCodeSessionId(body)
  if (sessionId === undefined) return undefined
  if (agentId === undefined || !CLAUDE_CODE_AGENT_ID.test(agentId)) return sessionId
  return `${sessionId}:agent:${agentId}`
}

/** Claude Code's own request classification (`main`, `auxiliary`, `compaction`, …). */
export const CLAUDE_CODE_REQUEST_CLASS_HEADER = "x-claude-code-request-class"

/** The auto-mode classifier's XML verdicts end at these tags. */
const CLASSIFIER_STOP_SEQUENCES = new Set(["</block>", "</severity>"])

/**
 * Interactive Claude Code generates a session title on the first user turn via
 * its streamed `toolFreeHelper` side-query path (`querySource:
 * "generate_session_title"`): `stream: true`, no tools, one `user` message
 * wrapping the prompt in `<session>…</session>` followed by the language
 * instruction, and the session-naming system prompt block.
 */
const SESSION_TITLE_SYSTEM_PREFIX =
  "You are naming a coding session so the user can pick it out of a long list of sessions."
const SESSION_TITLE_SYSTEM_SUFFIX =
  'Return JSON with a single "title" field. Capitalize the first letter of the title.'
const SESSION_TITLE_DEFAULT_INSTRUCTION =
  "\n</session>\n\nWrite the title in the predominant language of the session — a stray word or code token in another language doesn't change it, and neither does the English of these instructions."
const SESSION_TITLE_LANGUAGE_INSTRUCTION =
  /\n<\/session>\n\nWrite the title in [^\r\n]+\. Keep technical terms and code identifiers in their original form\.$/

function isSessionTitleSystemText(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith(SESSION_TITLE_SYSTEM_PREFIX)
    || trimmed.includes(`\n${SESSION_TITLE_SYSTEM_PREFIX}`)
  ) && trimmed.endsWith(SESSION_TITLE_SYSTEM_SUFFIX)
}

function hasSessionTitleSystemPrompt(system: unknown): boolean {
  if (typeof system === "string") return isSessionTitleSystemText(system)
  if (!Array.isArray(system)) return false
  return system.some(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
    const block = entry as { type?: unknown; text?: unknown }
    return block.type === "text" && typeof block.text === "string" && isSessionTitleSystemText(block.text)
  })
}

function isSessionTitleUserPrompt(text: string): boolean {
  if (!text.startsWith("<session>\n")) return false
  const rest = text.slice("<session>\n".length)
  if (rest.endsWith(SESSION_TITLE_DEFAULT_INSTRUCTION)) {
    return rest.length > SESSION_TITLE_DEFAULT_INSTRUCTION.length
  }
  const match = SESSION_TITLE_LANGUAGE_INSTRUCTION.exec(rest)
  return match !== null && match.index > 0
}

function isClaudeCodeSessionTitleRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false
  const request = body as {
    stream?: unknown
    tools?: unknown
    system?: unknown
    messages?: unknown
  }
  if (request.stream !== true) return false
  if (Array.isArray(request.tools) && request.tools.length > 0) return false
  if (!hasSessionTitleSystemPrompt(request.system)) return false
  if (!Array.isArray(request.messages) || request.messages.length !== 1) return false
  const first = request.messages[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return false
  const message = first as { role?: unknown; content?: unknown }
  if (message.role !== "user") return false
  if (typeof message.content === "string") return isSessionTitleUserPrompt(message.content)
  if (!Array.isArray(message.content) || message.content.length !== 1) return false
  const block = message.content[0]
  if (!block || typeof block !== "object" || Array.isArray(block)) return false
  const textBlock = block as { type?: unknown; text?: unknown }
  return textBlock.type === "text" && typeof textBlock.text === "string" && isSessionTitleUserPrompt(textBlock.text)
}

/**
 * Is this a Claude Code side call under the conversation's session id?
 *
 * NOTE: agent-specific (claude-code). The CLI sends several side calls with the
 * conversation's own `metadata.user_id` session id and a short transcript of
 * their own: the auto-mode permission classifier, the classifier that sums up
 * the session's state ("Current state: … / Assistant message tail …"), and the
 * interactive session-title generator (`generate_session_title`). Read as a
 * turn, each classifies `unrelated-history` and overwrites the conversation's
 * mapping, so the next real turn cannot resume.
 *
 * The CLI names its request class in `x-claude-code-request-class`, but sends
 * it only with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, to a first-party base URL,
 * or under a remote flag — through Meridian it is normally absent. When present
 * it decides outright. Otherwise the shape does: a session key, no tools, and
 * not streamed. Both classifiers go through the CLI's unstreamed side-query
 * helper without tools, while the conversation loop streams its turns and
 * keeps their tools when it retries one unstreamed. The interactive
 * session-title generator streams through `toolFreeHelper` and is matched by
 * its exact system prompt and `<session>…</session>` user envelope; compaction
 * and main turns fall outside both shapes.
 *
 * Other clients can reach this adapter with the same tool-less unstreamed
 * shape for real turns, so the shape alone counts only for a request from the
 * CLI itself (`fromCli`, see isClaudeCodeClient). Otherwise it also needs a
 * stop sequence closing the auto-mode classifier's verdict tag; if a future CLI
 * changes those, detection falls back to treating the request as a turn rather
 * than isolating a real one. An identified
 * subagent's streaming progress caption has its own narrow shape in
 * claudecodeProgress; it must also stay out of the working mapping.
 */
export function isClaudeCodeAuxiliaryRequest(
  requestClass: string | undefined,
  body: unknown,
  agentId?: string,
  fromCli = false,
): boolean {
  if (requestClass !== undefined) return requestClass === "auxiliary"
  if (!body || typeof body !== "object") return false
  if (extractClaudeCodeSessionId(body) === undefined) return false
  if (agentId !== undefined && CLAUDE_CODE_AGENT_ID.test(agentId) && isClaudeCodeProgressSummary(body)) return true
  if (agentId === undefined && isClaudeCodeSessionTitleRequest(body)) return true
  const request = body as { tools?: unknown; stream?: unknown; stop_sequences?: unknown }
  if (Array.isArray(request.tools) && request.tools.length > 0) return false
  if (request.stream === true) return false
  if (fromCli) return true
  return Array.isArray(request.stop_sequences)
    && request.stop_sequences.some(stop => typeof stop === "string" && CLASSIFIER_STOP_SEQUENCES.has(stop))
}

/**
 * Is this request from the Claude Code CLI, whatever adapter is handling it?
 *
 * Claude Code sends `x-claude-code-session-id` on every request — verified
 * against 2.1.266 that it is the CLI session UUID, pinned exactly by
 * `--session-id`. No other client sends it, so it identifies the client even
 * when a gateway has rewritten the User-Agent and the LiteLLM heuristic has
 * already claimed the request.
 *
 * This answers "who owns the tool loop", not "which adapter should run". The
 * header is deliberately NOT used for adapter selection: routing gateway
 * traffic to the claude-code adapter would swap tool handling, MCP naming and
 * prompt shape for every existing LiteLLM user and move their cache prefix.
 *
 * It is also NOT a session key. The CLI reuses one session id across the
 * auxiliary requests it makes alongside a conversation, so keying on it puts
 * two unrelated histories under one key — measured live as
 * `unrelated-history` and an HTTP 400 concurrent conflict, i.e. a hard failure
 * where there had only been a silent inefficiency. See
 * `scripts/e2e-passthrough-claude-code-session.mjs`, which guards that.
 */
export function isClaudeCodeClient(c: Context): boolean {
  return Boolean(c.req.header("x-claude-code-session-id"))
}

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  /**
   * NOTE: agent-specific (claude-code) — Headless Claude Code (`claude -p "..."`)
   * sends a session-start side request (`tools=0`, single user message) and the
   * primary turn (`tools=24`, message count 2) concurrently under the same
   * session id (`metadata.user_id: {"session_id": "..."}`) (#1043). The client
   * has no per-flow signal or plugin header. Whichever request commits first
   * advances the mapping, so the other arrives holding a branch that no longer
   * matches. Setting `runsConcurrentTurnsPerSessionKey: true` allows the loser
   * of that race to be reclassified as a fresh replay rather than refused with
   * HTTP 400 `session_turn_conflict`.
   */
  runsConcurrentTurnsPerSessionKey: true,

  /** NOTE: Claude Code-specific. Its environment belongs to the remote client. */
  clientEnvironmentMayDifferFromProxy: true,

  /**
   * Claude Code embeds its conversation ID in metadata.user_id rather than a
   * session-affinity header; an Agent-tool subagent adds its agent id (see
   * `claudeCodeSessionKey`). Fall back to fingerprint resume when absent.
   */
  getSessionId(c: Context, body?: unknown): string | undefined {
    return claudeCodeSessionKey(c.req.header(CLAUDE_CODE_AGENT_ID_HEADER), body)
  },

  /**
   * Subagent lineage from the same envelope that supplied the session key, so
   * a declared parent always names a key derived the same way this one was.
   */
  getParentSessionId(_c: Context, body?: unknown): string | undefined {
    return extractClaudeCodeParentSessionId(body)
  },

  /**
   * The conversation's own `metadata.user_id` session id: the key its main
   * requests use, and the root its Agent-tool subagents (keyed apart by agent
   * id) share for account routing.
   */
  getRootSessionId(_c: Context, body?: unknown): string | undefined {
    return extractClaudeCodeSessionId(body)
  },

  /** See `isClaudeCodeAuxiliaryRequest`. */
  isAuxiliaryRequest(c: Context, body?: unknown): boolean {
    return isClaudeCodeAuxiliaryRequest(
      c.req.header(CLAUDE_CODE_REQUEST_CLASS_HEADER),
      body,
      c.req.header(CLAUDE_CODE_AGENT_ID_HEADER),
      isClaudeCodeClient(c),
    )
  },

  /**
   * Claude Code is remote relative to the proxy. Do not use its local path
   * as the SDK subprocess cwd — return undefined so the resolver falls back
   * to MERIDIAN_WORKDIR / process.cwd() (a valid path on the proxy host).
   */
  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  /**
   * Used for fingerprint bucketing and the system-prompt CWD hint.
   */
  extractClientWorkingDirectory(body: any): string | undefined {
    return extractClaudeCodeClientCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return ALLOWED_MCP_TOOLS
  },

  getCoreToolNames(): readonly string[] {
    // Claude Code ships a Read/Write/Bash/etc. toolkit much like OpenCode.
    return ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
  },

  usesPassthrough(): boolean {
    // Claude Code owns its own tool execution client-side; default to
    // passthrough so tool_use blocks flow back to the CLI.
    return resolvePassthrough(true)
  },

  supportsThinking(): boolean {
    return true
  },

  /**
   * Claude Code surfaces its own file edits in its UI; suppress meridian's
   * synthetic "Files changed:" block to avoid duplication.
   */
  shouldTrackFileChanges(): boolean {
    return false
  },

  /**
   * Map Claude Code tool_use blocks to file changes. Claude Code uses
   * PascalCase tool names (Read, Write, Edit, Bash) with file_path input.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.file_path ?? input?.filePath ?? input?.path

    const lowerName = toolName.toLowerCase()
    if (lowerName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if ((lowerName === "edit" || lowerName === "multiedit") && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (lowerName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
