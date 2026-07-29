# `<thinking>` Opt-In Stripping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop deleting user-authored `<thinking>` blocks from prompts, while keeping the ability to strip leaked ones available and tested.

**Architecture:** Move `thinking` out of the unconditional `ORCHESTRATION_TAGS` allowlist into its own conditional pattern set, gated by a new `stripThinking` option — exactly how `system-reminder` is already handled in the same file. No adapter enables it.

**Tech Stack:** TypeScript, Bun test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-thinking-tag-opt-in-design.md`.
- Branch is `fix/thinking-tag-opt-in`. **Never** `git push origin main`.
- No `as any`, `@ts-ignore`, `@ts-expect-error`. No empty catch blocks.
- `npx tsc --noEmit` must pass before any commit — CI runs typecheck separately from `bun test`.
- Bun's `noUncheckedIndexedAccess` strictness applies: never index into an array directly in an assertion.
- **No adapter opts in.** `stripThinking` defaults to `false` everywhere. Do not add a capability method to any adapter, and do not thread it through `pipelineCtx`. That is deliberate: no client was measured injecting `<thinking>`, so enabling it anywhere would delete users' own content for no measured benefit.
- **Do not weaken the two existing tests.** They must keep asserting that `<thinking>` IS stripped — by passing the new flag. Changing either to expect `<thinking>` to survive discards the #167 regression guard.
- Touch only `thinking`. Every other entry in `ORCHESTRATION_TAGS` stays exactly as it is.
- Conventional Commits, no AI attribution lines. Commit with `git -c commit.gpgsign=false`.

## Test-suite facts you need

- Full suite baseline on this branch: **0 failures**. Any failure is a regression you introduced — diagnose it, do not dismiss it as flakiness.
- `sanitizeTextContent(text, opts)` is exported from `src/proxy/sanitize.ts`. Its only callers are two lines inside `flattenUserContent` in `src/proxy/server.ts` (a plain-string body and each `text` block). Assistant content and `tool_result` content are **not** sanitized — that is pre-existing and out of scope.
- `sanitize-unit.test.ts` is the **only** test file that calls `sanitizeTextContent`, so it is the only place the two existing assertions need updating.
- **Do not confuse this with structured thinking blocks.** `openai-responses.test.ts`, `proxy-passthrough-thinking.test.ts`, and `proxy-sdk-params.test.ts` all mention "thinking" but concern Anthropic `type: "thinking"` **content blocks** and the thinking beta — an entirely separate mechanism from the raw XML tag this plan touches. The comment being removed from `ORCHESTRATION_TAGS` even says so ("NOT the structured content block type"). Leave all three files alone; if one of them starts failing, you have changed the wrong thing.

---

### Task 1: Make `thinking` stripping conditional

**Files:**
- Modify: `src/proxy/sanitize.ts` (the `ORCHESTRATION_TAGS` array, the pattern sets, `SanitizeOptions`, and `sanitizeTextContent`)
- Test: `src/__tests__/sanitize-unit.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  interface SanitizeOptions {
    stripSystemReminder?: boolean   // existing, unchanged
    stripThinking?: boolean          // new
  }
  sanitizeTextContent(text: string, opts?: SanitizeOptions): string
  ```

- [ ] **Step 1: Update the two existing tests to pass the flag**

These two currently assert `<thinking>` is stripped by default. After this change the default no longer strips it, so they must pass the flag — **not** be changed to expect survival.

In `src/__tests__/sanitize-unit.test.ts`, replace the test at ~line 99:

```ts
  it("strips leaked <thinking> tags when opted in (text content, not structured blocks)", () => {
    const input = 'text<thinking>model thoughts leaked here</thinking>more text'
    expect(sanitizeTextContent(input, { stripThinking: true })).toBe("textmore text")
  })
```

and in the #167 compound test at ~line 190, add the flag to the existing options object:

```ts
    expect(sanitizeTextContent(input, { stripSystemReminder: true, stripThinking: true })).toBe("What is 2+2?")
