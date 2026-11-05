# Final-source #1220 E41 outcome audit — 2026-11-04

## Verdict

**FAIL_STOPPED. Current E41 acceptance remains red.** Baseline chainJSON and candidate chainJSON genuinely pass their original fixture and independently linked native cache-prefix checks. Candidate chainSSE fails on query 2 after the first real read result, before the second read or final answer. ParallelJSON and parallelSSE were correctly not run. Neither the two passes nor a separate actual-client pass waives this current failure. No green-seeking rerun or speculative prompt change is supported.

Reviewed source heads recorded by the frozen plan: baseline `16c214941bf3f05aa4015a70d8b81bd94857a88f`; candidate `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`. This is the predeclared five-arm qualification, not mode-by-mode baseline parity. The prior assessment at `/Volumes/DevSSD/meridian/e41-completion-assessment.md` remains accurate: no evidence-backed prompt/replay correction is established, and prior failures retain their own unresolved causes.

## Decisive candidate chainSSE evidence

Read `candidate-chainSSE-worker.json`, its supervisor, and the original owned `qualified-e41-report.json`, now durably escrowed as `candidate-chainSSE-original-fixture.json`.

- Q1 publishes assistant checkpoint `6cd07af9-7855-4cf0-89b7-cd8f937ceffe`, message `msg_011CgiEbMUWhDasg8VFQvdBg`, in session `97974d4d-c1b2-452c-b49a-2e17a5748262`. Supported history 1 contains that tool-use row. Q2 resumes this exact session/checkpoint with `forkSession=true`, supplies one completed prompt item, and targets `a5f77845-4d9c-4c0b-a2d9-245d2fc22547`.
- Q2 native `message_start` events **71 and 86** identify two distinct messages, `msg_011CgiEbk4KcfuqmzMpU26Y8` and `msg_011CgiEbraDzwxFScjJPjgAJ`. Both report **`claude-opus-5-5`**, zero output, and cache read 2993. They are two native responses within Q2, not two completed SDK queries.
- Event **91** is an error assistant with a text block and zero usage. Event **92**, at the same SDK message order 34, records **`native-refusal`**. Frozen v2 lines 216–219 produce that reason only from native `stop_reason === "refusal"` or a native refusal content block. The observed content metadata contains text, not a refusal block, so the unchanged classifier ties this event to the native stop-reason branch. It does **not** use a refusal-word regex. A generic error alone would be `native-terminal-error`.
- The report does not separately serialize the literal `stop_reason` property. The finding above links the retained event to the hash-verified classifier, rather than claiming a retained raw native-field dump. This is positive native refusal evidence, not an authentication inference. No provider model switch is observed in the native starts. The zero-usage error assistant has only an unrecognized-model digest; it is not a published successful model checkpoint or evidence of a successful alternate model.
- Result event **99** has `isError=true`, `toolBoundaryCandidate=false`, `subtype=success`, and zero output. Its usage read **5986** is the aggregate of the two 2993 reads. The `success` label does not override the error/refusal, and **5986 must never be used as one response's cache read**. The later iterator rejection is not the first failure indication.
- The original fixture fails `E41 provider error; stop before another model request` (`ERR_ASSERTION`). There is no Q3. Worker `result=FAIL`, `stopReason=native-refusal`, `evidenceValid=true`, and `observerFailures=[]`. The supervisor closes with code **1**, no timeout/output-bound failure, and null signal.

The two 2993 reads each equal Q1's published cached prefix 763+2230. That does not make the failed arm a cache/completion pass. No second successful assistant checkpoint, final answer, follow-up, immutable-parent completion check, or final scrub-invocation check was reached. `cacheMisses=[]` here is not proof that those missing predicates passed. The current refusal occurs at Q2; do not confuse it with the prior baseline refusal at Q4 final-answer generation.

## Native 95% accounting for the two passing arms

Use the published source assistant's **cache read + cache creation** as the prior cached prefix, consistent with unchanged `CACHE_FLOOR=0.95`. Compare that with the next query's **one actual native response** cache read. Do not include output tokens or fresh input in this prefix denominator. Do not sum result aggregates, attempts, repeated history snapshots, or thinking/tool rows that share one message identity.

Each passing arm has exactly five native message starts and five matching native assistant messages, one per query. For each continuation I linked: pre-query supported-history session → checkpoint UUID/message ID → prior native assistant → next query's resume/target session → native `message_start`/assistant message ID and read. Each link is unique; no ambiguous alternative was selected. Histories repeat ancestral rows, but each source message is counted once. These particular PASS reports have no separate thinking rows to add.

### baseline-chainJSON

