/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Content block types that contribute nothing to the lineage hash.
 *
 * Thinking blocks are model-emitted reasoning. Their `signature` is an opaque,
 * high-entropy, per-generation blob, and `redacted_thinking` carries only
 * opaque `data` — none of it identifies the conversation prefix, which is the
 * only question the hash exists to answer.
 *
 * They are dropped entirely rather than reduced to their text, because the
 * failure mode is a client that stops echoing thinking blocks once a tool loop
 * finishes — a common pattern, since only the active loop strictly needs them.
 * Hashing `thinking:<text>` would still change that message's hash the moment
 * the block disappears; contributing nothing is what makes the hash stable
 * across its presence, absence, and any re-signature (#710).
 *
 * Deliberate trade-off: two prefixes differing ONLY in thinking now hash alike.
 * That is correct — thinking always accompanies the same text and tool calls in
 * its own turn, and those are still hashed, so it never distinguishes two
 * genuinely different prefixes on its own.
 */
export const HASH_IGNORED_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"])

/**
 * Block types with an explicit case in {@link normalizeContent}, hashed on
 * their semantic fields only.
 */
export const HASH_HANDLED_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result"])

/**
 * Block types deliberately serialized whole by the fallback.
 *
 * Reviewed against `ContentBlockParam` and confirmed to carry no
 * per-generation opaque field: their payloads (`source`, `content`, `title`,
 * `file_id`) are stable for the same logical content, so serializing them is
 * safe. `cache_control` is stripped separately.
 *
 * The `*_tool_use` / `*_tool_result` entries reference `id` / `tool_use_id`,
 * which ARE per-generation — but that matches how `tool_use` and `tool_result`
 * are already hashed, and clients echo the same ids back. Same accepted risk,
 * not a new one.
 *
 * Membership here is a decision, not a default. `sdk-block-type-coverage`
 * fails when the installed SDK adds a type absent from all three sets, so a
 * new block type cannot silently land in the fallback the way `thinking` did
 * (#710).
 */
export const HASH_SERIALIZED_BLOCK_TYPES = new Set([
  "image",
  "document",
  "search_result",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "container_upload",
])

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * Used only for lineage hashing — see {@link HASH_IGNORED_BLOCK_TYPES}, which
 * drops content a display-oriented normalizer would need to keep.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    // Filtered, not mapped to "": an empty segment would still leave its
    // newline behind and churn the hash exactly as the raw block did.
    return content.filter((block: any) => !HASH_IGNORED_BLOCK_TYPES.has(block?.type)).map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract the advisor model from a tools array.
 * Returns the model string if an advisor tool definition is found, undefined otherwise.
 * The advisor tool is identified by a type starting with "advisor_".
 */
export function extractAdvisorModel(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const candidate = tool as Record<string, unknown>
    if (typeof candidate.type === "string" && candidate.type.startsWith("advisor_") && typeof candidate.model === "string" && candidate.model.length > 0) {
      return candidate.model
    }
  }
  return undefined
}

/**
 * Remove advisor tool definitions from a tools array.
 * Returns a new array with advisor tools filtered out.
 */
export function stripAdvisorTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true
    const candidate = tool as Record<string, unknown>
    return !(typeof candidate.type === "string" && candidate.type.startsWith("advisor_"))
  })
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}

/**
 * Frame a fresh-session replay so the model cannot pattern-continue it (#619).
 *
 * When a conversation falls off the resume path, its full history is
 * flattened into one text prompt. Even with the anti-imitation turn markers
 * (plain user turns, bracketed `[Assistant: ...]` — the #496 fix), a long
 * replayed transcript still invites the model to continue the *format*
 * rather than answer the user: self-played turns, confabulated tool output.
 *
 * This wraps everything before the final user turn in an explicit
 * `<conversation_history>` envelope with a context-only instruction, and
 * presents the final user message separately as the live prompt — mirroring
 * the structure the OpenAI-compat path has always used. Single-turn prompts
 * and histories that don't end with a user turn are returned as a plain
 * join (nothing to separate).
 */
