/**
 * SDK boundary guard: every content-block type must be classified for hashing.
 *
 * Three bugs shipped this way, all invisible to the suite because the suite
 * only ever asserted what we already knew to look for:
 *
 *   - #710 `thinking` fell into `normalizeContent`'s serialize-everything
 *     fallback, folding an encrypted per-generation signature into the lineage
 *     hash. Nothing failed; there was no thinking-block test at all.
 *   - #708 every rate-limit fixture used the wrong unit, so a seconds/ms
 *     mismatch was unobservable.
 *   - #694 lived entirely in SDK-injected system-prompt context no test reads.
 *
 * The pattern is the same each time: Meridian's assumptions about the SDK's
 * shape drifted from reality, and only live traffic revealed it. This test
 * closes the content-block half by reading the union out of the INSTALLED SDK
 * and failing when a type appears that nobody has classified — so the next
 * `thinking` is caught by CI on the dependency bump, not by a user.
 *
 * Deliberately reads node_modules rather than importing a type: types vanish at
 * runtime, and the point is to detect an SDK upgrade we have not reviewed.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  normalizeContent,
  HASH_HANDLED_BLOCK_TYPES,
  HASH_IGNORED_BLOCK_TYPES,
  HASH_SERIALIZED_BLOCK_TYPES,
} from "../proxy/messages"

const MESSAGES_DTS = join(
  process.cwd(),
  "node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts",
)

/**
 * Pull the `type` discriminator of every member of `ContentBlockParam`.
 *
 * Throws rather than returning a partial list: a silently empty result would
 * make this whole file pass vacuously, which is the exact failure mode it
 * exists to prevent.
 */
function sdkContentBlockTypes(): string[] {
  const src = readFileSync(MESSAGES_DTS, "utf8")
  const union = src.match(/export type ContentBlockParam = ([^;]+);/)
  if (!union?.[1]) {
    throw new Error(
      `Could not find the ContentBlockParam union in ${MESSAGES_DTS}. ` +
      `The SDK's declaration format changed — update this extractor rather ` +
      `than deleting the test, or block-type drift goes unnoticed again.`,
    )
  }
  const names = union[1].split("|").map(n => n.trim()).filter(Boolean)
  const types: string[] = []
  for (const name of names) {
    const iface = src.match(
      new RegExp(`export interface ${name} \\{(.*?)\\n\\}`, "s"),
    )
    const discriminator = iface?.[1]?.match(/type:\s*'([^']+)'/)
    if (!discriminator?.[1]) {
      throw new Error(
        `Could not read the 'type' discriminator for ${name}. Update the ` +
        `extractor — an unparsed member would silently escape classification.`,
      )
    }
    types.push(discriminator[1])
  }
  if (types.length === 0) throw new Error("Extracted zero block types — extractor is broken.")
  return types
}

describe("SDK content-block type coverage", () => {
  const sdkTypes = sdkContentBlockTypes()

  it("extracts a plausible union from the installed SDK", () => {
    // Guards the instrument itself. If this shrinks dramatically, the
    // extractor silently stopped seeing most of the union.
    expect(sdkTypes.length).toBeGreaterThanOrEqual(10)
    expect(sdkTypes).toContain("text")
    expect(sdkTypes).toContain("tool_use")
    expect(sdkTypes).toContain("thinking")
  })

  it("classifies every SDK block type into exactly one hashing bucket", () => {
    const unclassified = sdkTypes.filter(t =>
      !HASH_HANDLED_BLOCK_TYPES.has(t) &&
      !HASH_IGNORED_BLOCK_TYPES.has(t) &&
      !HASH_SERIALIZED_BLOCK_TYPES.has(t))

    // If this fails, the SDK added a content block type. Decide which bucket it
    // belongs in — see the doc comments on the three sets in messages.ts:
    //   - opaque/per-generation payload (a signature, a blob) -> IGNORED
    //   - semantic fields worth hashing precisely            -> HANDLED (+ a case)
    //   - stable payload, safe to serialize whole            -> SERIALIZED
    expect(unclassified).toEqual([])
  })

  it("puts each type in only one bucket", () => {
    const overlaps = sdkTypes.filter(t =>
      [HASH_HANDLED_BLOCK_TYPES, HASH_IGNORED_BLOCK_TYPES, HASH_SERIALIZED_BLOCK_TYPES]
        .filter(s => s.has(t)).length > 1)
    expect(overlaps).toEqual([])
  })

  it("does not classify types the SDK no longer has", () => {
    // Stale entries are how a registry rots into decoration.
    const known = [
      ...HASH_HANDLED_BLOCK_TYPES,
      ...HASH_IGNORED_BLOCK_TYPES,
      ...HASH_SERIALIZED_BLOCK_TYPES,
    ]
    expect(known.filter(t => !sdkTypes.includes(t))).toEqual([])
  })
})

describe("hashing behavior matches each block type's bucket", () => {
  const TEXT = "carrier text"
  const textBlock = { type: "text", text: TEXT }

  it("IGNORED types contribute nothing to the normalized string", () => {
    // The property that actually matters: whether the block is present or
    // absent, the hash input is identical.
    for (const type of HASH_IGNORED_BLOCK_TYPES) {
      const withBlock = normalizeContent([
        { type, thinking: "reasoning", signature: "sig-abc", data: "blob" },
        textBlock,
      ])
      expect(withBlock).toBe(TEXT)
    }
  })

  it("HANDLED types contribute their semantic fields, not raw JSON", () => {
    expect(normalizeContent([textBlock])).toBe(TEXT)
    expect(normalizeContent([{ type: "tool_use", id: "t1", name: "read", input: { p: 1 } }]))
      .toBe('tool_use:t1:read:{"p":1}')
    expect(normalizeContent([{ type: "tool_result", tool_use_id: "t1", content: "out" }]))
      .toBe("tool_result:t1:out")
  })

  it("SERIALIZED types round-trip as JSON with cache_control stripped", () => {
    for (const type of HASH_SERIALIZED_BLOCK_TYPES) {
      const out = normalizeContent([{ type, cache_control: { type: "ephemeral" }, payload: "x" }])
      expect(out).toContain(`"type":"${type}"`)
      expect(out).not.toContain("cache_control")
    }
  })

  it("an unclassified type would still be serialized — the registry is the guard, not the code path", () => {
    // Honest about the design: the fallback still catches anything unknown, so
    // nothing crashes. The registry test above is what makes that visible
    // instead of silent. Documented so nobody mistakes this for enforcement.
    const out = normalizeContent([{ type: "some_future_block", secret: "opaque" }])
    expect(out).toContain("some_future_block")
    expect(out).toContain("opaque")
  })
})
