# Prior-thinking retention live evidence

Linux; Node v22.22.1; SDK 0.2.141; CLI 2.1.284; model `claude-opus-5-5`; Pi-shaped streaming HTTP.

| Flag | Request | Input | Cache read | Cache write | Output | Prompt | Growth | Visible chars/4 | Thinking deltas | Tool calls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| off | 1 | 2 | 0 | 2648 | 3028 | 2650 | — | 687 | 17 | 0 |
| off | 2 | 4 | 2648 | 3227 | 1770 | 5879 | 3229 | 536 | 9 | 0 |
| off | 3 | 4 | 5875 | 1863 | 112 | 7742 | 1863 | 12 | 2 | 1 |
| off | 4 | 2 | 7738 | 156 | 119 | 7896 | 154 | 33 | 1 | 1 |
| off | 5 | 2 | 7894 | 161 | 96 | 8057 | 161 | 40 | 0 | 1 |
| off | 6 | 2 | 8055 | 138 | 98 | 8195 | 138 | 60 | 0 | 0 |
| off | 7 | 4 | 8193 | 127 | 1888 | 8324 | 129 | 536 | 10 | 0 |
| off | 8 | 4 | 8320 | 1913 | 904 | 10237 | 1913 | 369 | 3 | 0 |
| on | 1 | 2 | 2297 | 520 | 2657 | 2819 | — | 699 | 12 | 0 |
| on | 2 | 4 | 2297 | 1805 | 2216 | 4106 | 1287 | 623 | 11 | 0 |
| on | 3 | 4 | 4102 | 1087 | 147 | 5193 | 1087 | 20 | 2 | 1 |
| on | 4 | 2 | 5189 | 191 | 132 | 5382 | 189 | 35 | 1 | 1 |
| on | 5 | 2 | 5189 | 287 | 90 | 5478 | 96 | 32 | 0 | 1 |
| on | 6 | 2 | 5189 | 380 | 163 | 5571 | 93 | 86 | 1 | 0 |
| on | 7 | 4 | 5569 | 162 | 1914 | 5735 | 164 | 569 | 8 | 0 |
| on | 8 | 4 | 5731 | 909 | 866 | 6644 | 909 | 418 | 3 | 0 |

16 requests, each exactly one actual SDK/API generation; six sequential client tool calls; all HTTP 200. Thinking and signatures streamed in both modes. Actual upstream shapes: on, completed turns retain zero thinking; tool continuations retain only newest assistant API message; off, cumulative thinking. Native assistant history present in all continuation API requests proves resume, not client replay.

Aggregate prompt growth off: 7,587 vs preceding billed output 7,111. On: 3,825 vs preceding billed output 7,319. Steady cache reads (requests 3–8): off 91.33%, on 91.08%; final on cache read 5,731 / total prompt 6,644.

**Estimator caveat:** growth is not literally equal to displayed chars/4 (on visible estimate 2,064). Opus summarized thinking understates full reasoning, mathematical text tokenizes poorly, new user/tool results add input, and retained newest tool thinking moves between requests. The decisive proof is absence of older thinking/signatures in actual upstream payloads and roughly halved prompt growth with stable high cache reads.

Live mechanism probe: `CLAUDE_CODE_EXTRA_BODY` successfully supplied context-management beta `clear_thinking_20251015 keep thinking_turns=1`, but earlier thinking remained throughout an open multi-step tool loop. Direct older-message deletion retaining newest API message was accepted by Opus 5.5 in that loop. Consequently transcript pruning chosen.

Earlier failed exploratory gates retained as findings: newest completed answer retention caused cache churn (fixed by dropping completed thinking); two difficult counterfeit tool-loop attempts exercised existing silent-turn recovery, one emitted a client error despite API HTTP 200; a startup-error cleanup guard initially skipped pruning on capped-result exception (fixed/tested). Final simpler three-measurement loop passes without recovery. No claim that long-running arbitrary conversations or every empty-turn recovery is proven.