export function frameReplayTurns(turns: Array<{ role: string; text: string }>): string {
  const nonEmpty = turns.filter((t) => t.text)
  const joined = nonEmpty.map((t) => t.text).join("\n\n")
  if (nonEmpty.length < 2) return joined
  const last = nonEmpty[nonEmpty.length - 1]!
  if (last.role !== "user") return joined
  const history = nonEmpty.slice(0, -1).map((t) => t.text).join("\n\n")
  return (
    `<conversation_history>\n${history}\n</conversation_history>\n\n` +
    `The above is a replay of your prior conversation with this user — the original session could not be resumed. ` +
    `It is context only: do not continue or imitate its transcript format, do not write "[Assistant: ...]" markers, ` +
    `and never invent tool output — use your actual tools when action is needed. ` +
    `Respond only as the assistant to the user's message below.\n\n` +
    last.text
  )
}

/**
 * Lead-in for a passthrough continuation that forks from a deny boundary.
 *
 * Every forwarded tool call is denied with "do not generate further text —
 * end your turn now" (the nudge that stops the model fabricating results for
 * calls the client will execute). That deny is persisted as the tool_result,
 * and the deny boundary fork puts it IMMEDIATELY before the continuation's
 * user turn. So the last instruction in the model's context tells it to emit
 * no text — and the next thing it must do is answer. Observed live: the model
 * obeys the nearer instruction and returns thinking plus an EMPTY text block
 * with stop_reason "end_turn"; the CLI's own "previous response had no visible
 * output" nudge does not help, because the deny is still there. The proxy
 * forwards zero text deltas, reports 200, and the client's run goes quiet with
 * the tool results unanswered (three occurrences in 500 requests, all on a
 * session's second turn — where the deny is the largest thing in context).
 *
 * The deny cannot be rewritten after the fact: it lives in the CLI's session
 * file. So the continuation says plainly that the instruction is spent. Framing
 * only — no transcript markers, nothing for the model to imitate (#496/#619).
 */
export const PASSTHROUGH_CONTINUATION_LEAD_IN =
  "The tool calls from your previous turn were forwarded to the client, which has now executed them — " +
  "their results follow. The instruction to end that turn without further text applied to it alone and " +
  "is now discharged: continue the work and respond."

/**
 * Prefix a passthrough continuation delta with the lead-in above.
 *
 * An empty delta is returned unchanged — there is nothing to answer, so the
 * lead-in would be the only content and would read as the user's own turn.
 */
export function framePassthroughContinuation(delta: string): string {
  if (!delta) return delta
  return `${PASSTHROUGH_CONTINUATION_LEAD_IN}\n\n${delta}`
}

/**
 * Remove fields the Claude Agent SDK attaches to streamed events that are not
 * part of the public Anthropic streaming schema.
 *
 * The SDK adds `context_management` (advisory metadata about upstream context
 * edits) to `message_delta`. The real Anthropic API does not return it on a
 * normal (non-beta) request, and stock clients — e.g. langchain-anthropic —
 * assume any present field is a typed SDK model and call `.model_dump()` on it,
 * crashing on the raw dict (#525). The context edit already happened upstream,
 * so the field is safe to drop.
 *
 * Mutates and returns the event for convenient inline use in the SSE forward
 * path; a no-op when the field is absent, so it is safe to call on every event.
 */
export function stripNonStandardStreamFields<T>(event: T): T {
  if (event && typeof event === "object") {
    const e = event as Record<string, unknown>
    delete e.context_management
    const delta = e.delta
    if (delta && typeof delta === "object") {
      delete (delta as Record<string, unknown>).context_management
    }
  }
  return event
}

/** Content block types that carry non-text data the model must "see". */
export const MULTIMODAL_TYPES = new Set(["image", "document", "file"])

/**
 * Consolidate multimodal blocks (image/document/file) from earlier user turns
 * onto the final user turn of a structured (AsyncIterable) prompt.
 *
 * When the Claude Agent SDK is handed multiple user messages as a streaming
 * iterable, it only surfaces multimodal blocks from the LAST user turn to the
 * model — images sitting in earlier turns (e.g. an image a `read` tool returned
 * mid-conversation) are silently dropped, and the model answers "I cannot see
 * the image" (#553). Moving those blocks onto the final array-content user turn
 * makes them visible; accompanying text is left in place.
 *
 * Notes:
 *  - The target is the last entry whose `message.content` is an ARRAY. Flattened
 *    assistant turns are string content and can never hold image blocks, so a
 *    conversation ending on an assistant turn still lands images on the last
 *    real user turn.
 *  - Blocks structurally identical to ones already on the target are not
 *    re-appended (avoids duplicating a client-re-attached image).
 *
 * Pure: returns a new array; the input and its messages are not mutated. No-op
 * when there are fewer than two array-content user turns or nothing to carry.
 */
