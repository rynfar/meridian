import { describe, expect, it } from "bun:test"
import { PASSTHROUGH_HANDLED_REASON, PASSTHROUGH_NOT_FORWARDED_REASON } from "../proxy/passthroughDenial"
import { PriorThinkingPruneError, prunePriorThinkingFile, prunePriorThinkingTranscript, pruneStats } from "../proxy/session/priorThinking"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const assistant = (uuid: string, id: string, content: unknown[]) => JSON.stringify({
  type: "assistant", uuid, parentUuid: "parent", message: { role: "assistant", id, content },
})
const thinking = { type: "thinking", thinking: "private", signature: "opaque" }
const FORWARDED = "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."
const text = { type: "text", text: "visible" }

describe("prior thinking transcript pruning", () => {
  it("removes older thinking but preserves every UUID, parent and API message grouping", () => {
    const rows = [assistant("a", "old", [thinking]), assistant("b", "old", [text]),
      JSON.stringify({ type: "user", uuid: "u", parentUuid: "b", message: { content: "next" } }),
      assistant("c", "new", [thinking]), assistant("d", "new", [text])]
    const result = prunePriorThinkingTranscript(rows.join("\n") + "\n")
    const parsed = result.split("\n").filter(Boolean).map(row => JSON.parse(row))
    expect(parsed[0].message.content).toEqual([])
    expect(parsed[1].message.content).toEqual([text])
    expect(parsed[3].message.content).toEqual([])
    expect(parsed[4].message.content).toEqual([text])
    expect(parsed.map(row => [row.uuid, row.parentUuid])).toEqual(rows.map(row => {
      const value = JSON.parse(row); return [value.uuid, value.parentUuid]
    }))
    expect(result.split("\n")[2]).toBe(rows[2])
  })
  it("preserves all blocks of the newest API message during an open tool loop", () => {
    const rows = [assistant("a", "old", [thinking, text]), JSON.stringify({ type: "user", uuid: "next", parentUuid: "a", message: { role: "user", content: "next" } }), assistant("b", "new", [thinking]),
      assistant("c", "new", [{ type: "redacted_thinking", data: "opaque" }]),
      assistant("d", "new", [{ type: "tool_use", id: "call", name: "read", input: {} }]),
      JSON.stringify({ type: "user", uuid: "denial", message: { content: [{ type: "tool_result", tool_use_id: "call", content: FORWARDED, is_error: true }] } })]
    const result = prunePriorThinkingTranscript(rows.join("\n") + "\n").split("\n")
    expect(JSON.parse(result[0]!).message.content).toEqual([text])
    expect(result.slice(1)).toEqual([...rows.slice(1), ""])
  })
  it("retains the durable tool checkpoint even if a hidden digest follows it", () => {
    const rows = [JSON.stringify({ type: "user", uuid: "u0", parentUuid: null, message: { role: "user", content: "q" } }),
      JSON.stringify({ type: "assistant", uuid: "a", parentUuid: "u0", message: { role: "assistant", id: "old", content: [thinking, text] } }),
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "a", message: { role: "user", content: "next" } }),
      JSON.stringify({ type: "assistant", uuid: "b", parentUuid: "u1", message: { role: "assistant", id: "tool", content: [thinking] } }),
      JSON.stringify({ type: "assistant", uuid: "c", parentUuid: "b", message: { role: "assistant", id: "tool", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] } }),
      JSON.stringify({ type: "user", uuid: "deny", parentUuid: "c", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: FORWARDED, is_error: true }] } }),
      JSON.stringify({ type: "assistant", uuid: "d", parentUuid: "deny", message: { role: "assistant", id: "digest", content: [thinking, text] } })]
    for (const checkpoint of ["c", undefined]) {
      const result = prunePriorThinkingTranscript(rows.join("\n") + "\n", checkpoint).split("\n")
      expect(JSON.parse(result[1]!).message.content).toEqual([text])
      expect(result[3]).toBe(rows[3])
      expect(result[4]).toBe(rows[4])
      expect(JSON.parse(result[6]!).message.content).toEqual([text])
    }
    expect(() => prunePriorThinkingTranscript(rows.join("\n"), "missing")).toThrow(PriorThinkingPruneError)
  })
  it("is idempotent and never reintroduces removed thinking", () => {
    const first = prunePriorThinkingTranscript(assistant("a", "old", [thinking, text]) + "\n" + assistant("b", "new", [thinking, text]) + "\n")
    expect(prunePriorThinkingTranscript(first)).toBe(first)
    const next = prunePriorThinkingTranscript(first + assistant("c", "newer", [thinking, text]) + "\n")
    expect(JSON.parse(next.split("\n")[0]!).message.content).toEqual([text])
    expect(JSON.parse(next.split("\n")[1]!).message.content).toEqual([text])
  })
  it("atomically replaces private bytes and leaves malformed targets untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-thinking-file-"))
    const sessionId = crypto.randomUUID()
    const directory = join(root, "projects", "fixture")
    const path = join(directory, `${sessionId}.jsonl`)
    try {
      await mkdir(directory, { recursive: true })
      const original = assistant("a", "old", [thinking, text]) + "\n"
      await writeFile(path, original, { mode: 0o600 })
      await prunePriorThinkingFile({ sessionId, configDir: root })
      expect(await readFile(path, "utf8")).toBe(prunePriorThinkingTranscript(original))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await readdir(directory)).toEqual([`${sessionId}.jsonl`])
      const malformed = "{broken\n" + original
      await writeFile(path, malformed)
      await expect(prunePriorThinkingFile({ sessionId, configDir: root })).rejects.toMatchObject({ reason: "unparseable_line" })
      expect(await readFile(path, "utf8")).toBe(malformed)
      expect(await readdir(directory)).toEqual([`${sessionId}.jsonl`])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("fails closed on malformed transcripts instead of rewriting a partial history", () => {
    expect(() => prunePriorThinkingTranscript("{broken\n" + assistant("a", "old", [thinking]) + "\n")).toThrow(PriorThinkingPruneError)
    expect(() => prunePriorThinkingTranscript(JSON.stringify({ type: "assistant", message: { content: [thinking] } }) + "\n")).toThrow()
  })
})

