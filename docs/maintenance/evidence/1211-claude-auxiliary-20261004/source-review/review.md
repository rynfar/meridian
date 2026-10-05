# Meridian #1211 complete semantic adversarial review — 2026-10-04

**Disposition: accept with maintainer corrections; do not accept the submitted head as-is.** The classifier isolation addresses real product-fit symptoms reported by its author: main-history replacement and permission checks waiting behind their own conversation. Its detector stays in the adapter; pure lineage still has downward dependencies; the existing keyed fork/subagent behavior is preserved. The implementation needs the authority/cancellation/priority corrections below, plus a safer and discriminating affected-flow harness. This is not an owner-directed defer. Root may prepare a corrected internal integration if the separately audited public boundary stays unchanged. Actual Linux/Claude Code/Sonnet acceptance remains open.

## Identity, authorship, current status and scope

- Exact source: `22566e8ac0b9e079bb0d28c0eb4aa05207c56070`; exact base: `f299fe06e72411b786380b5212edea79cd13966a`; current main compared: `8e1c8bf738d7372ded01f28e99d6ec167acaf76f`.
- Refreshed [source PR #1211](https://github.com/rynfar/meridian/pull/1211) is OPEN at that same head/base. Body, five commits, complete comments/reviews (both empty), and seven checks were captured in `pr-live.json`. Six executable checks succeeded; changelog duplication was skipped. Source test is job111459500019 in run37210148913; it is not CI on a maintainer correction/current-main integration.
- Contributor: Noah Passalacqua (`passabilities`, verified authored email `noah@passabilities.dev`). Actual source commits: `b06c0aab235ee01e9b2c17715deeabbd08c22a81` (AuthorDate2026-10-01T00:13:30Z), `b8d2bbeeeb37fa1d797981c0da17efc1d871014d` (00:16:40Z), `cdb7dce8299c137f0adc677d012f99e8db412f95` (00:20:53Z), `76d72bac5a0482dbd4e797a7ff670fb30cde6c56` (00:37:55Z), and `22566e8ac0b9e079bb0d28c0eb4aa05207c56070` (02:11:01Z). No cherry-pick or SHA remapping was performed by this reviewer. Root should preserve actual Author/AuthorDate and put maintainer corrections separately.
- All **11 changed files / 28 changed hunks** were read semantically, with relevant actual callers and test controls. `review.json` records Git blob IDs, source/patch SHA256s, line counts and all hunk headers. `source-complete.diff` uses `git diff --full-index --binary` over exact source/base; SHA256`8ac45355055636fbfd125f427c57a313b7e8d1a1f0bf979fac75c4c74bb35d19`.
- Read current AGENTS, ARCHITECTURE (adapter, dependency, cancellation and lineage sections), API contract, relevant E2E, upstream incorporation/verification and evidence skills. No source edits, installs, tests, probes, model calls, credential reads, private transcript access or GitHub mutations. Temporary report writes only. No subagent/delegation.
- The source changes no `ProxyConfig`, `ProxyInstance`, package exports, public Transform graph or health/profile/messages response shape. Package has only `.` export targeting server declarations; AgentIdentity is not a demonstrated public configuration interface merely because its TypeScript interface is exported internally. Another reviewer owns the definitive API-exposure audit. Preserve that distinction; do not reopen owner approval solely from the hook's source export. No new public contract approval is claimed here.

## Per-file semantic coverage

| File | Hunks | What was inspected |
| --- | ---: | --- |
| `ARCHITECTURE.md` | 1 | Changed adapter-method row checked against durable lookup and checkpoint/fallback behavior; it overstates skipped session lookup (F1). |
| `E2E.md` | 2 | Entire new E71 section and index entry reviewed, including reported Linux/SDK/CLI/model baseline and working-proxy claims versus missing raw exact-head evidence and actual harness (F5/F6). |
| `scripts/e2e-claude-code-auto-mode.mjs` | 1 | All 232 lines read: CLI selection/version, environment/config/auth, proxy/relay, four real-client invocations, checks, timeout/join and cleanup (F5/F6). |
| `src/__tests__/claude-code-adapter.test.ts` | 2 | All changed detection tests/import plus session-ID and parent fixtures read; explicit-header precedence good, long ordinary XML history and malformed tools/stream discrimination absent (F4). |
| `src/__tests__/lineage-divergence-reason.test.ts` | 4 | All hunks and full tests read: pure cause precedence, key override exception and logging identifiers; caller-side checkpoint promotion can still overrule it (F1). |
| `src/__tests__/proxy-concurrency-coordination.test.ts` | 2 | All changed hunks plus SDK controls, before/after hooks, session-key request fixtures and adjoining #1043/race tests read; meaningful two-permit lease bypass and mapping/resume positives but failure/cancel/priority/full-history negatives absent (F1-F3). |
| `src/__tests__/proxy-divergence-reason-log.test.ts` | 1 | All changed hunks and complete fixture/assertion module read; short synthetic header/shape logs are checked, not durable authority or checkpoint refusal (F1). |
| `src/proxy/adapter.ts` | 1 | Full interface read; internal optional predicate composed through built-in instances. Comment is lineage-only, not zero durable reads. Public exposure audit owned by another reviewer. |
| `src/proxy/adapters/claudecode.ts` | 2 | Full adapter read: metadata identity/parent parser, header-over-shape precedence, selection/tool boundary and classifier heuristic (F4). |
| `src/proxy/server.ts` | 9 | All changed hunks, outer admission/tree/leases, priority dispatch/authority/exposure, checkpoint promotion, resume/fork/query selection, success/error/abort/recovery mapping/tool-cache consumers traced (F1-F3/F5). |
| `src/proxy/session/lineage.ts` | 3 | All hunks, independent cause and formatter read; keeps pure downward dependency and log-only cause separate from exported Transform divergence union. |

## F1 — P1: Auxiliary independence is reversible through checkpoint promotion and then destructive resume fallbacks

Locations: `src/proxy/server.ts:2709-2750`, `src/proxy/server.ts:2899-2909`, `src/proxy/server.ts:3237-3244`, `src/proxy/server.ts:4048-4054`, `src/proxy/server.ts:4109-4115`, `src/proxy/server.ts:5217-5223`, `src/proxy/server.ts:5274-5280`.

Static exact-source trace, not an executed reproducer. Header auxiliary is accepted independently of shape. Matching complete stored tool-checkpoint history promotes the independently classified request to continuation; the resumed SDK refusal/model fallback unconditionally evicts the same durable main mapping using its captured generation. Ordinary success publication gates still remain independent, so it is incorrect to claim the ordinary classifier success overwrites mappings on this head.

Correction: Make auxiliary no-resume status irrevocable before any checkpoint/failback override and defend fallback destructive operations. Preserve ordinary keyed checkpoint and anonymous Pi contracts.

Proposed discriminating controls (not executed):

- Seed an actual tool checkpoint and cache, send full prefix+exact complete results with auxiliary header, assert no SDK resume/resumeSessionAt and exact mapping/generation/history unchanged.
- Inject known No message found with message.uuid refusal and extra-usage resumed fallback in JSON and SSE; auxiliary must never evict main authority.
- Same payload with main class must retain existing checkpoint resume; partial/foreign tool IDs remain ordinary safe replay.

## F2 — P1: Same-key auxiliary tree registration misses main cancellation and lets auxiliary abort cancel main descendants

Locations: `src/proxy/server.ts:7740-7747`, `src/proxy/server.ts:7875-7894`, `src/proxy/server.ts:7533`, `src/proxy/sessionTree.ts:109-116`, `src/proxy/sessionTree.ts:145-198`.

Static registry/control-flow proof. Both main and unlinked auxiliary are liveRequestsFor(K), but client/body cancellation invokes cancelDescendants(K), which omits same-key entries. The auxiliary also cascades from K, reaching unrelated live children that declared parent K. A stamped ancestor P still reaches both main and auxiliary when both name P; explicit cancelSubtree(K) includes both.

Correction: Give auxiliary cancellation-only request identity linked beneath the conversation while preserving raw routing/mapping/session key; do not change published session headers. Auxiliary teardown must only stop itself/its own genuine descendants. Main/ancestor/explicit cancellation must join auxiliary request cleanup.

Proposed discriminating controls (not executed):

- Hold main K and two auxiliary calls on K with sufficient SDK permits; main socket abort and streamed response cancel must reach all side-call SDK abort controllers and join before permit release.
- Abort one auxiliary socket/body: main K, sibling auxiliary and main child C(parent K) must continue and publish normally.
- Abort ancestor P with main K(parent P), auxiliary on K and child C; all declared descendants stop, independent session J survives.

## F3 — P2: Auxiliary priority failover rewrites the main conversation affinity

Locations: `src/proxy/server.ts:1922-1929`, `src/proxy/server.ts:2018-2024`, `src/proxy/server.ts:2079-2092`, `src/proxy/server.ts:1466-1474`, `src/proxy/session/fingerprint.ts:112-119`.

Static reachable built-in Claude Code path, acknowledged in live PR body. Both requests use raw session ID as process-local priority assignment key. Without durable attestation, successful auxiliary fallback B replaces main affinity A. After A cooldown recovers, the next main request retains B and loses its A-scoped resume. Real account exhaustion marking is a separate legitimate pool fact; do not suppress it merely to preserve affinity.

Correction: Allow bounded account dispatch for the side call without main affinity write, route publication/promotion or durable claim. Retained main route may inform placement read-only. No built-in adapter currently combines Claude Code auxiliary detection with trusted OpenCode routing identity; future composed durable publication is a protection/test gap, not claimed current live failure.

Proposed discriminating controls (not executed):

- Publish main on A, make auxiliary A refuse and B succeed, recover A eligibility, then assert main stays on A/resumes original target; repeat priority and active-priority.
- Hold concurrent main/aux and cancel/fail auxiliary after exposure; mapping, route/attempt metadata and main assignment unchanged.
- Ordinary main pre-exposure account failover still adopts B; late exposed failure still never replays on another account.

## F4 — P2: The shape fallback accepts ordinary XML-stopped keyed histories

Locations: `src/proxy/adapters/claudecode.ts:148-159`, `src/__tests__/claude-code-adapter.test.ts:291-345`.

Static valid-input counterexample, not a claim an installed CLI emitted it. The predicate ignores messages, count, roles, system/classifier envelope, model and max_tokens. A normal three-message history with tools:[], stream:false, same metadata key and XML stop </block> returns true, silently skips publication/serialization. The contribution only describes observed classifiers as one/two user messages. Null/malformed tools are deliberately admitted by tests.

Correction: Constrain fallback to positively identified versioned classifier semantics, with ordinary multi-turn XML responses and malformed fields as negative controls. Keep exact auxiliary header authoritative and every other explicit class negative. Obtain sanitized actual classifier shape before making broader no-false-positive claims.

Proposed discriminating controls (not executed):

- Ordinary three-message user/assistant/user XML response with either verdict stop is normal, resumes/publishes and serializes.
- False positives: similar XML text/prose, tool-result continuation, assistant-authored envelope, null/malformed tools, stream omission/invalid values, unknown stops, unrelated adapter.
- Observed one/two-message classifier variants still isolate; main/compaction/workflow/unknown explicit headers always remain normal.

## F5 — P1 evidence safety: Live harness inherits owner proxy configuration/auth and does not guarantee joined cleanup

Locations: `scripts/e2e-claude-code-auto-mode.mjs:39-51`, `scripts/e2e-claude-code-auto-mode.mjs:92-123`, `scripts/e2e-claude-code-auto-mode.mjs:140-145`, `scripts/e2e-claude-code-auto-mode.mjs:230-232`, `src/proxy/server.ts:9881-9897`, `src/proxy/server.ts:9979-10027`.

Static script/runtime trace. Only client CLAUDE_CONFIG_DIR and store/workdir are isolated; proxy MERIDIAN/CLAUDE/config/HOME/XDG/plugin/routing state remains inherited. startProxyServer loads plugins, runs sweep/update and starts real credential refresh/keepalive unless readonly. Child scrub leaves ANTHROPIC_API_KEY and other credentials inherited despite dummy AUTH token. Four private mkdtemp directories are never removed. Failure before trailing shutdown skips cleanup, and the five-minute SIGTERM timer has no forced escalation/bounded join. No credential corruption or external traffic was observed by this review.

Correction: Use allowlisted fresh proxy/client configuration/XDG/workspace roots, bounded owner-approved read-only credential snapshot, explicit real client/SDK/executable/package identities, reserved listener ports, guarded startup and finally cleanup. Clear competing auth variables from client. Bound/kill/join process trees and streams on errors/timeouts; remove owned private state only after terminal children; retain sanitized artifacts and source-unchanged booleans without credential hashes.

Proposed discriminating controls (not executed):

- Mock/read-only rehearsal with inherited fake config/profile/plugin/token variables proves client dummy auth and proxy fresh configuration selection.
- Controlled early bind/startup error, client timeout ignoring TERM, malformed result and interrupted controller all leave zero owned listeners/children/private fixture directories.
- Real source/installed package gate records actual selected SDK/CLI/model/platform and credential immutability, with no private transcript file reads.

## F6 — P2 evidence discrimination: E71 can pass with no shape-path classifier and correlates header proof by totals only

Locations: `scripts/e2e-claude-code-auto-mode.mjs:178-195`, `scripts/e2e-claude-code-auto-mode.mjs:202-219`, `E2E.md:5929-5957`.

Static assertion counterexample. If turns1-3 have no classifier, turn4 has one labelled auxiliary and all main turns resume, aux.length>0/header-count checks pass. No check requires any shape-only auxiliary. Equal aggregate t4 counts also permit opposite request misclassification to cancel out, without per-request correlation. Classifier sessionWait is reported only, so no timing ceiling is established.

Correction: Require positive headerless classifier occurrence separately and correlate every recorded request class/body/count/session/request ID with its exact proxy decision. Assert zero turn-lease wait at sufficient SDK capacity and distinguish SDK admission wait. Assert deterministic request/action/state receipts rather than substring model wording.

Proposed discriminating controls (not executed):

- Disable shape predicate only: header path may pass but complete E71 must fail.
- Swap isolation decisions for one auxiliary and one main under header path: equal totals must still fail.
- Delay the actual session lease path: timing/entry discriminator fails while preserved semantic resume check remains unchanged.

## Protections that do survive this source

The once-decided `requestMeta.auxiliaryRequest` flows through cloned attempt metadata and correctly skips arrival snapshots, local turns and cross-process turns. Ordinary short classifier success has no SDK resume and does not write/evict the main mapping. Success, interrupted cleanup and recovered terminal publication mostly keep `!isIndependentSession` gates; the F1 resume retry paths are the material exception. The side call receives a pre-journaled fresh target, so lifecycle tracking of its own physical transcript remains useful even when it never publishes the conversation mapping. The recovery-tool block explicitly skips the auxiliary cause before reading or consuming cached one-shot recovery, preserving the main grant in the shown path. Recovery publication/cache writes are also excluded for a keyed independent auxiliary.

The contributor declined a recovery-grant negative test because typical Claude Code main requests declare tools. That does not prove the defense for a header-labelled auxiliary or future adapter composition; seed a genuine stored grant, run auxiliary with/without tools and with failure/cancel, then prove the original eligible tool-result continuation can still use it once. This is missing discriminating coverage, not a demonstrated grant-consumption defect. Only OpenCode currently implements `getRoutingTurnIdentity`; no actual built-in path combines that hook with the new auxiliary detector. A composed trusted adapter would currently claim a durable route then skip atomic mapping publication and fail terminal publication, so suppression must cover the generic hook without falsely reporting a live current Claude Code attestation failure.

Cancellation tests must include client socket signal, response-body cancel, declared parent and explicit subtree cancellation; normal completion, shutdown and proxy watchdog should retain their established separate semantics. Source registry's dropped self-edge cannot express “auxiliary under its own raw conversation ID,” which explains F2.

## Adjacent limits to retain explicitly

- Idle ceiling state still uses `profileSessionId` at server.ts:2904. A different auxiliary request's `preflight()` clears the main request's remembered streak (`idleStallCeiling.ts:90-104`); auxiliary success also clears it at4452/5964. This behavior predates the patch and is acknowledged by the author, so it is an adjacent internal isolation correction/negative control rather than a newly established source regression. Namespace auxiliary request-local failure accounting if promising full independence; do not pool empty keys or erase main retry ceilings.
- Auxiliary skips session leases, **not** the process SDK semaphore. Default is10; setting1 or saturating all permits can still queue it. The new overlap test deliberately provides2 permits and proves only turn-lease bypass. Keep account/budget enforcement; do not call this proof universal zero latency or silently add an unbounded auxiliary budget. Verify queued auxiliary cancellation and capacity behavior.
- Detector is specific to the selected Claude Code adapter. Gateway-selected passthrough traffic with rewritten identity/headers is not covered by this change; E55 regression claims are historical contributor reports. Do not expand gateway behavior or rename existing session keys without separate evidence.
- ARCHITECTURE's new row says “skips session lookup,” but source still performs the durable lookup at2607 and fails on its errors. Correct to “skips lineage resume lookup,” explicitly retaining authority availability checks if intended.

## Evidence truth and incorporation gates

The new tests use a mocked SDK through actual HTTP orchestration; they can discriminate ordinary lease bypass and successful main→classifier→main mapping preservation. They are not model/CLI/native-platform proof. The author's E71 narrative reports a Linuxx64/Bun1.2.20/SDK0.2.141/Claude Code2.1.286/Sonnet baseline0ec52a2 and unspecified branch before/after, plus a later ongoing ~700-message working-proxy session replacing1.79.0. These are substantive contributor reports, **not independently repeated evidence here**. Raw before/after logs and an exact tested branch/build digest are absent from this captured source; the current PR body still names rebased basee3fa582 whereas live base isf299fe06. Record those historical identities separately; green22566 source CI cannot establish fresh current-main/fixed live acceptance.

A corrected integration needs focused meaningful mocks for F1-F4, grant preservation, failure/cancel and account exposure, then coordinated final `npm test`, standalone typecheck and build, independent adversarial review and final-head CI. For accepted behavior, run durable corrected E71 with actual implicated Linuxx64 Claude Code auto-mode client, exact SDK/bundled CLI and actual Sonnet model; capture canonical effective model/version/package identities, immutable baseline and fixed trees, sanitized per-request class/decision/resume/lease/mapping assertions and zero-owned-residue cleanup. Preserve original failures and causal fixture corrections. E41's required sequential/parallel×streaming/nonstreaming passthrough modes remain relevant; actual OpenCode paths must use the Meridian plugin when run. No synthetic result or nearby platform/model substitutes for that gate.

The safe harness can be prepared, mocked and reviewed without credentials/model calls while the environment gate is unavailable. Root remains sole queue/PR owner. No source merge, issue closure, community comment or release is authorized by this report.
