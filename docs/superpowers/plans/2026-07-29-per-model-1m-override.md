# Per-Model 1M Context Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user disable the 1M extended-context variant for Fable or Opus individually, instead of only via the global switch that disables it for every model.

**Architecture:** One equality check at the top of each tier's existing branch in `mapModelToClaudeModel`, reading a new env var through the existing `env()` alias helper. Defaults are unchanged; the check only fires on an exact match to the base-model string.

**Tech Stack:** TypeScript, Bun test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-per-model-1m-override-design.md`.
- Branch is `fix/per-model-1m-override`. **Never** `git push origin main`.
- No `as any`, `@ts-ignore`, `@ts-expect-error`. No empty catch blocks.
- `npx tsc --noEmit` must pass before any commit — CI runs typecheck separately from `bun test`.
- Bun's `noUncheckedIndexedAccess` strictness applies: never index into an array directly in an assertion.
- **The binding constraint is no regression.** With neither new variable set, `mapModelToClaudeModel` must behave exactly as it does today. Do not reorder existing conditions, change existing defaults, or alter the sonnet branch.
- Defaults stay `fable[1m]` and `opus[1m]` — verified live as included at no Extra Usage cost on both Max and Team. This change does not move them.
- Use the existing `env(suffix)` helper from `src/env.ts`, which already resolves `MERIDIAN_<suffix>` then `CLAUDE_PROXY_<suffix>`. Do not hand-roll the alias lookup.
- **Leave the sonnet branch alone.** It uses an older hand-rolled `process.env.X ?? process.env.Y` lookup. Modernising it to `env()` would be behaviour-identical but is out of scope for a change whose whole promise is "no regressions" — a deliberate non-change, not an oversight.
- Conventional Commits, no AI attribution lines. Commit with `git -c commit.gpgsign=false`.

## Test-suite facts you need

- Full suite baseline on this branch: **2160 pass, 0 fail**. Any other failure is a regression you introduced — diagnose it, do not dismiss it as flakiness.
- `src/__tests__/models.test.ts` is the home for these tests. It already saves/restores `CLAUDE_PROXY_SONNET_MODEL` in an `afterEach` and uses `resetExtendedContextUnavailable()` around cooldown tests — follow both conventions, since the suite shares one process and a leaked env var will corrupt unrelated files.

---

### Task 1: Per-tier overrides for fable and opus

**Files:**
- Modify: `src/proxy/models.ts` (the `fable`/`mythos` and `opus` branches of `mapModelToClaudeModel`, around lines 145-158)
- Test: `src/__tests__/models.test.ts`

**Interfaces:**
- Consumes: `env(suffix: string): string | undefined` from `src/env.ts`.
- Produces: no new exports. `mapModelToClaudeModel(model, subscriptionType?, agentMode?)` keeps its signature; only its env inputs grow.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/__tests__/models.test.ts`, after the existing `describe("mapModelToClaudeModel", ...)` block.

```ts
describe("per-tier 1M overrides", () => {
  const saved: Record<string, string | undefined> = {}
  // Sonnet's vars are cleared too: the regression guard below asserts
  // sonnet's default, and the suite shares one process — a leaked
  // MERIDIAN_SONNET_MODEL from another file would fail it spuriously.
  const KEYS = [
    "MERIDIAN_FABLE_MODEL", "CLAUDE_PROXY_FABLE_MODEL",
    "MERIDIAN_OPUS_MODEL", "CLAUDE_PROXY_OPUS_MODEL",
    "MERIDIAN_SONNET_MODEL", "CLAUDE_PROXY_SONNET_MODEL",
  ]

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    resetExtendedContextUnavailable()
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetExtendedContextUnavailable()
  })

  // THE REGRESSION GUARD. Every existing install has neither variable set;
  // this asserts they see exactly today's behaviour. If the new check is
  // misplaced, this fails.
  it("with no override set, defaults are unchanged", () => {
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("claude-sonnet-4-6")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-haiku-4-5-20251001")).toBe("haiku")
  })

  it("MERIDIAN_FABLE_MODEL=fable forces the base variant", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
  })

  it("MERIDIAN_OPUS_MODEL=opus forces the base variant", () => {
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })

  // The complaint in #702: the only existing lever is global, so opting out of
  // fable 1M also gave up opus 1M. The override must be tier-scoped.
  it("the fable override does not affect opus", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("the opus override does not affect fable", () => {
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
  })

  it("neither override affects sonnet or haiku", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-sonnet-4-6")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-haiku-4-5-20251001")).toBe("haiku")
  })

  it("explicit [1m] values are accepted as a documented no-op", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    process.env.MERIDIAN_OPUS_MODEL = "opus[1m]"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("an unrecognized value is ignored, not treated as an opt-out", () => {
    process.env.MERIDIAN_FABLE_MODEL = "nonsense"
    process.env.MERIDIAN_OPUS_MODEL = ""
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("the CLAUDE_PROXY_ aliases work identically", () => {
    process.env.CLAUDE_PROXY_FABLE_MODEL = "fable"
    process.env.CLAUDE_PROXY_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })

  it("MERIDIAN_ takes precedence over CLAUDE_PROXY_", () => {
    process.env.CLAUDE_PROXY_FABLE_MODEL = "fable"
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
  })

  // Mythos routes into the fable branch, so the fable switch must cover it.
  it("the fable override covers mythos, which rides the fable tier", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-mythos-5")).toBe("fable")
  })

  it("subagents still get the base variant regardless of override", () => {
    expect(mapModelToClaudeModel("claude-fable-5", "max", "subagent")).toBe("fable")
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    expect(mapModelToClaudeModel("claude-fable-5", "max", "subagent")).toBe("fable")
  })

  it("the Extra Usage cooldown still forces the base variant", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test src/__tests__/models.test.ts
```