// B1/B2 regressions: the pending tool loop is derived from the transcript itself,
// and every failure is a typed, content-free reason.
const DENIAL = "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."
const row = (type: string, uuid: string, parentUuid: string | null, message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid, parentUuid, ...extra, message })
const prompt = (uuid: string, parent: string | null) => row("user", uuid, parent, { role: "user", content: "question" })
const turn = (uuid: string, parent: string | null, id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  row("assistant", uuid, parent, { role: "assistant", id, content }, extra)
const toolUse = (id: string) => ({ type: "tool_use", id, name: "read", input: {} })
const denial = (uuid: string, parent: string, id: string) =>
  row("user", uuid, parent, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: DENIAL, is_error: true }] })
const result = (uuid: string, parent: string, id: string) =>
  row("user", uuid, parent, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "17" }] })
const contentOf = (output: string, index: number) => JSON.parse(output.split("\n")[index]!).message.content

describe("prior thinking pending-loop anchor (derived from the transcript)", () => {
  it("keeps the pending tool group's thinking when a hidden digest row is last and no checkpoint is supplied", () => {
    const rows = [prompt("u0", null), turn("o1", "u0", "old", [thinking, text]), prompt("u1", "o1"),
      turn("a1", "u1", "tool", [thinking]), turn("a2", "a1", "tool", [toolUse("t1")]), denial("d1", "a2", "t1"),
      turn("g1", "d1", "digest", [thinking]), turn("g2", "g1", "digest", [text])]
    const output = prunePriorThinkingTranscript(rows.join("\n") + "\n")
    expect(contentOf(output, 1)).toEqual([text])
    expect(output.split("\n")[3]).toBe(rows[3])
    expect(output.split("\n")[4]).toBe(rows[4])
    expect(contentOf(output, 6)).toEqual([])
    expect(contentOf(output, 7)).toEqual([text])
  })
  it("keeps only the still-pending group in an interleaved multi-step loop", () => {
    const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking]), turn("a2", "a1", "A", [toolUse("t1")]),
      denial("d1", "a2", "t1"), turn("g1", "d1", "digestA", [thinking, text]),
      result("r1", "a2", "t1"), turn("b1", "r1", "B", [thinking, { type: "redacted_thinking", data: "opaque" }]),
      turn("b2", "b1", "B", [toolUse("t2")]), turn("b3", "b2", "B", [thinking]), turn("b4", "b3", "B", [toolUse("t3")]),
      denial("d2", "b4", "t2"), denial("d3", "d2", "t3"), turn("g2", "d3", "digestB", [thinking, text])]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    // Only the still-pending API message (B) keeps its thinking. A was answered,
    // so its thinking goes even though it belongs to the same open tool loop.
    expect(contentOf(output, 1)).toEqual([])
    expect(output.split("\n")[2]).toBe(rows[2])
    expect(contentOf(output, 4)).toEqual([text])
    for (const index of [6, 7, 8, 9]) expect(output.split("\n")[index]).toBe(rows[index])
    expect(contentOf(output, 12)).toEqual([text])
  })
  it("drops answered steps of the open loop and keeps only the pending group", () => {
    const rows = [prompt("u0", null), turn("p1", "u0", "P", [thinking, toolUse("t0")]), result("r0", "p1", "t0"),
      turn("p2", "r0", "P2", [thinking, text]), prompt("u1", "p2"),
      turn("a1", "u1", "A", [thinking, toolUse("t1")]), result("r1", "a1", "t1"),
      row("user", "m1", "r1", { role: "user", content: "reminder" }, { isMeta: true }),
      turn("b1", "m1", "B", [thinking, toolUse("t2")]), denial("d2", "b1", "t2")]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    expect(contentOf(output, 1)).toEqual([toolUse("t0")])
    expect(contentOf(output, 3)).toEqual([text])
    expect(contentOf(output, 5)).toEqual([toolUse("t1")])
    expect(output.split("\n")[8]).toBe(rows[8])
  })
  it("keeps only the newest step's thinking in a Pi-shaped loop with no plain prompt after the first", () => {
    const rows = [prompt("u0", null),
      turn("a1", "u0", "A", [thinking, toolUse("t1")]), result("r1", "a1", "t1"),
      turn("b1", "r1", "B", [thinking]), turn("b2", "b1", "B", [toolUse("t2")]), result("r2", "b2", "t2"),
      turn("c1", "r2", "C", [thinking, toolUse("t3")]), denial("d3", "c1", "t3"),
      turn("g1", "d3", "digest", [thinking, text])]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    expect(contentOf(output, 1)).toEqual([toolUse("t1")])
    expect(contentOf(output, 3)).toEqual([])
    expect(output.split("\n")[4]).toBe(rows[4])
    expect(output.split("\n")[6]).toBe(rows[6])
    expect(contentOf(output, 8)).toEqual([text])
    expect(pruneStats(rows.join("\n"))).toMatchObject({ messages: 3, blocks: 3 })
  })
  it("keeps a pending group's thinking even when a plain user row follows it", () => {
    for (const extra of [{}, { isMeta: true }]) {
      const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking, toolUse("t1")]), denial("d1", "a1", "t1"),
        row("user", "n1", "d1", { role: "user", content: "continue" }, extra), turn("c1", "n1", "C", [thinking, text])]
      const output = prunePriorThinkingTranscript(rows.join("\n"))
      expect(output.split("\n")[1]).toBe(rows[1])
      expect(contentOf(output, 4)).toEqual([text])
    }
  })
  it("never empties a thinking-only API message: its rows stay byte-identical", () => {
    const single = [prompt("u0", null), turn("s1", "u0", "silent", [thinking]), prompt("u1", "s1"),
      turn("a1", "u1", "A", [thinking, text])]
    const output = prunePriorThinkingTranscript(single.join("\n") + "\n")
    expect(output.split("\n")[1]).toBe(single[1])
    expect(contentOf(output, 3)).toEqual([text])
    const split = [turn("s1", null, "silent", [thinking]), turn("s2", "s1", "silent", [{ type: "redacted_thinking", data: "opaque" }]),
      prompt("u1", "s2"), turn("a1", "u1", "A", [thinking]), turn("a2", "a1", "A", [text])]
    const second = prunePriorThinkingTranscript(split.join("\n"))
    expect(second.split("\n").slice(0, 3)).toEqual(split.slice(0, 3))
    expect(contentOf(second, 3)).toEqual([])
    expect(pruneStats(split.join("\n"))).toMatchObject({ messages: 1, blocks: 1 })
  })
  it("drops all thinking once the loop is answered and the turn completes", () => {
    const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking, toolUse("t1")]), result("r1", "a1", "t1"),
      turn("c1", "r1", "C", [thinking, text])]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    expect(contentOf(output, 1)).toEqual([toolUse("t1")])
    expect(contentOf(output, 3)).toEqual([text])
  })
  it("never anchors on a digest group even when a raced digest call received the forwarding denial", () => {
    const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking, toolUse("t1")]), denial("d1", "a1", "t1"),
      turn("g1", "d1", "digest", [thinking, toolUse("t9")]), denial("d9", "g1", "t9")]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    expect(output.split("\n")[1]).toBe(rows[1])
    expect(contentOf(output, 3)).toEqual([toolUse("t9")])
  })
  it("treats every passthrough hook block as unanswered, and their answers as digests", () => {
    for (const reason of [PASSTHROUGH_HANDLED_REASON, PASSTHROUGH_NOT_FORWARDED_REASON]) {
      const blocked = row("user", "x1", "a1", { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: DENIAL, is_error: true },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: reason }], is_error: true }] })
      const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking, toolUse("t1"), toolUse("t2")]), blocked,
        turn("g1", "x1", "digest", [thinking, text])]
      const output = prunePriorThinkingTranscript(rows.join("\n"))
      expect(output.split("\n")[1]).toBe(rows[1])
      expect(contentOf(output, 3)).toEqual([text])
    }
  })
  it("never rewrites or anchors on sidechain rows", () => {
    const rows = [prompt("u0", null), turn("a1", "u0", "A", [thinking, text]),
      turn("s1", "a1", "side", [thinking, toolUse("ts")], { isSidechain: true })]
    const output = prunePriorThinkingTranscript(rows.join("\n"))
    expect(contentOf(output, 1)).toEqual([text])
    expect(output.split("\n")[2]).toBe(rows[2])
  })
  it("leaves a truncated trailing line byte-identical and still prunes the rest", () => {
    const rows = [prompt("u0", null), turn("o1", "u0", "old", [thinking, text]), prompt("u1", "o1"),
      turn("a1", "u1", "tool", [thinking]), turn("a2", "a1", "tool", [toolUse("t1")]), denial("d1", "a2", "t1")]
    const tail = turn("g1", "d1", "digest", [thinking, text]).slice(0, 37)
    const output = prunePriorThinkingTranscript(rows.join("\n") + "\n" + tail)
    expect(contentOf(output, 1)).toEqual([text])
    expect(output.split("\n")[3]).toBe(rows[3])
    expect(output.split("\n").at(-1)).toBe(tail)
    expect(prunePriorThinkingTranscript(rows.join("\n") + "\n" + tail + "\n\n").endsWith(tail + "\n\n")).toBe(true)
  })
  it("reports counts and typed reasons without content", () => {
    const rows = [turn("a1", null, "A", [thinking, thinking, text]), turn("b1", "a1", "B", [thinking, text])]
    const input = rows.join("\n") + "\n"
    const stats = pruneStats(input)
    expect(stats).toEqual({ messages: 2, blocks: 3, bytesBefore: Buffer.byteLength(input), bytesAfter: Buffer.byteLength(prunePriorThinkingTranscript(input)) })
    const reason = (input: string, checkpoint?: string) => {
      try { prunePriorThinkingTranscript(input, checkpoint) } catch (error) {
        expect(error).toBeInstanceOf(PriorThinkingPruneError)
        return (error as PriorThinkingPruneError).reason
      }
      return "none"
    }
    expect(reason(rows[0] + "\n{broken\n" + rows[1])).toBe("unparseable_line")
    expect(reason(JSON.stringify({ type: "assistant", message: { content: [thinking] } }))).toBe("malformed_row")
    expect(reason("[]")).toBe("malformed_row")
    expect(reason(input, "missing")).toBe("checkpoint_absent")
  })
})