export function consolidateMultimodalOntoLastUser<
  T extends { message: { content: unknown } }
>(structured: T[]): T[] {
  let targetIdx = -1
  for (let i = structured.length - 1; i >= 0; i--) {
    if (Array.isArray(structured[i]!.message.content)) {
      targetIdx = i
      break
    }
  }
  if (targetIdx < 0) return structured

  const carried: unknown[] = []
  const result = structured.map((entry, i) => {
    const content = entry.message.content
    if (i === targetIdx || !Array.isArray(content)) return entry
    const kept = content.filter((block: any) => {
      if (block && typeof block === "object" && MULTIMODAL_TYPES.has(block.type)) {
        carried.push(block)
        return false
      }
      return true
    })
    if (kept.length === content.length) return entry
    return { ...entry, message: { ...entry.message, content: kept } }
  })

  if (carried.length === 0) return structured

  const target = result[targetIdx]!
  const existing = target.message.content as unknown[]
  const seen = new Set(existing.map((b) => JSON.stringify(b)))
  const toAppend = carried.filter((b) => {
    const key = JSON.stringify(b)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  result[targetIdx] = {
    ...target,
    message: { ...target.message, content: [...existing, ...toAppend] },
  }
  return result
}

/** A tool call the assistant made earlier in the conversation. */
export interface ToolCallInfo {
  name: string
  /** Compact human-readable target (file path, command, pattern...), if any. */
  target: string | undefined
  /**
   * For mutating tools (edit/write/multiedit): a truncated summary of the
   * content the call produced. On fresh replay the assistant's tool_use
   * blocks are dropped, so without this the model knows THAT it edited a
   * file but not WHAT it wrote — it then re-derives near-duplicate edits
   * and confabulates a parallel editor when it doesn't recognize its own
   * wording (#496 follow-up, stefanpartheym's transcript).
   */
  contentSummary: string | undefined
}

/**
 * Input keys that identify what a tool call operated on, in priority order.
 *
 * `code` covers tools whose whole payload is a program rather than a path or a
 * shell line — Prime Agent's `ipython`, and notebook/REPL tools generally. Its
 * omission was not cosmetic: with no matching key the target is undefined and
 * `extractContentSummary` has no case either, so EVERY call from such a tool
 * replayed as the same bare `[your ipython]`. The model could not tell which
 * cell produced which result, nor that it had already run one, and re-ran the
 * first cell indefinitely (observed: `2+2` seven times in one turn).
 */
const TOOL_TARGET_KEYS = ["filePath", "file_path", "path", "command", "code", "pattern", "query", "url"] as const

/** Max length of a replayed target label, including the "..." marker. */
const TOOL_TARGET_MAX = 80

/** Max length of a replayed content summary (before the "..." marker). */
const CONTENT_SUMMARY_MAX = 120

/**
 * Normalize a tool-call target for the single-line `[your bash …]` label.
 *
 * Collapsing whitespace is what keeps the attribution on one line. A
 * multi-line value — a heredoc, a `&&` chain split across lines, an `ipython`
 * cell — previously embedded raw newlines straight into the replayed prompt,
 * breaking the compact bracketed shape that #111/#386 depend on for the model
 * to read it as context rather than as tool syntax to imitate.
 *
 * Truncation math is unchanged from the original inline slice (77 + "..." =
 * 80), so labels that were already single-line render byte-identically.
 */
function normalizeTarget(value: string): string | undefined {
  const collapsed = value.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  return collapsed.length > TOOL_TARGET_MAX
    ? collapsed.slice(0, TOOL_TARGET_MAX - 3) + "..."
    : collapsed
}

/** Collapse whitespace runs to single spaces and truncate. */
function summarizeContent(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  const collapsed = value.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  return collapsed.length > CONTENT_SUMMARY_MAX ? collapsed.slice(0, CONTENT_SUMMARY_MAX) + "..." : collapsed
}

/**
 * Extract a content summary for mutating tools. Non-mutating tools (read,
 * bash, grep, ...) return undefined — their target alone identifies the call.
 */
function extractContentSummary(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const rec = input as Record<string, unknown>
  switch (name.toLowerCase()) {
    case "edit":
      return summarizeContent(rec.newString ?? rec.new_string)
    case "write":
      return summarizeContent(rec.content)
    case "multiedit": {
      const edits = rec.edits
      if (!Array.isArray(edits) || edits.length === 0) return undefined
      const first = edits[0] as Record<string, unknown> | null | undefined
      const firstSummary = summarizeContent(first?.newString ?? first?.new_string)
      if (!firstSummary) return undefined
      return edits.length > 1 ? `${edits.length} edits; first: ${firstSummary}` : firstSummary
    }
    default:
      return undefined
  }
}

/**
 * Index every assistant tool_use block in a conversation by id.
 *
 * Used to attribute tool_result blocks during full-history replay: the
 * flattened replay drops assistant tool_use blocks (issues #111/#386 — verbose
 * `[Tool Use: ...]` strings taught the model to imitate fake tool syntax), so
 * without attribution the model sees raw tool outputs as bare user text with
 * no cause — it then denies having made the calls at all ("a file I never
 * created", #552).
 */
export function buildToolUseIndex(
  messages: Array<{ role: string; content: any }>
): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>()
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block?.type !== "tool_use" || !block.id || typeof block.name !== "string") continue
      let target: string | undefined
      const input = block.input
      if (input && typeof input === "object") {
        for (const key of TOOL_TARGET_KEYS) {
          const v = (input as Record<string, unknown>)[key]
          if (typeof v === "string" && v) {
            target = normalizeTarget(v)
            if (target) break
          }
        }
      }
      index.set(block.id, {
        name: block.name,
        target,
        contentSummary: extractContentSummary(block.name, input),
      })
    }
  }
  return index
}

