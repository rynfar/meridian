/**
 * Self-closing tag followed by a paired tag of the same name (#722).
 *
 * The paired pattern's opening match, `<tag\b[^>]*>`, also matched a
 * SELF-CLOSING `<tag />` — `[^>]*` consumes the ` /` — so the lazy body ran on
 * to the next `</tag>` and deleted the text in between:
 *
 *   "a<env />KEEP<env>x</env>b"  ->  "ab"
 *
 * This affected every tag identically, including the unconditionally-stripped
 * orchestration tags, so it was reachable by default — not just through the
 * opt-in sets.
 */
import { describe, it, expect } from "bun:test"
import { sanitizeTextContent } from "../proxy/sanitize"

const strip = (s: string) => sanitizeTextContent(s, {})
const stripAll = (s: string) =>
  sanitizeTextContent(s, { stripSystemReminder: true, stripThinking: true })

describe("self-closing followed by paired tag (#722)", () => {
  it("keeps text between a self-closing tag and a later paired tag", () => {
    // The reported shape, on an unconditionally-stripped tag.
    expect(strip("a<env />KEEP<env>x</env>b")).toBe("aKEEPb")
  })

  it("keeps text for a self-closing tag with attributes", () => {
    expect(strip("a<env foo=\"bar\" />KEEP<env>x</env>b")).toBe("aKEEPb")
  })

  it("keeps text with no space before the slash", () => {
    expect(strip("a<env/>KEEP<env>x</env>b")).toBe("aKEEPb")
  })

  it("applies to the opt-in tags too", () => {
    expect(stripAll("a<thinking />KEEP<thinking>x</thinking>b")).toBe("aKEEPb")
    expect(stripAll("a<system-reminder />KEEP<system-reminder>x</system-reminder>b"))
      .toBe("aKEEPb")
  })

  it("still removes a lone self-closing tag", () => {
    expect(strip("before<env />after")).toBe("beforeafter")
  })

  it("still removes an ordinary paired block, content included", () => {
    expect(strip("before<env>secret</env>after")).toBe("beforeafter")
  })

  it("still removes a paired block whose opening tag has attributes", () => {
    // Guards the fix from over-correcting: an opening tag with attributes must
    // keep matching, since `[^>]*` is what allows them.
    expect(strip('before<env mode="x">secret</env>after')).toBe("beforeafter")
  })

  it("handles an attribute value ending in a slash", () => {
    // `(?<!/)` looks at the character before `>`, which here is a quote — so an
    // attribute containing or ending with a slash is unaffected.
    expect(strip('before<env path="a/b/">secret</env>after')).toBe("beforeafter")
  })

  it("removes multiple self-closing tags without eating between them", () => {
    expect(strip("a<env />b<env />c")).toBe("abc")
  })

  it("handles self-closing after a paired block", () => {
    expect(strip("a<env>x</env>KEEP<env />b")).toBe("aKEEPb")
  })

  it("handles interleaved distinct tags", () => {
    // Each tag has its own regex, so a self-closing <env> must not interact
    // with a paired <tool_exec>.
    expect(strip("a<env />KEEP<tool_exec>x</tool_exec>b")).toBe("aKEEPb")
  })

  it("removes nested-looking repeats without leaking the tail", () => {
    expect(strip("a<env>one</env>MID<env>two</env>b")).toBe("aMIDb")
  })
})