describe("prior thinking transcript location", () => {
  it("uses the locator's projectDir and only scans every project when it is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-thinking-locate-"))
    const sessionId = crypto.randomUUID()
    const cwd = join(root, "work")
    try {
      await mkdir(cwd)
      const owned = join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
      const decoy = join(root, "projects", "decoy")
      await mkdir(owned, { recursive: true })
      await mkdir(decoy, { recursive: true })
      const original = assistant("a", "old", [thinking, text]) + "\n"
      await writeFile(join(owned, `${sessionId}.jsonl`), original, { mode: 0o600 })
      await writeFile(join(decoy, `${sessionId}.jsonl`), original, { mode: 0o600 })
      const stats = await prunePriorThinkingFile({ sessionId, configDir: root, projectDir: cwd })
      expect(stats.blocks).toBe(1)
      expect(await readFile(join(owned, `${sessionId}.jsonl`), "utf8")).toBe(prunePriorThinkingTranscript(original))
      expect(await readFile(join(decoy, `${sessionId}.jsonl`), "utf8")).toBe(original)
      await expect(prunePriorThinkingFile({ sessionId, configDir: root })).rejects.toMatchObject({ reason: "transcript_ambiguous" })
      await expect(prunePriorThinkingFile({ sessionId: crypto.randomUUID(), configDir: root, projectDir: cwd }))
        .rejects.toMatchObject({ reason: "transcript_not_found" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("refuses a symlinked or non-regular transcript without touching it", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-thinking-type-"))
    const cwd = join(root, "work")
    try {
      await mkdir(cwd)
      const directory = join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
      await mkdir(directory, { recursive: true })
      const real = join(root, "real.jsonl")
      const original = assistant("a", "old", [thinking, text]) + "\n"
      await writeFile(real, original)
      const linked = crypto.randomUUID()
      await symlink(real, join(directory, `${linked}.jsonl`))
      await expect(prunePriorThinkingFile({ sessionId: linked, configDir: root, projectDir: cwd }))
        .rejects.toMatchObject({ reason: "not_regular_file" })
      expect(await readFile(real, "utf8")).toBe(original)
      const folder = crypto.randomUUID()
      await mkdir(join(directory, `${folder}.jsonl`))
      await expect(prunePriorThinkingFile({ sessionId: folder, configDir: root, projectDir: cwd }))
        .rejects.toMatchObject({ reason: "not_regular_file" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