```

Leave everything else in that test — the input array and the expected output — untouched.

- [ ] **Step 2: Add the new default-behaviour tests**

Append to the same `describe` block that holds the other tag tests:

```ts
  // #720 — `thinking` is a common chain-of-thought convention in hand-written
  // prompts, so stripping it by default deleted user-authored content. It is
  // now opt-in. This is the regression guard: it must fail if `thinking` is
  // returned to the unconditional ORCHESTRATION_TAGS list.
  it("leaves <thinking> alone by default", () => {
    const input = 'before<thinking>user reasoning instructions</thinking>after'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("still strips the unconditional tags when <thinking> is present and not opted in", () => {
    const input = '<thinking>keep me</thinking><env>drop me</env>tail'
    expect(sanitizeTextContent(input)).toBe("<thinking>keep me</thinking>tail")
  })

  it("strips a self-closing <thinking /> only when opted in", () => {
    const input = 'a<thinking />b'
    expect(sanitizeTextContent(input)).toBe("a<thinking />b")
    expect(sanitizeTextContent(input, { stripThinking: true })).toBe("ab")
  })

  it("the two flags are independent", () => {
    const input = '<system-reminder>r</system-reminder><thinking>t</thinking>tail'
    // Only system-reminder opted in
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("<thinking>t</thinking>tail")
    // Only thinking opted in
    expect(sanitizeTextContent(input, { stripThinking: true })).toBe("<system-reminder>r</system-reminder>tail")
  })
```

Note on the second test's expectation: `sanitizeTextContent` collapses runs of 3+ newlines and trims, but this input has no newlines, so the surviving text is a straight concatenation.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
bun test src/__tests__/sanitize-unit.test.ts
```

Expected: FAIL. The four new tests fail because `thinking` is still stripped unconditionally (`"leaves <thinking> alone by default"` gets `"beforeafter"`). The two updated tests may still pass, since passing an unknown option is currently harmless.

- [ ] **Step 4: Implement the change**

In `src/proxy/sanitize.ts`:

**4a.** Remove `thinking` and its two comment lines from `ORCHESTRATION_TAGS`. Delete these three lines:

```ts
  // Leaked thinking tags (NOT the structured content block type —
  // these are raw XML tags that appear in text content on replay)
  "thinking",
```

**4b.** Extend the comment above `ORCHESTRATION_TAGS` so the next reader knows why `thinking` is absent. The block currently explains the `system-reminder` exclusion; append a second paragraph in the same voice:

```
// `thinking` is NOT here either, for the same reason: it is the most common
// chain-of-thought convention in hand-written prompts and preset libraries, so
// stripping it unconditionally deleted user-authored content (#720). It is only
// stripped when the caller opts in via { stripThinking: true }. No adapter does
// today — a survey of opencode, crush, pi, droid and codex found none of them
// injecting it, so the #167 leak appears to have been fixed upstream.
```

**4c.** Add the conditional pattern set next to `SYSTEM_REMINDER_PATTERNS`:

```ts
// Opt-in: only used when the caller reports that its adapter leaks raw
// <thinking> tags into text content (#167). Off by default — see the note on
// ORCHESTRATION_TAGS above.
const THINKING_TAG_PATTERNS: RegExp[] = [
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
  /<thinking\b[^>]*\/>/gi,
]
```

**4d.** Add the option to the interface:

```ts
export interface SanitizeOptions {
  /** Strip `<system-reminder>` blocks. Enable for adapters (Droid) that leak
   *  CWD/env through this tag. */
  stripSystemReminder?: boolean
  /** Strip raw `<thinking>` tags. Off by default: the tag is a common
   *  chain-of-thought convention in user-authored prompts (#720). Enable only
   *  for an adapter observed leaking it. */
  stripThinking?: boolean
}
```

**4e.** Include the patterns when the flag is set. Replace the ternary in `sanitizeTextContent` with an accumulating list so the two flags compose independently:

```ts
export function sanitizeTextContent(text: string, opts: SanitizeOptions = {}): string {
  let result = text
  const patterns = [...ALL_PATTERNS]
  if (opts.stripSystemReminder) patterns.push(...SYSTEM_REMINDER_PATTERNS)
  if (opts.stripThinking) patterns.push(...THINKING_TAG_PATTERNS)
  for (const pattern of patterns) {
    // Reset lastIndex for stateful regexes (those with 'g' flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // Collapse runs of 3+ newlines into 2 (avoids large gaps where tags were)
  result = result.replace(/\n{3,}/g, "\n\n")
  return result.trim()
}
```

- [ ] **Step 5: Run the tests and typecheck to verify they pass**

```bash
bun test src/__tests__/sanitize-unit.test.ts && npx tsc --noEmit
```

Expected: all tests PASS, `tsc` silent.

Then the full suite:

```bash
npm test
```

Expected: **0 failures.** If another test asserted `<thinking>` stripping by default, it will surface here — report it rather than silently editing it, since it may be a second regression guard that needs the flag too.

- [ ] **Step 6: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/sanitize.ts src/__tests__/sanitize-unit.test.ts
git -c commit.gpgsign=false commit -m "fix(sanitize): make <thinking> stripping opt-in"
```

---

### Task 2: End-to-end coverage and verification

The unit tests prove the sanitizer's behaviour. This proves a user's `<thinking>` block actually survives the full request path — which is the test that would have caught #720, since every unit test asserted the stripping was working correctly.

**Files:**
- Test: `src/__tests__/proxy-replay-envelope.test.ts`

**Interfaces:**
- Consumes: `sanitizeTextContent`'s new default from Task 1 (no direct import — exercised through the HTTP layer).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

`src/__tests__/proxy-replay-envelope.test.ts` already mocks the SDK and captures prompts into a module-level `capturedPrompts` array, and has a `post(app, messages, headers?)` helper plus `clearSessionCache`. Read its existing setup before writing, then append:

```ts
/**
 * #720 — a user's own <thinking> block must reach the model.
 *
 * `thinking` was on the unconditional strip list, and the sanitizer runs on
 * user-authored text, so a paired <thinking>…</thinking> in a prompt was
 * deleted before the model saw it — on full replay as well as on resume. Every
 * unit test asserted the stripping worked; none asserted it should not happen
 * to user content, which is why this went unnoticed.
 */
describe("user-authored <thinking> survives (#720)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("delivers a user's <thinking> block to the model", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<thinking>Reason step by step before answering.</thinking>\n\nWhat is 2+2?" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(typeof prompt).toBe("string")
    expect(prompt).toContain("<thinking>")
    expect(prompt).toContain("Reason step by step before answering.")
    expect(prompt).toContain("What is 2+2?")
  })

  it("still strips harness tags from the same message", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, [
      { role: "user", content: "<env>cwd=/tmp</env><thinking>my reasoning</thinking>the question" },
    ])
    expect(res.status).toBe(200)

    const prompt = capturedPrompts[0] as string
    expect(prompt).toContain("<thinking>my reasoning</thinking>")
    expect(prompt).not.toContain("<env>")
    expect(prompt).not.toContain("cwd=/tmp")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails on the pre-fix behaviour**

The fix from Task 1 is already committed, so these will pass immediately. To prove they are load-bearing rather than tautological, temporarily re-add `"thinking",` to the `ORCHESTRATION_TAGS` array in `src/proxy/sanitize.ts`, then:

```bash
bun test src/__tests__/proxy-replay-envelope.test.ts
```

Expected: FAIL — the prompt comes through without the `<thinking>` block.

**Then restore `sanitize.ts` exactly** and confirm with `git diff src/proxy/sanitize.ts` that it reports no changes. Record the failing output in your report as the RED evidence.

- [ ] **Step 3: Run the test to verify it passes**

```bash
bun test src/__tests__/proxy-replay-envelope.test.ts && npx tsc --noEmit
```

Expected: PASS, `tsc` silent.

- [ ] **Step 4: Full suite and build**

```bash
npm test && npx tsc --noEmit && npm run build
```

Expected: 0 failures; `tsc` silent; build succeeds.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/__tests__/proxy-replay-envelope.test.ts
git -c commit.gpgsign=false commit -m "test(sanitize): pin that user-authored <thinking> reaches the model"
```

Do NOT push and do NOT open a PR — the controller handles that.

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| `thinking` leaves `ORCHESTRATION_TAGS` | 1 |
| `THINKING_TAG_PATTERNS` conditional set added | 1 |
| `SanitizeOptions.stripThinking` added | 1 |
| Flags compose independently | 1 |
| Default leaves `<thinking>` intact | 1 (unit) + 2 (end-to-end) |
| Other unconditional tags still stripped | 1 + 2 |
| Existing unit test updated, not weakened | 1 |
| #167 compound test updated, not weakened | 1 |
| No adapter opts in | 1 (constraint — nothing threaded through `pipelineCtx`) |
| Comment records why `thinking` is absent | 1 |

Out of scope per the spec, and absent from every task: changes to any other `ORCHESTRATION_TAGS` entry, changes to `system-reminder` handling or droid's opt-in, making the tag list user-configurable, and extending sanitization to assistant or `tool_result` content.
