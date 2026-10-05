# #1211 stable correction delta, independent adversarial review

Source `22566e8ac0b9e079bb0d28c0eb4aa05207c56070`; incorporation baseline `4cd004cce0da93f5028a63e4a770cb10c3a278fa`. Scope: all correction hunks in 11 stable production/test/architecture files, complete new recovery test and relevant callers. Final harness/evidence and runtime gates remain pending.

## Finding and verified correction

D1 (P2), `src/proxy/adapters/claudecode.ts:143`: the unanchored lazy permissions-envelope regex permits repeated suffix scans when a malformed client-controlled system block contains many opening-marker lines and no closing marker. An exact classifier prefix does not bound that work. Use an ordered linear scanner and retain same-block/line-boundary checks; add a long repeated-open/no-close negative. This is static algorithmic reasoning, not a measured timing claim. Root accepted and corrected this finding. The helper now finds the first opening once and advances each closing search monotonically beyond the preceding closing, so scans do not repeatedly revisit suffixes. Same-block, exact prefix and line boundaries remain; empty permissions work. Added 8192 repeated-open/no-close negative, empty-permissions positive and closing-extra-text negative. Independently verified by source inspection. The malformed-shape negative itself does not establish asymptotic/timing behavior; no performance probe was run. There are no remaining material findings in this stable production/test packet.

Non-material wording corrected: the NOTE now says classifier transcript; official segmented mode permits more than two.

## Complete path coverage

### `src/proxy/server.ts`

SHA256 `6ea37d4ad98454c811dba342ecddc88ef088e2089d0caa75248348eae5f742f3`; 12 correction hunks.

Complete correction diff plus priority dispatch/publication, keyed intake/tree registration/lease/cleanup, durable mapping/checkpoint classification, managed fresh/fork lifecycle, normal/exception/cache publication, recovery-grant consumption and write gates, both JSON/SSE abort/fallback and idle-accounting callers. Main mapping authority and affinity are fenced; side-call transcript journal/GC remains request-local lifecycle.

### `src/proxy/adapters/claudecode.ts`

SHA256 `df5a92330314c6909b1d0be775c0ea3c8fa2724231e40b8edd193d16410547e8`; 1 correction hunks.

Complete changed hunks and identity/session-parent parser and adapter wiring. Matched prefix/tags against official 2.1.286 static call trace; confirmed separate billing block, omitted-stream/stage2 stops, malformed tools/stops exclusion, explicit header override. One robustness finding below.

### `src/proxy/sessionTree.ts`

SHA256 `dd3ce916a8af8fd0b109dfda23c616faa769446eac210ef5cc879ca31f2edab9`; 6 correction hunks.

Complete changed hunks and entire registry. Two parent indexes dedupe the same entry token; release removes each index idempotently; private leaf preserves conversation+declared ancestor reachability without exposing an outward cascade key. Existing bounded/cycle walk retained.

### `ARCHITECTURE.md`

SHA256 `c45cb2ebcc619980d7d52315949cb643fa1b39f150cf2a0a855f833f58509724`; 1 correction hunks.

Entire one-hunk correction and dependency/adapter guidance. Read-only priority placement and private-leaf cancellation match implementation; pure tree adds no dependency. Internal adapter hook is not a new published package API.

### `src/__tests__/claude-code-adapter.test.ts`

SHA256 `564521f0dc1e108efdf0295a90824a36adc22b07ce947aacd47e81da0a4a8537`; 4 correction hunks.

Complete changed hunks and full auxiliary-classifier section. Source-shaped system positive, billing precedes block, segmented transcript >2, string synthetic equivalent, no tools, stream omitted/false, exact stop or omission. Ordinary 1-/3-turn XML, missing identity, split markers, malformed tools/stream/stops retain normal behavior. Additional repeated-open input control recommended.

### `src/__tests__/priority-routing-integration.test.ts`

SHA256 `a7bacb95809c963ab7450ebb550a1a01fa28509ed700c756126480ef5211802c`; 3 correction hunks.

Complete changed hunks plus dispatch mock/HTTP helper. Restores preferred account after HTTP observed cooldown, requires main resume on original account after auxiliary succeeds on fallback. Ordinary main fallback remains assigned/resumable on fallback profile as negative control. Source baseline would poison affinity.

### `src/__tests__/proxy-concurrency-coordination.test.ts`

SHA256 `251dd228ee2b184e7f48b4cf0aaff1bba2a3817f21d06fa05db507de1bd02c44`; 9 correction hunks.