Verification: targeted 13 pass, 0 fail; original mocked regression red 2 fail / 3 pass before wiring, pure regression red 4 fail before implementation. Full suite: 5,033 pass, 1 skip, 0 fail with official scratch Node 22.22.1 and replay-budget isolation. Vanilla npm test first block: 4,729 pass, 1 skip, 3 fail (existing two models-mock collision cases and distro Node without TypeScript). Official Node baseline run additionally exposed unrelated reporter cleanup race; isolated reporter/attachment 19 pass. Typecheck/build/diff-check green. No lint script defined.

Frontier reviews: gpt-6.1-sol scoped approach approved; final Opus 5.5 scoped code review no material blocking findings. Remaining lows: sibling-ENOENT fault injection and standalone thinking-only-message API edge not live covered; abrupt death may orphan a private temp file. Fail-closed pruning retained deliberately rather than silently resending history.

No production service changes. Scratch listeners closed, isolated auth/config/session state removed. No push, PR, merge or install.

## 2026-10-01 follow-up: transcript-derived anchor and fail-safe pruning

Fixes for two critic blockers. B1: the retained thinking used to depend on a caller-supplied checkpoint, so a hidden digest row written last could take the open tool loop's thinking. B2: any prune error failed an already-delivered turn and poisoned every later resume.

Rule applied in this follow-up, superseded by the next section (source: platform.claude.com `build-with-claude/thinking`, "Thinking with tool use" / "Preserving thinking blocks", and `preserved-thinking`, prefix check):
- A tool-use loop is one assistant turn, and its thinking must be returned with the tool results. While any assistant group after the last plain user prompt has a `tool_use` with no real `tool_result`, every group of that turn keeps its thinking.
- Passthrough hook blocks are not results. Hidden digest groups (answers to a hook-block row) and sidechain rows are never anchors.
- Prior turns lose all thinking. That is a removal from the start of history, which the prefix check allows, so the retained blocks stay an unbroken run.

The checkpoint is still passed by every call site, now including the four fresh-replay and model-fallback attempts. It only adds groups to keep.

Failures are typed (`malformed_row`, `unparseable_line`, `checkpoint_absent`, `transcript_not_found`, `transcript_ambiguous`, `not_regular_file`, or an errno code). They are logged as `session.prior_thinking_prune_failed {mode, reason}` and leave the transcript byte-identical. Only `SessionLifecycleError` propagates. A truncated trailing line is kept byte-identical while the rest is pruned. A successful prune logs `session.prior_thinking_pruned {mode, messages, blocks, bytesBefore, bytesAfter}`. The transcript is found through the locator's `projectDir`; scanning every project only happens for legacy locators.

Live E2E (same harness, Linux, Node v22.22.1, SDK 0.2.141, CLI 2.1.284, `claude-opus-5-5`, Pi-shaped streaming HTTP, adaptive thinking, effort high). Both arms send identical bodies. First-request prompt totals: off 2,650 (cache write 2,648), on 2,819 (cache read 2,297 + write 520). The 169-token difference repeats the earlier run's and is not explained by the flag, which cannot act before a resume. Compare growth, not absolute totals.

