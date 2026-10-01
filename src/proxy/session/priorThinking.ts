import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isPassthroughHookBlock, type ToolResultLike } from "../passthroughDenial"
import type { TranscriptLocator } from "../sessionLifecycle"
import { syncDirectoryDurably } from "./durableFileSystem"

/** Content-free reason a prune was skipped. Callers log only this value. */
export type PriorThinkingPruneFailure =
  | "malformed_row"
  | "unparseable_line"
  | "checkpoint_absent"
  | "transcript_not_found"
  | "transcript_ambiguous"
  | "not_regular_file"
  | "target_not_leased"

export class PriorThinkingPruneError extends Error {
  constructor(readonly reason: PriorThinkingPruneFailure) {
    super(`Prior thinking prune skipped: ${reason}`)
    this.name = "PriorThinkingPruneError"
  }
}

export interface PriorThinkingPruneStats {
  /** API messages (message.id groups) that lost at least one thinking block. */
  messages: number
  blocks: number
  bytesBefore: number
  bytesAfter: number
}

type Row = Record<string, unknown>
const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])
function object(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function mainChain(row: Row): boolean {
  return row.isSidechain !== true
}
function assistantMessage(row: Row): Row | undefined {
  if (row.type !== "assistant" || !mainChain(row)) return undefined
  if (!object(row.message) || typeof row.message.id !== "string" || !Array.isArray(row.message.content)) {
    throw new PriorThinkingPruneError("malformed_row")
  }
  return row.message
}
function toolResults(row: Row): ToolResultLike[] {
  if (row.type !== "user" || !mainChain(row) || !object(row.message) || !Array.isArray(row.message.content)) return []
  return row.message.content.filter((block): block is ToolResultLike => object(block) && block.type === "tool_result")
}
/** The passthrough hook's synthetic result row. Assistants answering it are hidden digests. */
function hookBlockRow(row: Row): boolean {
  const results = toolResults(row)
  return results.length > 0 && results.every(isPassthroughHookBlock)
}

interface Parsed {
  lines: string[]
  rows: Array<Row | undefined>
}

/** Parse every line. A single unparseable trailing line (a write cut short when an
 * SDK child died) is left byte-identical; any other unparseable line skips the prune.
 */
function parse(transcript: string): Parsed {
  const lines = transcript.split("\n")
  let lastContent = lines.length - 1
  while (lastContent >= 0 && !lines[lastContent]!.trim()) lastContent--
  const rows = lines.map((line, index) => {
    if (!line.trim()) return undefined
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      if (index === lastContent) return undefined
      throw new PriorThinkingPruneError("unparseable_line")
    }
    if (!object(row)) throw new PriorThinkingPruneError("malformed_row")
    return row
  })
  return { lines, rows }
}

/** The API message group whose thinking the API needs when the client returns
 * tool results: the newest main-chain group holding a tool_use with no real
 * tool_result after it. Measured live on claude-opus-5-5 (adaptive): a
 * tool_result continuation is accepted when only that newest message keeps its
 * thinking and earlier steps of the same tool loop have none (see
 * docs/maintenance/evidence/drop-prior-thinking.md). Position in the file and
 * plain user rows do not matter: a forwarding denial or any other passthrough
 * hook block is not a result, hidden digest groups (answers to a hook-block row)
 * and sidechain rows are never anchors, wherever they sit.
 */
function pendingToolGroup(rows: Array<Row | undefined>): string | undefined {
  const byUuid = new Map<string, Row>()
  for (const row of rows) if (row && typeof row.uuid === "string") byUuid.set(row.uuid, row)
  const answered = new Map<string, number>()
  rows.forEach((row, index) => {
    if (!row) return
    for (const result of toolResults(row)) {
      if (typeof result.tool_use_id === "string" && !isPassthroughHookBlock(result)) answered.set(result.tool_use_id, index)
    }
  })
  const conversationalParent = (row: Row): Row | undefined => {
    const seen = new Set<string>()
    let parent = typeof row.parentUuid === "string" ? byUuid.get(row.parentUuid) : undefined
    while (parent && parent.type !== "user" && parent.type !== "assistant") {
      if (typeof parent.uuid !== "string" || seen.has(parent.uuid)) return undefined
      seen.add(parent.uuid)
      parent = typeof parent.parentUuid === "string" ? byUuid.get(parent.parentUuid) : undefined
    }
    return parent
  }
  const digests = new Set<string>()
  const firstRowSeen = new Set<string>()
  let pending: string | undefined
  rows.forEach((row, index) => {
    const message = row && assistantMessage(row)
    if (!row || !message) return
    const id = message.id as string
    if (!firstRowSeen.has(id)) {
      firstRowSeen.add(id)
      const parent = conversationalParent(row)
      if (parent && hookBlockRow(parent)) digests.add(id)
    }
    if (digests.has(id)) return
    for (const block of message.content as unknown[]) {
      if (!object(block) || block.type !== "tool_use" || typeof block.id !== "string") continue
      const resultAt = answered.get(block.id)
      if (resultAt === undefined || resultAt < index) pending = id
    }
  })
  return pending
}

/** Groups whose whole content is thinking. Emptying one would leave an API
 * message with no content blocks, so those rows stay byte-identical. */
function thinkingOnlyGroups(rows: Array<Row | undefined>): Set<string> {
  const other = new Set<string>()
  const thinking = new Set<string>()
  for (const row of rows) {
    const message = row && assistantMessage(row)
    if (!message) continue
    for (const block of message.content as unknown[]) {
      if (object(block) && THINKING_TYPES.has(String(block.type))) thinking.add(message.id as string)
      else other.add(message.id as string)
    }
  }
  return new Set([...thinking].filter(id => !other.has(id)))
}