Complete changed hunks plus mock/helper/setup and existing classifier concurrency controls. Full stored-prefix/complete pending result batch JSON+SSE tests require auxiliary never SDK-resume, exact original mapping/generation retained across fresh-target refusal, and identical ordinary continuation resumes/publishes. Ordinary XML first+continuation confirms mapping/resume, while existing two-permit HTTP concurrency isolates lease behavior.

### `src/__tests__/proxy-divergence-reason-log.test.ts`

SHA256 `1f0cf676e59d19f6215e38582070d12042e7fb921ebea9b591c9691305f52761`; 1 correction hunks.

Complete fixture-only hunk and auxiliary divergence expectations. System envelope now preserves intended headerless fixture classification rather than vacuously becoming normal traffic.

### `src/__tests__/proxy-session-tree-cancellation.test.ts`

SHA256 `13c40d3fcdcae2dd4ac3a6ad5762bb7df18ee318d285cd2304945d3032a3b038`; 4 correction hunks.

Complete changed hunks plus hang mock/HTTP identity/setup and cleanup. Main socket/body cancellation reaches same-key auxiliary+declared child without those clients aborting; auxiliary socket/body cancellation leaves main+child alive; ancestor reaches main+auxiliary, including no live child main. Assertions precede direct mocked-controller cleanup; bounded failed assertion cleanup retained.

### `src/__tests__/session-tree-unit.test.ts`

SHA256 `674e9da5b66b4309caebd76b53bbd36484a639ff99af44488601393fe2cc3136`; 1 correction hunks.

Complete changed hunk plus relevant entire registry tests. One abort per private leaf through two ancestor paths; reachability through both keys after main release; private-leaf cannot cascade; double release clears both indexes. Existing normal traversal/cycle/depth/self-link controls unchanged.

### `src/__tests__/proxy-claude-auxiliary-recovery.test.ts`

SHA256 `c5e2cd33bc8bcbeb7d859a522089f6a336372c0a5f6548de4c6528cb5c4cef68`; 0 correction hunks; complete new file.

Complete new 327-line file. Real server HTTP uncaptured tool dispatch recovery through mocked SDK obtains schema grant (not private-cache seeding); side success/failure/cancel with and without unrelated write schema preserves read grant. Eligible ordinary failed continuation spends grant once. JSON/SSE primary idle ceiling survives identical/different successful and repeated stalled side calls; blocked primary starts no SDK attempt; ordinary completion/revised primary resets its own streak.

## Product fit, regressions and evidence

Independent side calls should answer their own body without replacing or consuming conversation authority. F1 mapping/checkpoint/fallback fences, F2 cancellation private leaf, F3 read-only priority placement, and F4 source-evidenced system dialect fit that intent. Preserved ordinary checkpoint/XML/main-affinity/grant-consumption/completed-idle negatives discriminate from broad suppression. Test assertions are meaningful by inspection but this review does not independently execute them or claim native acceptance.

- Review is read-only and no tests, models, auth, browser, network/GitHub mutations or source edits were performed.
- Pending harness script/test/E71 documentation and final evidence README/manifest are intentionally deferred until frozen delivery head.
- Native Linux Claude Code/Sonnet E71 and E41 affected live flow remain runtime evidence gates, not owner/API approval decisions.
- Only Claude Code currently implements auxiliary declaration; only OpenCode implements trusted routing identity. Generic combined auxiliary+trusted/durable routing branch is statically fenced but not exercised by a built-in-client control.
- Primary/auxiliary independence skips conversation mapping but still journals/cleans its own SDK transcript lifecycle; this is not a claim of zero persistence or zero SDK/concurrency cost.
- Current observation is an uncommitted stable production/test snapshot atop source incorporation head 4cd004cce0da93f5028a63e4a770cb10c3a278fa; do not call this final-head acceptance.
- Existing cycle behavior can include an origin entry as a descendant and includeSelf cancellation may repeat it; that predates this correction and is not a new two-parent private-leaf failure.
- Request-local auxiliary idle treatment uses an empty correlation key, so each side-call stall is a one-off and no main streak state is touched. It does not impose an independent cross-request auxiliary retry ceiling.

Hash reconciliation: only the adapter and its direct test changed while root applied D1; every other reviewed file stayed identical. Initial/final snapshots are `before-hashes.json` and `after-hashes.json`. Final harness/evidence/frozen-head review remains separate.