| Next query | Published source session | Checkpoint UUID / message ID | Native next-response message ID (event) | Prior read + created | Actual read | Fraction |
|---|---|---|---|---:|---:|---:|
| Q2 | `ece783b7-bd83-4196-8ef1-0ba15cc4d9e6` | `dea9adbb-59be-4b66-9db0-50305bbff2fc` / `msg_011CgiET7UAwZadrPFUTPKen` | `msg_011CgiETZUMjJsGepsPEYXa6` (71) | 0 + 2999 = 2999 | 2999 | 100% |
| Q3 | `5411f67d-2551-46f6-bdf6-3cd581bf5c60` | `1535bc91-920c-48e7-ad5a-f2ddc7e78196` / `msg_011CgiETZUMjJsGepsPEYXa6` | `msg_011CgiETtbYt7grLHvocPKWi` (130) | 2999 + 136 = 3135 | 3135 | 100% |
| Q4 | `4e746283-4dda-4f9f-a8e3-7925b800b869` | `81a41cab-8435-4f9b-a038-8eba15070752` / `msg_011CgiETtbYt7grLHvocPKWi` | `msg_011CgiEUEX7dctcDS2NrJSEj` (189) | 3135 + 136 = 3271 | 3271 | 100% |
| Q5 | `5762c1f3-c6b9-4709-8a7c-ba5c8f546d60` | `c3120948-608b-4b38-8bc0-d359006db1f3` / `msg_011CgiEUEX7dctcDS2NrJSEj` | `msg_011CgiEUUfAgBTtHKfzCzadk` (234) | 3271 + 136 = 3407 | 3407 | 100% |

The four source snapshots are histories 1–4, assistant row indices 1, 3, 5, 7. Their matching native assistant events are 39, 98, 157, 204. The next-query target sessions and response events also agree. Q2–Q4 explicitly name the checkpoint UUID. Q5 has no explicit checkpoint: it resumes the final-answer session, whose pre-query snapshot ends at the uniquely matching Q4 assistant row. This is the normal full-session follow-up, not an arbitrary checkpoint choice.
### candidate-chainJSON

| Next query | Published source session | Checkpoint UUID / message ID | Native next-response message ID (event) | Prior read + created | Actual read | Fraction |
|---|---|---|---|---:|---:|---:|
| Q2 | `05ad4a28-b402-4756-b72b-5c6fe70208a1` | `3d578024-116f-4499-ab15-78abfb06d045` / `msg_011CgiEXGNZenPdZGhZCX1UP` | `msg_011CgiEXgF21zJoXsfgTKCtC` (71) | 763 + 2236 = 2999 | 2999 | 100% |
| Q3 | `84a7f1c0-3037-463e-a35b-f5d65af2018f` | `707017c9-5943-422c-adbc-b60bd278b0fb` / `msg_011CgiEXgF21zJoXsfgTKCtC` | `msg_011CgiEXx6Fem4q4HRQMz26d` (130) | 2999 + 136 = 3135 | 3135 | 100% |
| Q4 | `5c6b094e-161a-4e13-bb3b-20c40875efea` | `ed3f8bce-1a2d-4cb4-a66a-f21f9bea8455` / `msg_011CgiEXx6Fem4q4HRQMz26d` | `msg_011CgiEYGbVreTnJRJFac5kn` (189) | 3135 + 136 = 3271 | 3271 | 100% |
| Q5 | `eb72c377-53f7-44d0-b36d-84ca569e7155` | `0c8b9bbe-1d93-4140-a469-da01c6a5ac7a` / `msg_011CgiEYGbVreTnJRJFac5kn` | `msg_011CgiEYVvBY6JTgG3xw7sUX` (234) | 3271 + 136 = 3407 | 3407 | 100% |

The four source snapshots are histories 1–4, assistant row indices 1, 3, 5, 7. Their matching native assistant events are 39, 98, 157, 204. The next-query target sessions and response events also agree. Q2–Q4 explicitly name the checkpoint UUID. Q5 has no explicit checkpoint: it resumes the final-answer session, whose pre-query snapshot ends at the uniquely matching Q4 assistant row. This is the normal full-session follow-up, not an arbitrary checkpoint choice.

**All eight linked continuation checks are 100%, above 95%.** These percentages measure retained prior cached prefix, not the percentage of the next total request served from cache. Baseline Q1 starts with 0 read +2999 created; candidate Q1 starts with 763 read +2236 created. They independently establish the same 2999 prefix; the warm portion in candidate Q1 is not an inherited baseline acceptance claim.

### Original HTTP/behavior assertions remain separate

Both original chainJSON verdicts are PASS: batches `[1,1,1]`, three delivered real results, exact model, one real result per delivered call (`activeAnswerProblems=[]`), durable distinct forks, final quotations and follow-up, and unchanged source histories. Their original HTTP accounting passes (`cacheMisses=[]`); that is additional evidence, not the substitute used for the native calculation above. Each arm has five distinct target sessions. Supported-history snapshots 1–4 exactly equal re-read snapshots 6–9 for the same parent sessions. All recognized native model starts are Opus5.5. The fixture has five client-plugin calls and five final scrub invocations, zero errors.

## Cleanup and durable evidence