| Flag | Req | Input | Cache read | Cache write | Output | Prompt | Growth | Thinking deltas | Tool calls | Upstream thinking idx (open-turn start) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| off | 1 | 2 | 0 | 2648 | 2749 | 2650 | — | 14 | 0 | [] (0) |
| off | 2 | 4 | 2648 | 2948 | 1570 | 5600 | 2950 | 7 | 0 | [0] (1) |
| off | 3 | 4 | 5596 | 1663 | 129 | 7263 | 1663 | 2 | 1 | [0,1] (2) |
| off | 4 | 2 | 7259 | 173 | 123 | 7434 | 171 | 1 | 1 | [0,1,2] (2) |
| off | 5 | 2 | 7432 | 165 | 99 | 7599 | 165 | 0 | 1 | [0,1,2,3] (2) |
| off | 6 | 2 | 7597 | 141 | 127 | 7740 | 141 | 1 | 0 | [0,1,2,3] (2) |
| off | 7 | 4 | 7738 | 156 | 1222 | 7898 | 158 | 5 | 0 | [0,1,2,3,5] (6) |
| off | 8 | 4 | 7894 | 1247 | 1953 | 9145 | 1247 | 10 | 0 | [0,1,2,3,5,6] (7) |
| on | 1 | 2 | 2297 | 520 | 2480 | 2819 | — | 10 | 0 | [] (0) |
| on | 2 | 4 | 2297 | 1667 | 1847 | 3968 | 1149 | 8 | 0 | [] (1) |
| on | 3 | 4 | 3964 | 1057 | 134 | 5025 | 1057 | 2 | 1 | [] (2) |
| on | 4 | 2 | 5021 | 178 | 150 | 5201 | 176 | 1 | 1 | [2] (2) |
| on | 5 | 2 | 5199 | 192 | 105 | 5393 | 192 | 0 | 1 | [2,3] (2) |
| on | 6 | 2 | 5391 | 147 | 119 | 5540 | 147 | 0 | 0 | [2,3] (2) |
| on | 7 | 4 | 5021 | 562 | 2362 | 5587 | 47 | 12 | 0 | [] (6) |
| on | 8 | 4 | 5583 | 1070 | 1274 | 6657 | 1070 | 5 | 0 | [] (7) |

All 16 requests made exactly one upstream generation with HTTP 200 and no client error. Requests 3–6 are a three-step client tool loop with tool_result continuations. In the on arm, the open turn's thinking (assistant indices 2 and 3) was returned with every continuation and accepted; no prior-turn thinking ever reached the API. Growth from request 1 to request 8: off 6,495, on 3,838 (request 2 to 8: off 3,545, on 2,689). The first-request totals differ, so only within-arm deltas are evidence. Final prompt: off 9,145, on 6,657.

Budget thinking: a client `thinking: {type: "enabled", budget_tokens: 2048}` request on this path reached the API as `adaptive` (HTTP 200, thinking streamed). Opus 5.5 accepts only adaptive (`thinking-troubleshooting`), so an `enabled` arm cannot be exercised on this model. It is not covered.

Verification: the new HTTP regression file (`proxy-prior-thinking-loop.test.ts`, 18 cases: digest-last on both wired paths, each of the four fresh call sites, and six fault sources × stream/non-stream) fails 18/18 against b755857's sources and passes 18/18 after the fix. Pure tests: 23 pass. `npm test`: 4,764 pass, 1 skip, 2 fail:
- the Antigravity Node-TypeScript test, which also fails on origin/main because this distro Node has no TypeScript;
- one `error-reporting` real-process crash race, which passes 16/16 three times in isolation.

Typecheck and build are green. Test isolation repairs: `telemetry-settings-routes` used a raw logger `mock.module` that silenced every installed logger, and three `models` mocks stubbed `hasExtendedContext` to `false`, which broke `replay-budget` once the file order changed.
Not verified live: the telemetry events (the harness runs silent), prune-failure paths against a real SDK crash, and the four fresh-fallback call sites (mocked only).

## 2026-10-01 recheck: newest-message-only retention

Pi turns are usually one long tool loop, so keeping every step's thinking until the next plain prompt left most of the bloat. The live question: does the API accept a tool_result continuation where only the newest assistant message keeps its thinking and earlier steps of the same loop have none?

The harness now asserts that, with the flag on, only the newest assistant message in each upstream request carries thinking. Same harness and versions (Linux, Node v22.22.1, SDK 0.2.141, CLI 2.1.284, `claude-opus-5-5`, adaptive, effort high). Both arms send identical bodies. First-request prompt totals: off 2,653 (cache write 2,651), on 2,822 (cache read 2,299 + write 521). The same ~169-token gap appears before any resume, so compare within-arm growth only.

