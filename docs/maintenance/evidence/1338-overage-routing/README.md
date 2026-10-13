# Priority overage routing — issue 1338

Status: final local gates pass; draft PR 1347 is not live accepted.
Baseline: `16fac4c6b4b95a97f7dbb7ff4d00946d5e3aa06f` (published package is 1.81.0).
Host: Darwin ARM64, Node 22.22.3. Focused reproduction: Bun 1.3.14.
Full local qualification uses CI's Bun 1.3.11.

## Product decision

Prefer included capacity before paid overage in priority mode. Keep paid-capable
accounts as last-resort candidates, and preserve explicit pins and other routing
modes. An opt-out, `priorityOverage: "always"` / `MERIDIAN_PRIORITY_OVERAGE=always`,
retains previous behavior. No public HTTP response/header contract changes.

A quota hint cannot confer permission to migrate a transcript. New conversations
can reorder candidates; existing durable conversations can move only at a new
authenticated OpenCode human turn under the existing publication/lease checks.
Existing unsigned/legacy conversations retain their assignment until normal
failover. This limitation is intentional and documented, not proof of universal
mid-session protection for every client.

## Reproduction

Add the two `prefers included capacity` HTTP tests to unchanged baseline, then:

```sh
bun test src/__tests__/priority-routing-integration.test.ts \
  --test-name-pattern 'prefers included capacity'
```

Both fail: SDK dispatch goes to `prof-work`, despite recent `isUsingOverage: true`
and exhausted five-hour usage for work, and 10% usage for personal. No account
refuses, so baseline does not fail over. Same tests pass after the correction,
selecting personal in JSON and SSE modes. Logs are retained alongside this file.
The SDK is mocked; these tests make no generation, usage or credential requests.

```sh
bun test src/__tests__/overage-routing.test.ts \
  src/__tests__/priority-routing-integration.test.ts \
  --test-name-pattern 'overage|included-capacity|prefers included capacity'
```

Sixteen controls pass: recent evidence, missing data, reset/age/future timestamp
bounds, newer per-window observations, model-specific exclusion, replaced overage
signals, stable paid fallback, explicit pins, all-spent pools, opt-out,
active+priority behavior, and authenticated turn migration.

## Adversarial findings and limits

- A simple exhausted-profile mark would remove paid fallback and could strand an
  otherwise usable pool. The implementation partitions candidates instead.
- Unconditional partitioning would move same-turn work across account transcripts.
  It is gated by existing durable human-turn authority and does not change leases.
- Team `extra_usage.isEnabled` is not reliable evidence of organization billing;
  it is deliberately not consulted.
- Model-specific windows must not suppress unrelated models. Only global windows
  and unscoped/global overage observations apply here. Model-specific overage
  selection remains outside this implementation's qualified scope.
- Cached evidence is not a spend cap. It expires at its reset or five minutes,
  whichever is sooner. Unknown capacity can still result in paid usage. No new
  polling or refresh is performed from routing.
- A full native/model/client baseline and candidate acceptance remains required.
  Never cause paid overage merely to test this. Actual harnesses must load the
  matching Meridian client plugin and applicable scrub plugin, with retained
  load/config/route witnesses before inference. Missing/mismatched plugins cannot
  establish an account billing defect. No live billing claim is made here.
- `npm ci --ignore-scripts` fails on unchanged baseline because package-lock pins
  Claude CLI/platform packages at 2.1.284 while package.json requires ^2.1.293.
  `bun install --frozen-lockfile` succeeds with 2.1.296. Lock repair is separate.

Issue 1338 remains open. No release is authorized by this correction.

## First full-suite failure and fixture correction

The first full command stopped at the priority integration batch (76 pass, five
fail). All five failures seeded an exhausted preferred account to test reactive
refusal cooldowns. The new default bypassed that account before it could refuse,
so the expected cooldown mark did not exist. Production behavior was unchanged
after this finding. That describe now explicitly sets `priorityOverage=always`
and restores the environment afterward, retaining every cooldown assertion.
The separate default-policy regressions still require bypassing the spent account.
Four original failures plus the strengthened same-turn retention case pass in
the focused rerun; the final full suite includes all five cooldown cases.

Original failing cases:

```text
(fail) priority cooldown resolution > uses the failing profile's OWN five_hour reset, not another profile's [57.95ms]
(fail) priority cooldown resolution > ignores the five_hour reset when the refusal is about the subscription, not the quota [48.20ms]
(fail) priority cooldown resolution > adopts a SECONDS-valued reset from the SDK, which tier 1 could never match before (#708) [44.99ms]
(fail) priority cooldown resolution > never shortens an existing mark with an earlier OAuth reset [76.92ms]
(fail) priority cooldown resolution > clamps the synchronous mark to the 6-hour cap even when the profile's own reset is far beyond it [46.28ms]
(fail) priority cooldown resolution > uses the failing profile's OWN five_hour reset, not another profile's [57.95ms]
(fail) priority cooldown resolution > ignores the five_hour reset when the refusal is about the subscription, not the quota [48.20ms]
(fail) priority cooldown resolution > adopts a SECONDS-valued reset from the SDK, which tier 1 could never match before (#708) [44.99ms]
(fail) priority cooldown resolution > never shortens an existing mark with an earlier OAuth reset [76.92ms]
(fail) priority cooldown resolution > clamps the synchronous mark to the 6-hour cap even when the profile's own reset is far beyond it [46.28ms]
```

Final local gates: 5,650 pass, 35 skips, zero failures across all npm test batches;
standalone typecheck and build exit zero. See local-gates.json. The old live
Opus quota-blocker interpretation is withdrawn: the October 12 streaming harness
omitted server scrub. Correctly configured actual acceptance remains to be run.
