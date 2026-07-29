# Per-Model 1M Context Override — Design

**Status:** Approved (owner decisions: cover both `fable` and `opus`; defaults unchanged; no regression for anyone who does not set the new variables).
**Fixes:** [#702](https://github.com/rynfar/meridian/issues/702) — Fable defaults to the extended-context variant with no per-model way to opt out.

## Problem

`mapModelToClaudeModel` (`src/proxy/models.ts`) picks the extended-context variant per tier, and the three tiers are inconsistent in how a user can override that choice:

| tier | default | escape hatch |
|---|---|---|
| sonnet | `sonnet` (200k) | opt **in** via `MERIDIAN_SONNET_MODEL=sonnet[1m]` |
| opus | `opus[1m]` | none |
| fable | `fable[1m]` | none |

The only lever for `fable` and `opus` is the global `MERIDIAN_1M_CONTEXT_SUPPORT=0`, which disables extended context for **every** tier. A user who wants to avoid Extra Usage on Fable must also give up Opus 1M, which is included on their plan — they pay for the fix with a real capability.

### What was verified

Probed live against two accounts with Extra Usage **disabled**, so a request requiring it would have failed and triggered the existing `context_fallback` path:

| account | plan | `opus[1m]` | `fable[1m]` |
|---|---|---|---|
| personal | Max | served | **served** |
| work | Team | served | **served** |

Both mapped to the `[1m]` variant (`model=fable[1m]` in the request log) and neither fell back. So `fable[1m]` is included at no Extra Usage cost on Max and Team, and **the current default is correct**. This design does not change it.

### Why an escape hatch is still needed

Meridian already self-heals when a `[1m]` request is *rejected*: `isExtraUsageRequiredError` strips the suffix, records a one-hour cooldown, and retries on the base model (`src/proxy/server.ts:1775`).

That only protects users whose Extra Usage is **disabled** — they get an error, and the fallback fires. A user with Extra Usage **enabled**, on a plan where the variant is not included, gets no error at all: the request is served and silently billed. The fallback cannot see that case, and there is currently no way to opt out per tier.

Opus has the same exposure for a different reason: a known upstream bug ([anthropics/claude-code#39841](https://github.com/anthropics/claude-code/issues/39841)) gates `opus[1m]` behind Extra Usage even on Max, contrary to Anthropic's documentation. Meridian deliberately follows the documented behavior, which is the right call — but it leaves affected users with no per-tier remedy.

## Design

Add one override per affected tier, mirroring the existing `MERIDIAN_SONNET_MODEL` pattern (including its `CLAUDE_PROXY_` alias):

```ts
const fableOverride = process.env.MERIDIAN_FABLE_MODEL ?? process.env.CLAUDE_PROXY_FABLE_MODEL
const opusOverride = process.env.MERIDIAN_OPUS_MODEL ?? process.env.CLAUDE_PROXY_OPUS_MODEL
```

Applied as the first check inside each tier's existing branch:

```ts
if (model.includes("fable") || model.includes("mythos")) {
  if (fableOverride === "fable") return "fable"
  if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "fable[1m]"
  return "fable"
}

if (model.includes("opus")) {
  if (opusOverride === "opus") return "opus"
  if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "opus[1m]"
  return "opus"
}
```

### Semantics

- `MERIDIAN_FABLE_MODEL=fable` / `MERIDIAN_OPUS_MODEL=opus` — force the 200k base variant for that tier only.
- `MERIDIAN_FABLE_MODEL=fable[1m]` / `MERIDIAN_OPUS_MODEL=opus[1m]` — accepted and explicitly a **no-op today**, since `[1m]` is already the default. Supported so the variable reads symmetrically, documents intent, and keeps working if a default ever flips.
- Any other value, including unset — ignored; the tier behaves exactly as it does today. This matches how `MERIDIAN_SONNET_MODEL` already treats values other than `sonnet[1m]`.

### Regression safety

This is the binding constraint. The only new behavior is a single equality check per branch that fires on an exact match to the base-model string. When the variable is unset — the state of every existing installation — each branch executes the same instructions in the same order as today. Nothing is reordered, no existing condition changes, and no default moves.

`MERIDIAN_1M_CONTEXT_SUPPORT` continues to work as the global switch; the per-tier override composes with it (either one selecting the base variant wins, since both paths return the base model).

Interaction with the other selection inputs is unchanged: subagents already force the base variant, and the Extra Usage cooldown (`isExtendedContextKnownUnavailable`) still suppresses `[1m]` after a confirmed failure.

Mythos rides the fable tier (`model.includes("mythos")` routes into the same branch), so `MERIDIAN_FABLE_MODEL` covers it — worth stating in the docs so it isn't discovered by surprise.

## Testing

**Unit tests against `mapModelToClaudeModel`** (`src/__tests__/`, pure — the function reads only `process.env` and the module's cooldown state):

- **Regression guard:** with no override set, `fable` → `fable[1m]` and `opus` → `opus[1m]`. This is the test that proves existing users are unaffected; it must fail if the new check is misplaced.
- `MERIDIAN_FABLE_MODEL=fable` → `fable`, while `opus` in the same run still → `opus[1m]` (proves the override is tier-scoped, not global).
- `MERIDIAN_OPUS_MODEL=opus` → `opus`, while `fable` still → `fable[1m]`.
- `MERIDIAN_FABLE_MODEL=fable[1m]` → `fable[1m]` (documented no-op).
- An unrecognized value (e.g. `MERIDIAN_FABLE_MODEL=nonsense`) → `fable[1m]`, i.e. ignored rather than treated as an opt-out.
- The `CLAUDE_PROXY_FABLE_MODEL` / `CLAUDE_PROXY_OPUS_MODEL` aliases resolve identically.
- A mythos request with `MERIDIAN_FABLE_MODEL=fable` → `fable`.
- Subagent + override still → base (unchanged, guards against the new check disturbing that path).

Tests must save and restore the environment variables they set, since the suite shares a process.

**Live verification:** start the proxy with `MERIDIAN_FABLE_MODEL=fable`, send one request, and confirm the request log line reads `model=fable` rather than `model=fable[1m]`. This proves the switch reaches real model selection rather than only satisfying a unit test.

## Documentation

`README.md` documents `MERIDIAN_SONNET_MODEL` and `MERIDIAN_1M_CONTEXT_SUPPORT`; the two new variables belong alongside them, with a one-line note that Fable and Opus default to `[1m]` because it is included on Max and Team (verified), and that the override exists for plans where it is not.

## Out of scope

- Changing any default. `fable[1m]` and `opus[1m]` remain the defaults, verified correct on Max and Team.
- A generic multi-tier switch (e.g. `MERIDIAN_1M_MODELS=opus,fable`). Considered and rejected: it introduces a new configuration concept and changes how the existing global switch composes, for no gain over following the established per-tier pattern.
- Any change to the Extra Usage detection, cooldown, or fallback machinery.
- The intermittent `sources.oauth: null` observed while probing, which suppresses all usage data including `extraUsage`. Real, unrelated, tracked separately.