The original owned reports record **11/11**, **11/11**, and **5/5** joined child handles respectively. Every child has exit/close/stdout-close/stderr-close witnessed, no spawn failure or signal failure. Some child exit codes are 1; they are not falsely described as all-zero exits. Both PASS supervisors close code0; failed SSE supervisor closes code1. The failed supervisor's `normalFixtureCustody=false` is the code's conjunction of successful supervisor result and fixture join. It is **not** evidence of missing joins: the original failed fixture explicitly records `joined=true` and all five closure witnesses.

Durable root: `/Volumes/DevSSD/meridian/review-1220-evidence-20261103/docs/maintenance/evidence/1220-review-20261103/final-source-1220-20261104`.

The three durable worker and supervisor aliases are byte-identical to their corresponding `e41-frozen` reports. Each durable original-fixture report exactly equals the inspected owned original with only the private `root` locator removed; all child rows and verdict fields match. Thus the failure and original cleanup proof do not depend only on the private temporary fixture roots.

| Arm | Worker SHA256 | Supervisor SHA256 | Durable original verdict SHA256 |
|---|---|---|---|
| baseline-chainJSON | `b9accad92942494981b9b354c3295da433fabe3d677a83053c2e9cc017125721` | `ee5cb764b7b0eb274cac3933c6d0836e695a729a070c3434c1216c9e8940be8f` | `24942a4c2ccf6088dc42d85177340b774a43cf0f58031e3e0342588e7cafd027` |
| candidate-chainJSON | `8f24d8bd82f7c2953099eca7d3e71e687c09dfb1150f119990394d3c55bea3b8` | `41267db0c689f2289c8e6a12d17bed160d6a2527cf06d9111c7ec40ef81bed10` | `cf15226b55930419856dfda8025939f2ee4223e206a083732cce8538e04a9059` |
| candidate-chainSSE | `787eed013936479e66caec3af4b06e5f64695af6ef2abce2376c32fdb1f89331` | `429c94cfb0280d67a232fc38a87022582ff7b96c49d4c50e7e9621d82d2be2bc` | `92512cd5de3a13cbc8449eeb26b6c41150d1a56913c40638777a875f4cab9f1f` |

## Source/replay review and identity

Python hashes independently match both final source fixture copies `9306af7e3e47c5ed55cb693d12a51a692d0350ae4614f162e8881861fd9fe3bf`, replay helper `487765c355f1ef507a636d6b4e112368529b3d56c0228184c05ec63f0270f757`, and frozen v2 plus its durable copy `3dee3502128271672a68cb074205f9cc06d2b45572a955511008c1490100f4ff`. Client preflight, scrub preflight and process-custody helper hashes also agree between sources and with the identity manifest. Both installed SDK package metadata versions are `0.2.141`. The selected native bytes hash to `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`, matching the plan's **2.1.296**, not the installed unselected 2.1.318 dependency. Native version execution was not repeated. Reports identify Darwin/arm64 and Opus5.5. Both installed matching V1 plugin bytes hash to `c640cc02817d9ad05d5b61f6bd906fdccdb4ef71be42d11981aecaeb84bc434e` and original reports retain the invoked plugin path/package identity.

The unchanged fixture creates only owned `a.txt`, `b.txt`, `c.txt` with alpha/bravo/charlie. It asks for ordinary ordered reads and a final quotation. It executes returned calls only for that file allowlist and returns actual contents under each emitted original `tool_use_id`. The shared JSON/SSE parser retains assistant fields, thinking/signature/redacted data and complete tool input; replay uses `structuredClone(blocks)`, not a text/tool-only projection. Q1's retained metadata shows one tool-use block, not an omitted thinking block. No concrete malformed replay, mismatched result ID, missing opaque block, unsupported task, or contradictory prompt defect is established by this record. That is a scoped finding, not proof that all model-facing assembly is faultless. Opaque digests cannot reconstruct the complete final model-facing request or explain the model's refusal.

## Limits and disposition

This audit is offline: Python file reads/hashes and the requested new report only. No commands, tests, builds, network/model/SDK calls, credential/grant reads, private SDK transcripts, or raw client/customer logs were used. No source, helper, prompt, model/native tuple, timeout or threshold was changed. Recorded Git heads and runtime version provenance rely on the parent's frozen receipts; I did not refresh Git/GitHub or execute the native binary. Parent-reported installed-artifact/full-manifest verification and actual-client success are separate work, not requalified here.

This E41 fixture is an installed-plugin **protocol host**, not the OpenCode executable. The failed arm lacks its final runtime scrub witness; preflight count0 alone proves neither that scrub ran nor that it was absent. Original historical 3332→3132 (<95%), native.284 scope and other causal holds remain unresolved. The two new JSON passes do not explain or erase them. More importantly, the **current** candidate matrix failed and stopped, independently of those historical holds. Preserve it red; parallel modes remain NOTRUN, and the separate local npm red remains a merge hold. No waiver, release, speculative correction, or further arm/rerun is recommended by this audit.
