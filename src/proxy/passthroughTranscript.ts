/**
 * Passthrough transcript repair — one call, one answer, the real one.
 *
 * In passthrough the CLIENT executes tools. The PreToolUse hook denies every
 * forwarded call, and the CLI writes that denial into the session JSONL as
 * the call's `tool_result`. The client's real result arrives on the next
 * request and is appended as a second answer for the same `tool_use_id`.
 *
 * `resumeSessionAt` does not remove the denial: it cuts a suffix, so it only
 * ever drops the CURRENT turn's rows. On the resume after that the CLI loads
 * the transcript by walking the parentUuid chain from the newest leaf and
 * then splices back any tool_result whose parent is an on-chain assistant —
 * a recovery pass written for parallel siblings that cannot tell a stale
 * denial from one. Both answers are now in the loaded history, the CLI keeps
 * the FIRST tool_result per id, and the model is sent the denial with the
 * real result gone. Measured with scripts/probe-passthrough-accumulation.mjs:
 * by the third turn the model reports "forwarded to client, no content
 * returned" for calls whose output it was handed a turn earlier.
 *
 * The repair rewrites each denial IN PLACE with the real result before the
 * resume starts. No row is added or removed and no uuid, parentUuid or leaf
 * hint changes, so none of the loader's topology handling is exercised —
 * deleting the row instead breaks the resume, because the `last-prompt`
 * leaf hint the loader starts from points at it. After the rewrite the
 * transcript has the plain-API shape: tool_use, then its real result.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The hook's reason for a forwarded call. Also the marker a denial row carries. */
export const PASSTHROUGH_DENY_REASON =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."

/** A client-supplied real result for a forwarded call. */
export interface DeliveredToolResult {
  tool_use_id: string
  content: unknown
  is_error?: boolean
}

type Block = { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; [k: string]: unknown }
/**
 * A transcript row. Beside the message, the CLI stamps a denial row with
 * `toolDenialKind` and mirrors the denial text into `toolUseResult`; a row it
 * writes for a real result carries neither.
 */
type Row = { type?: string; message?: { content?: unknown }; toolDenialKind?: unknown; toolUseResult?: unknown; [k: string]: unknown }

function blockText(block: Block): string {
  if (typeof block.content === "string") return block.content
  if (Array.isArray(block.content)) {
    return block.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
  }
  return ""
}

/**
 * The CLI's answer to a call the hook refused: an error tool_result carrying
 * the hook's reason. A client's real result that happens to be an error does
 * not carry the reason and is left alone.
 */
export function isForwardedDenial(block: Block | undefined): boolean {
  return block?.type === "tool_result" && block.is_error === true && blockText(block).includes(PASSTHROUGH_DENY_REASON)
}

/** Every tool_result block in a set of client messages, in order. */
export function deliveredToolResults(messages: ReadonlyArray<{ role?: string; content?: unknown }> | undefined): DeliveredToolResult[] {
  const out: DeliveredToolResult[] = []
  for (const m of messages ?? []) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content as Block[]) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue
      out.push({ tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error === true ? { is_error: true } : {}) })
    }
  }
  return out
}

/**
 * Rewrite, in place, every forwarded denial whose id has a delivered result.
 * Pure over the parsed rows; returns the rows that changed, so a caller
 * re-serializes those and nothing else.
 */
export function rewriteDenialRows(rows: ReadonlyArray<Row>, results: ReadonlyArray<DeliveredToolResult>): Set<Row> {
  const changed = new Set<Row>()
  if (results.length === 0) return changed
  const byId = new Map(results.map(r => [r.tool_use_id, r]))
  for (const row of rows) {
    if (row.type !== "user") continue
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (!isForwardedDenial(block)) continue
      const real = byId.get(block.tool_use_id as string)
      if (!real) continue
      block.content = real.content
      if (real.is_error) block.is_error = true
      else delete block.is_error
      // The row-level denial stamps go too, so the row is what the CLI would
      // have written for a real result and nothing keyed on them sees a denial.
      delete row.toolDenialKind
      delete row.toolUseResult
      changed.add(row)
    }
  }
  return changed
}

/**
 * Config dirs whose `projects/` tree may hold the session: the profile's
 * CLAUDE_CONFIG_DIR if any, then the CLI's default.
 */
export function transcriptConfigDirs(env: Record<string, string | undefined>): string[] {
  const dirs = [env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")].filter((d): d is string => Boolean(d))
  return [...new Set(dirs)]
}

/**
 * The session JSONL for a CLI session id. The project sub-directory is a
 * slug of the cwd the CLI was launched in; scanning for the id avoids
 * re-implementing that slug and survives it changing.
 */
export function locateSessionTranscript(sessionId: string, configDirs: ReadonlyArray<string>): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined
  for (const dir of configDirs) {
    const projects = join(dir, "projects")
    if (!existsSync(projects)) continue
    let entries: string[]
    try { entries = readdirSync(projects) } catch { continue }
    for (const project of entries) {
      const candidate = join(projects, project, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export interface RepairOutcome {
  file?: string
  rewritten: number
}

/**
 * Rewrite the session's forwarded denials with the delivered results. Reads
 * the JSONL, rewrites the matching blocks, writes it back through a rename so
 * the CLI never observes a half-written file. Only the lines that changed are
 * re-serialized: every other line, parsable or not, goes back verbatim, so
 * the CLI's own formatting is never touched. A session with nothing to
 * rewrite is left untouched.
 */
export function repairForwardedDenials(opts: {
  sessionId: string
  configDirs: ReadonlyArray<string>
  results: ReadonlyArray<DeliveredToolResult>
}): RepairOutcome {
  if (opts.results.length === 0) return { rewritten: 0 }
  const file = locateSessionTranscript(opts.sessionId, opts.configDirs)
  if (!file) return { rewritten: 0 }
  const lines = readFileSync(file, "utf8").split("\n")
  const rows: Array<Row | null> = lines.map(l => {
    if (l.trim().length === 0) return null
    try { return JSON.parse(l) as Row } catch { return null }
  })
  const changed = rewriteDenialRows(rows.filter((r): r is Row => r !== null), opts.results)
  const rewritten = changed.size
  if (rewritten === 0) return { file, rewritten }
  const out = lines.map((l, i) => (rows[i] && changed.has(rows[i]) ? JSON.stringify(rows[i]) : l)).join("\n")
  const tmp = `${file}.meridian-tmp`
  writeFileSync(tmp, out)
  renameSync(tmp, file)
  return { file, rewritten }
}