| Flag | Req | Input | Cache read | Cache write | Output | Prompt | Growth | Thinking deltas | Tool calls | Upstream thinking idx (of assistants) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| off | 1 | 2 | 0 | 2651 | 2702 | 2653 | — | 12 | 0 | [] of 0 |
| off | 2 | 4 | 2651 | 2901 | 2567 | 5556 | 2903 | 11 | 0 | [0] of 1 |
| off | 3 | 4 | 5552 | 2660 | 222 | 8216 | 2660 | 3 | 1 | [0,1] of 2 |
| off | 4 | 2 | 8212 | 266 | 163 | 8480 | 264 | 1 | 1 | [0,1,2] of 3 |
| off | 5 | 2 | 8478 | 205 | 97 | 8685 | 205 | 0 | 1 | [0,1,2,3] of 4 |
| off | 6 | 2 | 8683 | 139 | 155 | 8824 | 139 | 0 | 0 | [0,1,2,3] of 5 |
| off | 7 | 4 | 8822 | 184 | 2194 | 9010 | 186 | 10 | 0 | [0,1,2,3] of 6 |
| off | 8 | 4 | 9006 | 2219 | 1471 | 11229 | 2219 | 4 | 0 | [0,1,2,3,6] of 7 |
| on | 1 | 2 | 2299 | 521 | 2641 | 2822 | — | 12 | 0 | [] of 0 |
| on | 2 | 4 | 2299 | 1787 | 2416 | 4090 | 1268 | 13 | 0 | [] of 1 |
| on | 3 | 4 | 4086 | 1097 | 136 | 5187 | 1097 | 2 | 1 | [] of 2 |
| on | 4 | 2 | 5183 | 180 | 109 | 5365 | 178 | 1 | 1 | [2] of 3 |
| on | 5 | 2 | 5183 | 251 | 89 | 5436 | 71 | 0 | 1 | [3] of 4 |
| on | 6 | 2 | 5183 | 362 | 163 | 5547 | 111 | 1 | 0 | [] of 5 |
| on | 7 | 4 | 5545 | 159 | 2314 | 5708 | 161 | 11 | 0 | [] of 6 |
| on | 8 | 4 | 5704 | 1173 | 1310 | 6881 | 1173 | 4 | 0 | [] of 7 |

Answer: accepted. Requests 4 and 5 are tool_result continuations of one three-step loop (requests 3–6). Request 5 sent thinking only on assistant message 3, the newest, while step 2 of the same loop arrived without its thinking. The API returned HTTP 200 and the model kept going: thinking streamed and it made the next tool call. Request 6 (the final tool_result, answered with text) likewise returned 200. All 16 requests made exactly one upstream generation with HTTP 200 and no client error.

Growth from request 1 to request 8: off 8,576, on 4,059 (request 2 to 8: off 5,673, on 2,791). Final prompt: off 11,229, on 6,881.

Rule now applied:
- The pending group is the newest main-chain API message holding a `tool_use` with no real `tool_result` after it. Only it keeps its thinking. The rule does not depend on file position or on plain user rows, so a plain prompt written after an unanswered call cannot suppress it.
- Passthrough hook blocks are not results. Hidden digest groups and sidechain rows are never anchors.
- An API message whose rows hold only thinking is left byte-identical, so no message is emptied.
- A target missing from the leased locators is logged as `target_not_leased` and skipped. Only the unjoined-writer fence propagates.

Budget probe: `thinking: {type: "enabled", budget_tokens: 2048}` again reached the API as `adaptive` (HTTP 200, 3 thinking deltas); not exercisable on this model.

Not covered live: a thinking-only API message (unit-tested only), the `target_not_leased` path (mocked HTTP only), and the telemetry events (the harness runs silent).