Expected: the three tests that set an override to the base value FAIL (`MERIDIAN_FABLE_MODEL=fable`, `MERIDIAN_OPUS_MODEL=opus`, the two tier-scoping tests, the alias test, and the mythos test) — each returns the `[1m]` variant because the override is not read yet. The regression guard and the no-op/ignored-value tests should already PASS.

- [ ] **Step 3: Implement the overrides**

`env` is already imported in `src/proxy/models.ts` at line 10 (`import { env } from "../env"`) — no import change is needed.

Add the override check as the first line of each branch. The fable branch becomes:

```ts
  if (model.includes("fable") || model.includes("mythos")) {
    // Per-tier opt-out (#702). Fable 1M is included at no Extra Usage cost on
    // Max and Team (verified live), so [1m] stays the default — but on plans
    // where it is NOT included, a user with Extra Usage ENABLED is billed
    // silently: the request succeeds, so the extra-usage fallback below never
    // fires. The global MERIDIAN_1M_CONTEXT_SUPPORT switch would also give up
    // opus[1m], which IS included. Only an exact "fable" opts out; anything
    // else (including unset) leaves the default untouched.
    if (env("FABLE_MODEL") === "fable") return "fable"
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "fable[1m]"
    return "fable"
  }
```

and the opus branch:

```ts
  if (model.includes("opus")) {
    // Per-tier opt-out (#702), same shape as fable above. Relevant here
    // because of the known upstream bug (anthropics/claude-code#39841) that
    // gates opus[1m] behind Extra Usage even on Max, contrary to Anthropic's
    // docs — affected users need a remedy that doesn't also disable fable.
    if (env("OPUS_MODEL") === "opus") return "opus"
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "opus[1m]"
    return "opus"
  }
```

Leave the existing explanatory comment blocks above each branch in place — append to them rather than replacing them. Do not touch the sonnet branch.

- [ ] **Step 4: Run the tests and typecheck to verify they pass**

```bash
bun test src/__tests__/models.test.ts && npx tsc --noEmit
```

Expected: all tests PASS, `tsc` silent.

Then the full suite:

```bash
npm test
```

Expected: **2160+ pass, 0 fail.** Any failure is a regression — diagnose it.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false add src/proxy/models.ts src/__tests__/models.test.ts
git -c commit.gpgsign=false commit -m "feat(models): add per-tier 1M context overrides for fable and opus"
```

---

### Task 2: Documentation and live verification

**Files:**
- Modify: `README.md` (around line 144-146)
- Test: whole suite + a live proxy check

- [ ] **Step 1: Update the README**

`README.md:144` explains the Sonnet and Opus 1M behaviour but **never mentions Fable**, so Fable's `[1m]` default is currently undocumented. Line 146 documents the global `MERIDIAN_1M_CONTEXT_SUPPORT=0` switch.

Read that whole passage first, then extend it to cover: that Fable also defaults to 1M and why (included on Max and Team at no Extra Usage cost, verified), and that `MERIDIAN_FABLE_MODEL=fable` / `MERIDIAN_OPUS_MODEL=opus` disable it for one tier without giving up the other. Mention that Mythos rides the Fable tier and is covered by the Fable variable.

Match the surrounding voice and length — that section is dense prose, not a bullet list. Do not restructure it and do not pad it.

- [ ] **Step 2: Live-verify the switch reaches real model selection**

A unit test proves the function returns the right string; this proves the string reaches the SDK call. Start a proxy on a spare port with the override set:

```bash
MERIDIAN_FABLE_MODEL=fable CLAUDE_PROXY_PORT=3472 bun run ./bin/cli.ts > /tmp/fable-override.log 2>&1 &
```

Wait for health, then send one request:

```bash
curl -s -X POST http://127.0.0.1:3472/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-fable-5","max_tokens":16,"stream":false,"messages":[{"role":"user","content":"Say OK"}]}'
```

Then check which variant was selected:

```bash
grep -oE "model=[a-z]+(\[1m\])?" /tmp/fable-override.log
```

Expected: **`model=fable`**, not `model=fable[1m]`. Record the actual output in your report.

Repeat once WITHOUT the env var (restart the proxy without it) and confirm it reads `model=fable[1m]` — that is the live half of the regression guard.

Stop the proxy when done: `kill $(lsof -ti :3472)`. Do not touch port 3456; that is the developer's live instance.

- [ ] **Step 3: Full suite, typecheck, build**

```bash
npm test && npx tsc --noEmit && npm run build
```

Expected: 2160+ pass, 0 fail; `tsc` silent; build succeeds.

- [ ] **Step 4: Commit**

```bash
git -c commit.gpgsign=false add README.md
git -c commit.gpgsign=false commit -m "docs: document per-tier 1M overrides and the fable default"
```

Do NOT push and do NOT open a PR — the controller handles that.

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| `MERIDIAN_FABLE_MODEL` forces base fable | 1 |
| `MERIDIAN_OPUS_MODEL` forces base opus | 1 |
| Overrides are tier-scoped (fable's does not affect opus, and vice versa) | 1 |
| `[1m]` values accepted as a documented no-op | 1 |
| Unrecognized/unset values ignored — defaults unchanged | 1 |
| `CLAUDE_PROXY_` aliases via the existing `env()` helper | 1 |
| Mythos covered by the fable override | 1 |
| Subagent and Extra Usage cooldown paths unchanged | 1 |
| Sonnet branch untouched | 1 (constraint) |
| No regression with neither variable set | 1 (unit) + 2 (live) |
| README documents both variables and the Fable default | 2 |

Out of scope per the spec, and absent from every task: changing any default, a generic multi-tier switch, any change to Extra Usage detection/cooldown/fallback, and the intermittent `sources.oauth: null` issue.
