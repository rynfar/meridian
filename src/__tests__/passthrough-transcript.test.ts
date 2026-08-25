/**
 * Passthrough transcript repair — rewriting forwarded denials in place.
 *
 * The fixture mirrors the session JSONL the CLI writes behind a capped
 * passthrough turn, as observed by scripts/probe-passthrough-accumulation.mjs:
 * an assistant tool_use row, then a user row holding the hook's denial as the
 * call's tool_result, chained by parentUuid.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PASSTHROUGH_DENY_REASON,
  deliveredToolResults,
  isForwardedDenial,
  locateSessionTranscript,
  repairForwardedDenials,
  rewriteDenialRows,
  transcriptConfigDirs,
} from "../proxy/passthroughTranscript"

const SESSION = "11111111-2222-4333-8444-555555555555"

function denialBlock(id: string) {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: PASSTHROUGH_DENY_REASON }
}

/** The row-level stamps the CLI puts beside a denial and not beside a real result. */
const denialStamps = { toolDenialKind: "permission-rule", toolUseResult: `Error: ${PASSTHROUGH_DENY_REASON}` }

function rows() {
  return [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "read a and b" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "msg_1", content: [
      { type: "tool_use", id: "call_a", name: "read", input: { file_path: "a" } },
      { type: "tool_use", id: "call_b", name: "read", input: { file_path: "b" } },
    ] } },
    { type: "user", uuid: "d1", parentUuid: "a1", ...denialStamps, message: { role: "user", content: [denialBlock("call_a")] } },
    { type: "user", uuid: "d2", parentUuid: "a1", ...denialStamps, message: { role: "user", content: [denialBlock("call_b")] } },
    { type: "attachment", uuid: "t1", parentUuid: "d2", attachment: {} },
    { type: "last-prompt", leafUuid: "d2", explicit: true },
  ]
}

describe("isForwardedDenial", () => {
  test("recognises the hook's denial and nothing else", () => {
    expect(isForwardedDenial(denialBlock("x"))).toBe(true)
    expect(isForwardedDenial({ type: "tool_result", tool_use_id: "x", is_error: true, content: [{ type: "text", text: PASSTHROUGH_DENY_REASON }] })).toBe(true)
    // A client's real result that failed is an error too, but not a denial.
    expect(isForwardedDenial({ type: "tool_result", tool_use_id: "x", is_error: true, content: "ENOENT" })).toBe(false)
    expect(isForwardedDenial({ type: "tool_result", tool_use_id: "x", content: PASSTHROUGH_DENY_REASON })).toBe(false)
    expect(isForwardedDenial({ type: "text", text: PASSTHROUGH_DENY_REASON })).toBe(false)
    expect(isForwardedDenial(undefined)).toBe(false)
  })
})

describe("deliveredToolResults", () => {
  test("collects tool_result blocks from user messages, keeping is_error only when set", () => {
    const out = deliveredToolResults([
      { role: "assistant", content: [{ type: "tool_use", id: "call_a" }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_a", content: "alpha" },
        { type: "tool_result", tool_use_id: "call_b", content: [{ type: "text", text: "bravo" }], is_error: true },
        { type: "text", text: "and now continue" },
      ] },
      { role: "user", content: "plain text" },
    ])
    expect(out).toEqual([
      { tool_use_id: "call_a", content: "alpha" },
      { tool_use_id: "call_b", content: [{ type: "text", text: "bravo" }], is_error: true },
    ])
  })
})

