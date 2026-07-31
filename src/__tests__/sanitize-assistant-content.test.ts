/**
 * Assistant-side sanitization (#724) — the unimplemented half of #167.
 *
 * Assistant content is replayed into the prompt as `[Assistant: …]` and was
 * never sanitized. The concrete leak is Meridian's own: `server.ts` appends its
 * "Files changed:" summary onto the assistant's last text block, the client
 * echoes that turn back next request, and the summary replays into the model's
 * context. `NON_XML_PATTERNS` has carried a pattern for it all along which
 * could never fire, because the sanitizer only ran on user text.
 *
 * The scope here is deliberately narrow. See the sanitizeAssistantText doc for
 * why the XML tag allowlist is NOT applied to model output.
 */
import { describe, it, expect } from "bun:test"
import { sanitizeAssistantText, sanitizeTextContent } from "../proxy/sanitize"

describe("sanitizeAssistantText — branded markers only", () => {
  it("strips Meridian's own file-change summary", () => {
    // Exactly the shape formatFileChangeSummary produces, appended to the
    // assistant's text block by server.ts.
    const text = "I updated the config.\n\n---\nFiles changed:\n  - src/a.ts\n  - src/b.ts\n"
    expect(sanitizeAssistantText(text)).toBe("I updated the config.")
  })

  it("strips the background-task marker", () => {
    expect(sanitizeAssistantText("before ⚙ background_output [task_id=abc]\nafter"))
      .toContain("before")
    expect(sanitizeAssistantText("before ⚙ background_output [task_id=abc]\nafter"))
      .not.toContain("task_id")
  })

  it("strips oh-my-opencode's internal markers", () => {
    expect(sanitizeAssistantText("a<!-- OMO_INTERNAL_INITIATOR -->b")).toBe("ab")
    expect(sanitizeAssistantText("a[SYSTEM DIRECTIVE: OH-MY-OPENCODE do x]b")).toBe("ab")
  })

  it("leaves ordinary assistant prose untouched", () => {
    const text = "Here's what I found in the file."
    expect(sanitizeAssistantText(text)).toBe(text)
  })

  it("does NOT strip XML orchestration tags from model output", () => {
    // The #720 lesson applied to the other direction: a model asked about
    // configuration legitimately writes <env>. Deleting it would eat the
    // model's own answer — the same class of bug, mirrored.
    const answer = "Your config block looks like:\n<env>\nFOO=1\n</env>\nThat sets FOO."
    expect(sanitizeAssistantText(answer)).toBe(answer)
  })

  it("does not strip <thinking> from assistant text either", () => {
    // Even though #167 named it: it is indistinguishable from a model
    // legitimately writing the tag, and nothing has been observed leaking it.
    const text = "<thinking>step one</thinking> the answer is 4"
    expect(sanitizeAssistantText(text)).toBe(text)
  })

  it("collapses the gap a removed marker leaves behind", () => {
    expect(sanitizeAssistantText("a\n\n\n---\nFiles changed:\n  - x.ts\n\n\n\nb"))
      .not.toMatch(/\n{3,}/)
  })

  it("is a no-op on empty input", () => {
    expect(sanitizeAssistantText("")).toBe("")
  })

  it("differs from the user-side sanitizer, which DOES strip the tag allowlist", () => {
    // Pins the asymmetry as intentional rather than an oversight.
    const withEnv = "text <env>SECRET=1</env> more"
    expect(sanitizeTextContent(withEnv, {})).not.toContain("SECRET")
    expect(sanitizeAssistantText(withEnv)).toContain("SECRET")
  })
})
