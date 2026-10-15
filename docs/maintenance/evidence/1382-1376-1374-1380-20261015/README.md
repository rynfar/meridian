# Review & Live Evidence — #1382, #1376, #1374, #1377, #1380, and `opencode-scrub` #22/#23 (2026-10-15)

## 1. Landed Contributor Pull Requests (`rynfar/meridian`)

All three accepted contributor PRs were squash-merged directly from the contributors' own pull requests (`gh pr merge <PR> --squash --admin --match-head-commit <SHA>` with explicit `--body` so no maintainer or AI `Co-authored-by` trailer was attached). Post-merge `git log` and `node scripts/attribution-audit.mjs` verified that each contributor is the Git `Author` on `main`.

| PR | Contributor | Head SHA | Landed Commit on `main` | Verified Git `Author` on `main` |
|---|---|---|---|---|
| [#1382](https://github.com/rynfar/meridian/pull/1382) | `@Cd1s` | `6b372b3421d8efaaf6d7747ad226b6064df19835` | `72dd81384bc79196e4dc68830a93c05c5ba0f5a1` | `Cd1s <135119404+Cd1s@users.noreply.github.com>` |
| [#1376](https://github.com/rynfar/meridian/pull/1376) | `@TristanSpeakEasy` | `5844a73129f89581523c0f14fc45bea583c43dd7` | `7c935a407d3505a1078a9cc4d8748abf907149ae` | `Tristan Cartledge <108070248+TristanSpeakEasy@users.noreply.github.com>` |
| [#1374](https://github.com/rynfar/meridian/pull/1374) | `@mradwankhalil` | `80dd41f4b2357b34972f4ef8885fcd0595be716b` | `769f6b9c92b117d77da6fbc0d14a81e7ea12b60b` | `Mohamed R. Khalil <m.radwan.khalil@gmail.com>` |

### #1382 — Antigravity prompt byte budget (`renderAgPromptWithinLimit`)
- **Tests**: 89 pass / 0 fail across `src/__tests__/antigravity-prompt-budget.test.ts` and `src/__tests__/antigravity-backend.test.ts`; full suite, `npm run typecheck`, `npm run build`, and all 8 GitHub Actions checks green.
- **Live E2E** (`scripts/e2e-antigravity-prompt-limit.mjs`, macOS arm64, Node `v22.22.3`, `Pi 1.2.0`, official `agy 1.2.7` sha256 `8c01ef82...`, `gemini-3.8-flash-low`):
  - Baseline `main` (`626a17516`, `baseline-main-626a17516.json`): replayed step `249,381` bytes -> `NEWEST_TURN_LOST` (answered `DONE\n` from turn 1 and made 1 tool call).
  - Candidate `#1382` (`6b372b342`, `candidate-pr-6b372b342.json`): replayed step `169,853` bytes -> `NEWEST_TURN_DELIVERED` (answered `T63A1CF1 H1B0CE80 ZEBRA39A7FD\n` with `newestTail: true`, `oldestHead: true`, `nonce: true`, `toolCalls: 0`).

### #1376 — Streamed OpenAI tool argument routing by content block (`createSseTranslator`)
- **Tests**: 174 pass / 0 fail across `src/__tests__/openai.test.ts` and `src/__tests__/proxy-openai-compat.test.ts`; full suite, `npm run typecheck`, `npm run build`, and all 8 GitHub Actions checks green.
- **Live E2E** (`e2e-live-1374-1376.json`, `/v1/chat/completions` streaming parallel tool calls on `claude-sonnet-4-6`):
  - Assembled `tool_calls[0]` (`{"city": "Paris"}`) and `tool_calls[1]` (`{"city": "Tokyo"}`) cleanly by content block index.

### #1374 — Default thinking display to `summarized` under Thinking Passthrough (`passthroughThinking`)
- **Tests**: 50 pass / 0 fail across `src/__tests__/query-passthrough.test.ts`, `src/__tests__/proxy-thinking-setting.test.ts`, and `src/__tests__/proxy-passthrough-thinking.test.ts`; full suite, `npm run typecheck`, `npm run build`, and all 8 GitHub Actions checks green.
- **Live E2E** (`e2e-1374-baseline.json` and `e2e-1374-candidate.json`, `/v1/messages` streaming with `thinkingPassthrough: true`, `thinking: { type: "adaptive" }`, and real `claude-opus-4-7`):
  - Baseline `main` (`626a17516`): `thinkingBlocks: 1, thinkingChars: 0, signatureDeltas: 1` (silent empty thinking block).
  - Candidate `#1374` (`80dd41f4b`): `thinkingBlocks: 1, thinkingChars: 137, signatureDeltas: 1` (streamed readable summary), while explicit `display: "omitted"` negative control remained at `omittedThinkingChars: 0`.

---

## 2. Landed Contributor Pull Requests (`rynfar/meridian-plugin-opencode-scrub`)

Draft maintainer PR `#24` (`codex/cwd-preservation-22-23-20261012`, created under the withdrawn cherry-pick integration flow) was closed unmerged so that both contributors' PRs landed as their own PRs with their own Git `Author`:
- **PR [#22](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/22)** (`@mradwankhalil`, `50e9526` -> `cf047f81a11ecc17a9cb90cf7574d2938339d9e3`): Author on `main` is `Mohamed R. Khalil <m.radwan.khalil@gmail.com>`. Closes issue `#21`.
- **PR [#23](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/23)** (`@sergiomarquezdev`, `ef058ab` + maintainer merge/canonicalization `b92ec65` -> `c59fa180a67bdc0e92e54335faf37192df334b5c`): Author on `main` is `Sergio Márquez <44240815+sergiomarquezdev@users.noreply.github.com>`.
- **PR [#25](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/25)** (`456c471`): Maintainer evidence and package/parser boundary E2E harness (`scripts/e2e-cwd-package.mjs`, 48/48 cases `PASS`, `opencode-scrub-22-23-package.json`).

---

## 3. Issue #1380 Fix (`releaseSessionTurn` watchdog cleanup)

- **Reported by**: `@Flagg0096` in [#1380](https://github.com/rynfar/meridian/issues/1380).
- **Root cause**: `leaseWatchdog` is armed before `processSessionTurns.acquire` / `crossProcessSessionTurns.acquire`. When a queued waiter disconnects before acquiring either lease, `finishRequest()` calls `releaseSessionTurn(false)`, which previously returned at `if (leaseReleased || (!sessionTurnLease && !crossProcessTurnLease)) return` before clearing `leaseWatchdog`. `SESSION_TURN_MAX_HOLD_MS` later, the orphaned timer fired and logged a false `session turn exceeded ... — aborting without releasing its fencing lease` warning.
- **Fix**: Clear and reset `leaseWatchdog` at the top of `releaseSessionTurn` before the early return guard in `src/proxy/server.ts`. Added deterministic regression test in `src/__tests__/proxy-concurrency-coordination.test.ts` (37/37 pass).

---

## 4. Held / Open Reviews Requiring Owner Decision

- **PR [#1377](https://github.com/rynfar/meridian/pull/1377)** (`@Nowaker`, `feat: serve GPT models from ChatGPT subscriptions`, head `10c7b6cee7bc13a816200b09fef03e11b6a950a7`, 146 files / +30,840 lines):
  - **Disposition**: Held for explicit owner product and API-contract approval.
  - **Findings**: Expands `ProxyConfig` (`backend: "claude" | "antigravity" | "codex"`, `codex` config block, `ProfileConfig.backend`), modifies `/profiles/list`, `/health`, `/readyz`, `/inflight`, and `/v1/models` response contracts, and adds `/v1/images/generations` and `/v1/images/edits` routes without an approved API-contract issue (per `.agents/references/api-contract.md`). Do not merge or close without owner direction.
- **Issue [#1371](https://github.com/rynfar/meridian/issues/1371)** (`@ohmyball`, `reconcileReturnedSessionUuids` across managed forks):
  - **Findings**: Directly touches the transcript-lifecycle invariant introduced in `e9094af67` (`src/proxy/session/lineage.ts` and `src/__tests__/lineage-unit.test.ts`), which explicitly clears inherited rollback UUIDs when `returnedSessionId !== resumeSessionId`. Changing this invariant requires verifying across supported Claude Code CLI versions whether `--fork-session` ever reissues message UUIDs or whether `reconcileReturnedSessionUuids` should retain prefix-bounded UUIDs via `inheritSdkUuids`.
- **Issue [#1368](https://github.com/rynfar/meridian/issues/1368)** (`@justprosh`, passthrough `tools: []` and `ToolSearch` deferral):
  - **Findings**: As the reporter noted in their follow-up comment, passing `tools: ["ToolSearch"]` alone while `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` is set hides the `deferred_tools_delta` attachment from the model so it has no deferred tool names to search for. Needs a design choice between injecting a deferred-tools listing in the prompt vs. not marking/lifting turns when attachments are disabled.