describe("rewriteDenialRows", () => {
  test("replaces the denial with the real result and touches nothing else", () => {
    const rs = rows()
    const before = JSON.parse(JSON.stringify(rs))
    const changed = rewriteDenialRows(rs, [{ tool_use_id: "call_a", content: "REAL[alpha]" }])
    expect([...changed]).toEqual([rs[2]!])
    const rewritten = (rs[2] as any).message.content[0]
    expect(rewritten).toEqual({ type: "tool_result", tool_use_id: "call_a", content: "REAL[alpha]" })
    // The rewritten row loses the denial stamps; an untouched one keeps them.
    expect("toolDenialKind" in rs[2]!).toBe(false)
    expect("toolUseResult" in rs[2]!).toBe(false)
    expect((rs[3] as any).toolDenialKind).toBe("permission-rule")
    // call_b was not delivered: its denial stays.
    expect((rs[3] as any).message.content[0]).toEqual(denialBlock("call_b"))
    // Topology is untouched: every uuid, parentUuid and leaf hint as before.
    for (const [i, r] of rs.entries()) {
      expect((r as any).uuid).toBe(before[i].uuid)
      expect((r as any).parentUuid).toBe(before[i].parentUuid)
      expect((r as any).leafUuid).toBe(before[i].leafUuid)
    }
    expect(rs.length).toBe(before.length)
  })

  test("a delivered result that is itself an error keeps is_error", () => {
    const rs = rows()
    rewriteDenialRows(rs, [{ tool_use_id: "call_b", content: "ENOENT", is_error: true }])
    expect((rs[3] as any).message.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_b", is_error: true, content: "ENOENT" })
  })

  test("an already rewritten denial is not rewritten again, and unknown ids are ignored", () => {
    const rs = rows()
    expect(rewriteDenialRows(rs, [{ tool_use_id: "call_a", content: "first" }]).size).toBe(1)
    expect(rewriteDenialRows(rs, [{ tool_use_id: "call_a", content: "second" }, { tool_use_id: "nope", content: "x" }]).size).toBe(0)
    expect((rs[2] as any).message.content[0].content).toBe("first")
  })
})

describe("locate + repair on disk", () => {
  function fixtureSession() {
    const configDir = mkdtempSync(join(tmpdir(), "meridian-transcript-"))
    const project = join(configDir, "projects", "C--some-cwd-slug")
    mkdirSync(project, { recursive: true })
    const file = join(project, `${SESSION}.jsonl`)
    // A blank line, an unparsable line, and a parsable line the CLI did not
    // write canonically (spaces, escaped unicode, a float), all of which must
    // survive verbatim. The last one is the real check: JSON.parse followed by
    // JSON.stringify would silently normalise it.
    const lines = rows().map(r => JSON.stringify(r))
    lines.splice(2, 0, "")
    lines.push('{ "type": "summary", "summary": "caf\\u00e9", "n": 1.0 }')
    lines.push("{not json")
    writeFileSync(file, lines.join("\n") + "\n")
    return { configDir, file }
  }

  test("locateSessionTranscript scans project dirs without knowing the cwd slug", () => {
    const { configDir, file } = fixtureSession()
    expect(locateSessionTranscript(SESSION, [join(configDir, "missing"), configDir])).toBe(file)
    expect(locateSessionTranscript("00000000-0000-4000-8000-000000000000", [configDir])).toBeUndefined()
    // Never treats a session id as a path component.
    expect(locateSessionTranscript("../../etc/passwd", [configDir])).toBeUndefined()
  })

  test("repairForwardedDenials rewrites on disk and preserves every other line byte for byte", () => {
    const { configDir, file } = fixtureSession()
    const before = readFileSync(file, "utf8").split("\n")
    const outcome = repairForwardedDenials({
      sessionId: SESSION,
      configDirs: [configDir],
      results: [{ tool_use_id: "call_a", content: "REAL[alpha]" }, { tool_use_id: "call_b", content: [{ type: "text", text: "REAL[bravo]" }] }],
    })
    expect(outcome).toEqual({ file, rewritten: 2 })
    const after = readFileSync(file, "utf8").split("\n")
    expect(after.length).toBe(before.length)
    for (const [i, line] of after.entries()) {
      if (i === 3 || i === 4) continue // the two denial rows
      // Every other line, canonical or not, is the same bytes.
      expect(line).toBe(before[i]!)
    }
    expect(JSON.parse(after[3]!).message.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_a", content: "REAL[alpha]" })
    expect(JSON.parse(after[4]!).message.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_b", content: [{ type: "text", text: "REAL[bravo]" }] })
    expect(after.filter(l => l.includes(PASSTHROUGH_DENY_REASON)).length).toBe(0)
  })

  test("nothing to rewrite leaves the file untouched", () => {
    const { configDir, file } = fixtureSession()
    const before = readFileSync(file, "utf8")
    expect(repairForwardedDenials({ sessionId: SESSION, configDirs: [configDir], results: [] })).toEqual({ rewritten: 0 })
    expect(repairForwardedDenials({ sessionId: SESSION, configDirs: [configDir], results: [{ tool_use_id: "nope", content: "x" }] })).toEqual({ file, rewritten: 0 })
    expect(repairForwardedDenials({ sessionId: SESSION, configDirs: [join(configDir, "elsewhere")], results: [{ tool_use_id: "call_a", content: "x" }] })).toEqual({ rewritten: 0 })
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe("transcriptConfigDirs", () => {
  test("profile config dir first, CLI default always, no duplicates", () => {
    const [dflt, ...rest] = transcriptConfigDirs({})
    expect(rest).toEqual([])
    expect(dflt!.endsWith(".claude")).toBe(true)
    expect(transcriptConfigDirs({ CLAUDE_CONFIG_DIR: "/profiles/work" })).toEqual(["/profiles/work", dflt!])
    expect(transcriptConfigDirs({ CLAUDE_CONFIG_DIR: dflt })).toEqual([dflt!])
  })
})
