# `<thinking>` Stripping Becomes Opt-In — Design

**Status:** Approved (owner decisions: make it a capability rather than remove it; default off for every adapter).
**Fixes:** [#720](https://github.com/rynfar/meridian/issues/720) — `ORCHESTRATION_TAGS` deletes user-authored `<thinking>` blocks.

## Problem

`sanitizeTextContent` strips an allowlist of orchestration tags from message text. `thinking` is on that list, and the sanitizer is applied to **user-authored** content — so a paired `<thinking>…</thinking>` written by the user is deleted before the model sees it, on full replay as well as on resume.

`<thinking>` is one of the most common chain-of-thought conventions in hand-written prompts and preset libraries. A preset that instructs the model inside a `<thinking>` block has those instructions silently removed. The failure is quiet: no warning, no error, the model simply behaves as though part of the prompt was never written.

This violates the criterion the sanitizer was introduced under (`ab98af13`, #167):

> "The sanitizer uses an exact allowlist of tag names (not prefix patterns), targeting only tags that harnesses actually inject **and that never appear in legitimate user content**."

Every other entry — `env`, `system_information`, `task_metadata`, `tool_exec`, `skill_content`, `available_skills` — meets that bar. A user never writes those. `thinking` does not meet it.

## Why the two obvious fixes are both wrong

**Removing the entry outright** would regress #167. `<thinking>` was one of the wrapper shapes actually observed leaking, and the compound regression test in `sanitize-unit.test.ts` models it arriving in a single user-role text block alongside `<system-reminder>` and `<task_metadata>` — a harness-injected blob. That is a path the sanitizer does cover.

**Scoping the stripping to assistant/tool-generated content** — the remedy the issue suggests — would be worse. There are exactly two call sites of `sanitizeTextContent`, both inside `flattenUserContent`:

```
src/proxy/server.ts:224   sanitizeTextContent(content, sanitizeOpts)        // user string content
src/proxy/server.ts:228   sanitizeTextContent(b.text, sanitizeOpts)         // user text blocks
```

`flattenAssistantContent` does no sanitization at all, and `tool_result` content inside user messages is not sanitized either. So restricting the sanitizer to assistant content would make the **entire** orchestration-tag allowlist a no-op and resurrect #167 wholesale — the harness tags it exists to strip are injected into user messages.

## Evidence

Which adapters actually inject which tags into user-role text was settled empirically rather than argued. An env-gated probe (`MERIDIAN_DIAG_TAGS=1`) logged the tags present in each inbound user text block **before** sanitization, and each client was driven headlessly against it:

| client | version | requests | tags injected into user text |
|---|---|---|---|
| opencode (with oh-my-opencode active) | 1.18.9 | 4 | none |
| crush | 0.56.0 | 2 | none |
| pi | 0.72.1 | 2 | none |
| droid | 0.182.0 | 2 | `system-reminder` only |
| *synthetic control* | — | 1 | `env`, `thinking` |

The control run proves the probe fires; without it, "no tags" would be indistinguishable from a broken instrument. Droid injecting `system-reminder` and nothing else is a useful cross-check — that is precisely what the existing `stripSystemReminder` opt-in exists for, and it is already enabled for droid.

**No current client injects `<thinking>`.** The #167 leak appears to have been fixed upstream since it was reported.

Not covered: **codex** (ignores `OPENAI_BASE_URL`; reaching it needs `config.toml` surgery) and **ForgeCode** (not installed). Both remain unmeasured.

## Design

Do to `thinking` exactly what was already done to `system-reminder`, which was pulled out of the unconditional list for the same reason — an overloaded tag that is harness noise in one context and meaningful content in another.

1. `thinking` leaves `ORCHESTRATION_TAGS` and becomes its own conditional pattern set, `THINKING_TAG_PATTERNS`, beside `SYSTEM_REMINDER_PATTERNS`.
2. `SanitizeOptions` gains `stripThinking?: boolean`.
3. `sanitizeTextContent` appends those patterns when the flag is set, mirroring how `stripSystemReminder` is handled today.

### Default off for every adapter

No adapter opts in. This is the part that differs from the `system-reminder` precedent, and it is deliberate.

Enabling it for droid was considered and rejected: droid does **not** inject `<thinking>` (measured above), so switching it on there would delete droid users' own `<thinking>` blocks for no measured benefit — imposing the exact harm of #720 on one adapter to guard a leak that cannot currently be reproduced.

The capability stays available and tested. If a harness is later observed leaking `<thinking>`, enabling it is one line in that adapter, following the `leaksCwdViaSystemReminder` pattern.

### Why not delete the capability instead

Because #167's protection would then have no test standing guard. Keeping the pattern set and exercising it through the flag means the stripping still works and is covered; only its *default* changes. That is a smaller, more reversible claim than "this leak no longer exists anywhere," which four clients on one machine cannot establish.

## Testing

**`src/__tests__/sanitize-unit.test.ts`** — two existing tests assert `thinking` stripping and must be updated to pass the flag, not deleted:
- the unit test at ~line 99 gains `{ stripThinking: true }`;
- the #167 compound-leakage test at ~line 196 already passes `{ stripSystemReminder: true }` and gains `stripThinking: true` alongside it.

Both then assert the same outcomes as today. Weakening either — for instance, changing the #167 test to expect `<thinking>` to survive — would discard the regression guard and is explicitly not the intent.

**New coverage:**
- Default behaviour: `sanitizeTextContent('<thinking>reasoning</thinking>keep')` leaves the block intact, while a same-string `<env>` block is still stripped. This is the #720 regression guard, and it must fail if `thinking` is returned to the unconditional list.
- Flag behaviour: with `{ stripThinking: true }`, the block is removed — so the capability is proven, not merely present.
- End-to-end: a user message containing `<thinking>…</thinking>` reaches the model intact. `src/__tests__/proxy-replay-envelope.test.ts` already captures the SDK prompt and is the natural home; this is the test that would have caught #720, since the unit tests all asserted the stripping was *working*.

## Out of scope

- Any change to the other entries in `ORCHESTRATION_TAGS`. They meet the original criterion and no evidence suggests otherwise.
- Any change to `system-reminder` handling, including droid's opt-in — the survey confirms it is doing its job.
- Making the tag list user-configurable. No evidence of demand, and it would expand the configuration surface for a case one flag already covers.
- Extending sanitization to assistant or `tool_result` content. That is a real gap — leaked tags in those paths are unstripped today — but it is a separate question with its own risk profile, and bundling it here would put an untested behaviour change behind a bug fix.

## Risks

- **A harness not covered by the survey may inject `<thinking>` today**, and would now leak it into model-visible text. Codex and ForgeCode are unmeasured. The consequence is the model echoing a stray tag — visible and reportable — versus the current consequence of silently deleting text the user wrote. The failure directions are not symmetric, which is what justifies the default.
- **The survey is a handful of turns on one machine.** A different opencode preset or a longer droid session could inject differently. Re-running it is cheap: the probe is committed on `diag/720-tag-leak-survey`.