function prune(transcript: string, checkpointUuid?: string): { text: string; messages: number; blocks: number } {
  const { lines, rows } = parse(transcript)
  const keep = thinkingOnlyGroups(rows)
  const pending = pendingToolGroup(rows)
  if (pending) keep.add(pending)
  if (checkpointUuid) {
    const checkpoint = rows.find(row => row?.uuid === checkpointUuid)
    const message = checkpoint && assistantMessage(checkpoint)
    if (!message) throw new PriorThinkingPruneError("checkpoint_absent")
    keep.add(message.id as string)
  }
  const touched = new Set<string>()
  let blocks = 0
  const text = lines.map((line, index) => {
    const row = rows[index]
    const message = row && assistantMessage(row)
    if (!row || !message || keep.has(message.id as string)) return line
    const content = message.content as unknown[]
    const kept = content.filter(block => !object(block) || !THINKING_TYPES.has(String(block.type)))
    if (kept.length === content.length) return line
    blocks += content.length - kept.length
    touched.add(message.id as string)
    return JSON.stringify({ ...row, message: { ...message, content: kept } })
  }).join("\n")
  return { text, messages: touched.size, blocks }
}

/** Drop thinking from every API message except the pending tool call's, which the
 * API requires back with the client's tool_result. Earlier steps of the same
 * tool loop and completed turns need none.
 * The CLI persists thinking/text/tool blocks as separate rows sharing message.id.
 * Empty rows must remain: their UUIDs can be parents or durable checkpoints.
 * No transcript content is logged, and unchanged rows retain their exact bytes.
 */
export function prunePriorThinkingTranscript(transcript: string, checkpointUuid?: string): string {
  return prune(transcript, checkpointUuid).text
}

export function pruneStats(transcript: string, checkpointUuid?: string): PriorThinkingPruneStats {
  const result = prune(transcript, checkpointUuid)
  return {
    messages: result.messages,
    blocks: result.blocks,
    bytesBefore: Buffer.byteLength(transcript),
    bytesAfter: Buffer.byteLength(result.text),
  }
}

/** The CLI's project directory names for a cwd, as the SDK's own session lookup
 * resolves them: non-alphanumerics become "-", and names over 200 characters
 * gain a hash suffix this module matches by prefix rather than reimplementing.
 */
async function projectDirectories(projects: string, projectDir: string): Promise<string[]> {
  const sources = new Set([projectDir.normalize("NFC")])
  try { sources.add((await realpath(projectDir)).normalize("NFC")) } catch { /* A removed cwd keeps its literal name. */ }
  const directories = new Set<string>()
  let entries: string[] | undefined
  for (const source of sources) {
    const name = source.replace(/[^a-zA-Z0-9]/g, "-")
    if (name.length <= 200) {
      directories.add(join(projects, name))
      continue
    }
    entries ??= await readdir(projects).catch(() => [])
    const prefix = `${name.slice(0, 200)}-`
    for (const entry of entries) if (entry.startsWith(prefix)) directories.add(join(projects, entry))
  }
  return [...directories]
}

async function scanAllProjects(projects: string): Promise<string[]> {
  const directories: string[] = []
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(join(projects, entry.name))
  }
  return directories
}

/** Find the exact owned session. Use the locator's project directory when it has
 * one; scan every project directory only for legacy locators without it.
 */
async function transcriptPath(locator: TranscriptLocator): Promise<string> {
  const projects = join(locator.configDir, "projects")
  const directories = locator.projectDir
    ? await projectDirectories(projects, locator.projectDir)
    : await scanAllProjects(projects).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    })
  const matches: string[] = []
  for (const directory of directories) {
    const candidate = join(directory, `${locator.sessionId}.jsonl`)
    try {
      await lstat(candidate)
      matches.push(candidate)
    } catch (error) {
      // A sibling project's last session can be collected while we search.
      // Only disappearance is benign; permission and I/O errors surface.
      if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error
    }
  }
  if (matches.length === 0) throw new PriorThinkingPruneError("transcript_not_found")
  if (matches.length > 1) throw new PriorThinkingPruneError("transcript_ambiguous")
  return matches[0]!
}

/** Caller holds the exclusive lifecycle writer lease and has joined the SDK
 * child. Only the new fork is rewritten; its immutable source remains rollback.
 * A crash leaves either the original or the fully fsynced pruned transcript.
 * Every refusal throws before the file is touched.
 */
export async function prunePriorThinkingFile(locator: TranscriptLocator, checkpointUuid?: string): Promise<PriorThinkingPruneStats> {
  const path = await transcriptPath(locator)
  if (!(await lstat(path)).isFile()) throw new PriorThinkingPruneError("not_regular_file")
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let original: string
  let mode: number
  try {
    const stat = await source.stat()
    if (!stat.isFile()) throw new PriorThinkingPruneError("not_regular_file")
    mode = stat.mode & 0o777
    original = await source.readFile("utf8")
  } finally {
    await source.close()
  }
  const result = prune(original, checkpointUuid)
  const stats = {
    messages: result.messages,
    blocks: result.blocks,
    bytesBefore: Buffer.byteLength(original),
    bytesAfter: Buffer.byteLength(result.text),
  }
  if (result.text === original) return stats
  const temporary = join(dirname(path), `.thinking-${randomUUID()}.tmp`)
  try {
    const target = await open(temporary, "wx", mode)
    try {
      await target.writeFile(result.text, "utf8")
      await target.sync()
    } finally {
      await target.close()
    }
    await rename(temporary, path)
    await syncDirectoryDurably(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
  return stats
}
