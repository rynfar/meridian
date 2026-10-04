# Process-incarnation failure diagnostics — #1229

This bounded correction makes a denied Darwin identity probe actionable in the
coordinator error and proxy log. It does not replace the native probe, permit a
sandbox exception, or establish that the reporter's sandbox can serve Claude.
[Issue #1229](https://github.com/rynfar/meridian/issues/1229) remains open.

## Scope and source

- Unchanged reproduction baseline: `f299fe06e72411b786380b5212edea79cd13966a`.
- Delivery base: `9d77d8e282cb9c58d99b8962b900777e9f4b0803`.
  The only intervening main change is the independently verified shared-header
  separator correction (#1264): shared CSS/test, header fixture and evidence,
  plus its E2E section. Both E2E sections are retained after rebase.
- Rebased product commit: `1703c3f8e6d8452b45208f78920e0e816a8be824`, Author
  Trevor Walker `<rynfar@gmail.com>`, authored 2026-10-04T15:08:01-06:00.
  This is the same product patch originally committed/tested as
  `3a5291e345532cae895bd93127171d4ff4e064fa` before the main advance.
  This is a maintainer implementation of the reported diagnostics request;
  there is no contributor code/cherry-pick mapping for this issue.
- Rebased harness correction: `714b72163ab10f956ec943923d03d30ded2c20de`,
  same author, authored 2026-10-04T15:16:11-06:00. It preloads the selected
  source tree's existing libsql dependency before emulating Darwin, avoiding
  simulated-platform native-binary selection. It opens no database and adds
  no dependency. This does not establish Windows/Linux platform execution.
- Branch/worktree: `codex/process-diagnostics-1229-20261004`,
  `/Users/rynfar/repos/meridian-process-diagnostics-1229-20261004`.
- Detached baseline: `/Users/rynfar/repos/meridian-process-diagnostics-baseline-1229-20261004`.
  The user's dirty checkout and existing worktrees were preserved.

The reporter uses macOS 27.0.1, nono 0.79.0, OpenCode 2.0.21 standalone,
opencode-with-claude 1.11.1, and bundled Meridian 1.79. Their ioreg/sysctl
probes succeed; `/bin/ps` spawn fails with EPERM despite filesystem readability.
[Upstream nono issue #1619](https://github.com/nolabs-ai/nono/issues/1619)
remains open and corroborates setuid-execution denials; its proposed unsafe
execution exception is not adopted here.

Available review host: macOS 26.6.2 / build 25G83 / arm64 / Bun 1.3.14.
`command -v nono` and standard binary locations found no nono installation.
`stat -f '%Sp %N' /bin/ps` returns `-rwsr-xr-x /bin/ps`. A real, unsandboxed
current-process capture succeeds with `darwin-ps-lstart` and no diagnostic.
No hardware/boot IDs were printed. This is an adjacent native control, not
the reporter's unavailable environment.

## What changed and what stays fail closed

`processIncarnation.ts` carries failed Darwin command metadata through an
optional internal per-capture callback. Diagnostics contain only the known
probe path and a bounded errno or numeric exit status, with execution-policy
guidance. No raw stderr, command arguments, spawn error messages, credentials,
hardware UUID or boot UUID enter the diagnostic. It covers ioreg/sysctl boot
capture and `/bin/ps` process-start capture.

`CrossProcessTurnCoordinator.tryAcquire` collects this diagnostic in a local
variable and appends it to its existing capture-failure error. Capture still
returns undefined when proof is unavailable, and no owner/candidate lock is
published. Cached successful identities, PID-reuse checks, same-second Darwin
uncertainty, reboot proof, recovery and all ownership decisions are unchanged.
There is no new `ProxyConfig` hook or public API field.

The HTTP client still receives the existing generic 500 `Internal Server Error`.
Hono's existing error log now includes the safe underlying probe failure.
This is a proxy-log improvement, not a new diagnostic HTTP response.

## Durable headless before/after proof

The maintained harness is
[`scripts/e2e-process-incarnation-diagnostics.mjs`](../../../scripts/e2e-process-incarnation-diagnostics.mjs).
Its regression wrapper lives in
[`src/__tests__/process-incarnation-diagnostics.test.ts`](../../../src/__tests__/process-incarnation-diagnostics.test.ts).
The harness injects command results at `spawnSync` in fresh independent
processes, runs the real coordinator and HTTP route, and fences SDK calls.
It never executes the injected native commands or accesses credentials.

Run the same assertions against both source trees:

```sh
E2E_SOURCE_ROOT=/absolute/path/to/unchanged-f299fe06 \
  bun scripts/e2e-process-incarnation-diagnostics.mjs
bun scripts/e2e-process-incarnation-diagnostics.mjs
```

On unchanged `f299fe06`, the EPERM arm exits 1:
`Admission diagnostic hides the failed probe and underlying error`.
Both the coordinator error and HTTP request's proxy log contain only
`cannot capture turn-lock owner process incarnation`.
The after run passes the unchanged assertion and all five arms:

| Injected observation | Corrected proxy-log suffix | HTTP | Published locks | SDK queries |
|---|---|---:|---:|---:|
| `/bin/ps` EPERM | `/bin/ps process-identity probe failed (EPERM)` | 500 | 0 | 0 |
| `/bin/ps` exit 1 | `/bin/ps process-identity probe failed (exit 1)` | 500 | 0 | 0 |
| Non-errno code with private text | `/bin/ps process-identity probe failed (no usable result)` | 500 | 0 | 0 |
| Malformed successful output | Original generic capture failure; no invented errno | 500 | 0 | 0 |
| ioreg EPERM | `/usr/sbin/ioreg process-identity probe failed (EPERM)` | 500 | 0 | 0 |

The baseline also has HTTP 500, zero SDK queries and zero published locks:
the fix changes the explanation, not admission. Every after arm separately
checks absence of private fixture stderr/arguments, local turn-fence release,
later successful capture/acquisition without a stale diagnostic, released-lock
cleanup, same-incarnation Darwin `indeterminate`, and earlier-boot `dead`.
The gate's summary names intercepted calls `probeSpawnCalls`, not native proof.

## Verification and adversarial review

Full `npm test` completed with **5,305 pass, 35 platform skips, 0 fail** across
the primary suite and all 17 isolated stages at the original product head
`3a5291e345532cae895bd93127171d4ff4e064fa`. It is not attributed to the later
rebased head. The intervening product-base delta is the unrelated shared-header
correction above; process-incarnation product code is unchanged by rebase.

After the harness loader correction and rebase, the same before assertion still
fails against unchanged `f299fe06`, while the after matrix passes all five arms.
Focused checks pass **16/16** across the diagnostic harness,
process-incarnation protocol and independent-process turn coordinator tests;
standalone `npm run typecheck` and `npm run build` also pass at
`714b72163ab10f956ec943923d03d30ded2c20de`. Required final-head CI, including
`test`, remains a delivery/merge gate and is not yet available.

An independent read-only adversarial pass found no material remaining code
finding. It checked fail-closed admission and recovery, per-capture state,
fixed paths/bounded codes, exclusion of raw probe data, HTTP body preservation,
zero SDK calls, no published locks and negative/positive controls. Review
corrections threaded uncached boot failures and prevented a malformed spawn
error from being misleadingly labelled `exit 0`. A final harness review found
the native-loader portability concern; preloading libsql from the selected
source root addressed it before the final focused checks. Optional controls
include sysctl denial, invalid PID and another PID's failed capture.

## Open gates and disposition

Prepare a **diagnostics-only draft** after local gates. Actual native sandbox
operation remains unproved: the exact macOS 27.0.1 / nono 0.79.0 / OpenCode
2.0.21 / plugin 1.11.1 environment, actual denied `/bin/ps` diagnostic, supported
client/model operation, and independently installed package evidence are
unavailable. Synthetic injected EPERM does not substitute for those gates.
No model call, sandbox exception, native dependency, GitHub comment, push, PR,
merge, issue closure or release was performed by this bounded implementation.
Do not close #1229 or claim the native sandbox problem is fixed.