/**
 * Render a compact attribution label for a replayed tool result, e.g.
 * `[write tmp/test2.txt]`, `[bash echo hi]`, or — for mutating tools —
 * `[edit a.yml → "# Ignore major bumps..."]` so the model can recognize its
 * own prior work product on replay. Deliberately terse and bracket-formatted
 * differently from the banned `[Tool Use: ...]` / `[Tool Result ...]` shapes
 * (#111/#386) so the model reads it as context, not as tool-call syntax to
 * imitate.
 */
export function describeToolCall(info: ToolCallInfo): string {
  // "your" marks agency: the replay drops the assistant turn that made the
  // call, so the attribution sits inside a USER turn — without an explicit
  // owner the model reads it as someone else's action and answers
  // "I haven't made any edits in this conversation" (verified live).
  const head = info.target ? `your ${info.name} ${info.target}` : `your ${info.name}`
  return info.contentSummary ? `[${head} → "${info.contentSummary}"]` : `[${head}]`
}

/**
 * Flatten an Anthropic `system` field into the text Meridian forwards as the
 * SDK subprocess's system prompt.
 *
 * Not every block in that array is an instruction. Claude Code passes
 * transport metadata through the same field — its `system` arrives as:
 *
 *   [0] "x-anthropic-billing-header: cc_version=2.1.220.8b8; cc_entrypoint=sdk-cli;"
 *   [1] "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *   [2] <the actual system prompt>
 *
 * Block [0] is a header the client smuggles through the body, not something
 * anyone wrote for a model to read. Joining every block verbatim puts it at
 * the top of the subprocess's system prompt, where it is at best noise the
 * model has to skip past.
 *
 * It is also meaningless downstream: Meridian's subprocess authenticates as
 * its own subscription and sends its own billing header, so the client's copy
 * describes a request that is never made.
 *
 * The filter anchors at the start of a block, so a prompt that merely
 * discusses such a header in prose is left alone.
 *
 * Pure: never mutates the input.
 */
const TRANSPORT_HEADER_BLOCK = /^\s*x-anthropic-[a-z0-9-]*header\s*:/i

export function extractSystemText(system: unknown): string {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text)
    .map((b: any) => b.text as string)
    .filter((text) => !TRANSPORT_HEADER_BLOCK.test(text))
    .join("\n")
}
