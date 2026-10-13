## Windows source and package share ACL subprocess failure

Head36ab7c50 actual source and independently installed Node both fail before log
allocation. [Source](windows-source-failure-36ab.json), [installed](windows-installed-failure-36ab.json),
and [package identity](windows-package-36ab.json) preserve the native result.
The source diagnostic reaches checkDetachedWindowsAcl and its execFile rejects
without numeric exit or stderr. No permission-rule correction is justified yet.

Next diagnostic records signal/killed/elapsed data and compares the existing
allowlist, adding only PSModulePath, and the hosted-runner environment. The last
control imports only detachedStore on credentialless hosted CI; no CLI/SDK/model
or environment dump is involved. All controls retain the same ACL rules. Product
and package acceptance remain open.

## Actual Windows source startup failed on0bb7df27

[Native job](https://github.com/rynfar/meridian/actions/runs/38328390229/job/115072298927)
passes the fixture/ACL tests but fails actual source Bun startup. Both concurrent
launches return exit1 before a log path is available; cleanup reports already
stopped. The [failed receipt](windows-source-failure-0bb7.json) is retained.
The installed run was skipped by the workflow's early throw, so it has no result.
This is an unresolved configuration/private-directory boundary failure, not a
proven SDK or supervisor failure.

The next workflow observes both source and installed outcomes before failing.
A source-only diagnostic re-executes the same private-directory operation in the
same isolated dummy environment and saves a bounded exception/cause chain. It
does not relax ACLs or repair existing state. Concurrent launches now both settle
before cleanup even when one fails. Native diagnosis remains pending; no product
fix is claimed. Application source remains7b0e2f46.

## Actual Windows package gate added

The Windows CI job now runs the escrowed lifecycle harness against source Bun
and a separately npm-installed candidate tarball using Node. It asserts concurrent
creation/reuse, launcher survival, two endpoints, targeted and repeated stop,
and shutdown logs. Receipts plus package hash/runtime identity upload with
`actions/upload-artifact`, including available failure receipts. Native results
are pending; this addition is not a pass claim.

Windows execution is restricted to a GitHub-hosted runner, with an allowlisted
environment, isolated config and dummy API profile pointing at loopback port1.
Unlike Darwin Seatbelt and the network-disabled Linux container, this Windows
job has no OS network fence. It sends no inference request and has no account
credentials. Actual active-model drain remains a separate plugin-qualified gate.
Application source is unchanged from7b0e2f46; only the manual harness/workflow
and this evidence description changed. Workflow actionlint and Node syntax
validation pass locally. The updated harness also passes the actual independently
installed Darwin candidate ([receipt](darwin-windows-harness-regression.json));
that result does not substitute for the pending Windows run.

## Detached CLI #1359 — corrected native Windows checks pass

Head `7b0e2f467f5139374e55645f6cb58904b047e33b` passes the
[native Windows job](https://github.com/rynfar/meridian/actions/runs/38327263497/job/115068721032):
6 detached tests, 40 assertions, zero failures. This includes the unchanged real
Node launcher/targeted-stop fixture and all private-state ACL cases. The job
uses PR merge checkout `72ec7d12d84055e4960355c9abff9c0fe9a2a1a7`.
The earlier failed job did not log its exception; passing the correction does
not conclusively identify that original cause. Source Darwin lifecycle/recovery
also pass on this head. Original full local process60564 exited0: 5,778 tests passed, 39 skipped,
zero failures across23 groups, plus standalone typecheck/build. Required CI
passes on this application head. The independently installed candidate now passes lifecycle and crash/recovery
on both Darwin ARM64 / Node22.22.3 and Linux ARM64 / Node24.20.0. Actual Windows
application/package and plugin-qualified active-model drain remain open. No model
calls or credential changes. Receipts: [local gates](local-gates-7b0e.json), [Windows](windows-7b0e.json),
[source lifecycle](source-lifecycle-7b0e.json), [source recovery](source-recovery-7b0e.json),
[Darwin installed lifecycle](installed-lifecycle-7b0e.json), [Darwin installed recovery](installed-recovery-7b0e.json),
[Linux installed lifecycle](linux-lifecycle-7b0e.json), [Linux installed recovery](linux-recovery-7b0e.json),
and [package identity](package-7b0e.json). All qualify application head7b0e2f46.
The Linux package update used offline npm with existing dependencies, then the
same network-disabled, read-only-rootfs proof container and test-specific identity.
No image pull/build or published release. Older checkpoints below retain their historical scope.

# Windows result and retirement-race correction

Frozen558e575d original local process63882 exited0:5777 pass/38 skips/0 failures,
typecheck/build pass ([record](acl-local-gates-558e.json)). Native Windows CI
passed all three ACL cases, including refusal without repair. The process case
passed concurrent startup, reuse, readiness and foreign-listener protection,
but failed `stop` with exit1 ([failed-job record](windows-acl-558e.json)). It did
not print the underlying exception, so the root cause is not conclusively known.

Review found an unhandled race: the owner can retire its record while the
asynchronous PowerShell ACL check runs. Snapshot already tolerated disappearance
at lstat/open, but not at this new intermediate operation. The candidate now
rechecks existence after an ACL failure and treats only confirmed ENOENT as
retirement; a remaining or replacement file, permissions error or unknown state
preserves the rejection. A deterministic filesystem test covers disappearance
versus retained replacement/denial, and a native Windows case exercises the real
missing-file PowerShell failure. The unchanged native stop assertion remains the
acceptance gate, now with structured-result diagnostics. Stop failures identify
the configuration/record/control/observation stage without exposing paths, ACLs
or nonce values. Local focused suite:26 pass/4 native-Windows skips,125 assertions;
standalone typecheck passes. The diagnostic change also passed its focused
process/retirement checks and another standalone typecheck. Do not call the Windows
stop failure fixed until that result is known.

Linux ARM64 / Node24.20.0 independently installed pre-ACL90ec6828 also passes
[lifecycle](linux-lifecycle-90ec.json) and [crash/recovery](linux-recovery-90ec.json).
[Image/package identity](linux-package-90ec.json) records an existing image (no
pull/build), network disabled, read-only rootfs and no credential mounts. Initial
[lifecycle](linux-lifecycle-missing-identity.json)/[recovery](linux-recovery-missing-identity.json)
failures preserve the missing /etc/machine-id prerequisite. A test-specific
read-only machine-id mount follows the project's Dockerfile provisioning; process
ownership checks are unchanged. Harnesses now support either the documented
Darwin Seatbelt fence or an explicitly isolated Linux container with no IP routes.
These Linux receipts still qualify90ec6828 only; new-head package verification is
pending. No model calls, auth refresh or private transcript access.

# Windows ACL correction — native verification pending

The current implementation adds `detachedWindowsAcl.ts` and native Windows CI
cases. A fixed PowerShell script receives paths through environment variables;
paths are never interpolated into script source. New directories use the Windows
Framework [CreateDirectory security overload](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1)
with a current-user, inheritable DACL and [inheritance protection](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection?view=netframework-4.8.1).
Existing paths are inspected rather than repaired. Reparse points, untrusted
owners/allow entries, inherited root ACLs and missing current-user full access
are rejected; Windows SYSTEM and Administrators are trusted privileged principals.
Ownership records, active logs and rotated logs are checked before use. Newly
opened log files are checked before any content is written.

Native tests broaden directory/record/log ACLs and require refusal without
rewriting contents or permissions; a path with PowerShell metacharacters must
remain literal. The Windows CI job also runs the actual Node process fixture
against named pipes. Local Darwin checks:25 pass/3 Windows-only skips,121
assertions, standalone typecheck pass. Skips are not Windows proof. Full new-head
gates, native Windows results and actual plugin-qualified active-turn evidence
remain pending. The historical full gates and application receipts below apply
to their recorded pre-ACL application revision, not this new code.

# Actual crash, stale-owner and startup-error recovery

The [recovery harness](e2e-detached-recovery.mjs) now passes against actual source
Bun and the same independently installed Node package documented below:
[source receipt](source-recovery.json), [installed receipt](installed-recovery.json).
Application code remains `90ec6828`; these changes add evidence only.

The harness starts a supervisor with its original IPC channel, commits readiness,
then kills that exact spawned handle with SIGKILL. It joins the supervisor's
original close event and verifies listener shutdown by successfully rebinding the
same endpoint. It does not use a recorded PID for signaling, and a failed HTTP
request alone is not accepted as proof that the listener closed. The next actual
CLI start waits about 30 seconds for the existing stale-lock quarantine, admits
only the confirmed-dead owner, and returns a distinct new instance identity.
Readiness and ordinary stop then pass. No claim of joining a grandchild directly
is made; this proves supervisor close, listener release and successful replacement.

A separate endpoint starts with deliberately invalid MERIDIAN_BACKEND. It returns
exit1/structured failure; a later valid invocation creates a ready instance and
stops normally without harness deletion of ownership records. Both runtimes use
the documented credential-isolated, loopback/Unix-socket fence and ps-only identity
exception. No inference or auth refresh occurs. Reproduce with the same arguments
as the lifecycle harness, substituting `e2e-detached-recovery.mjs` and a fresh root.

Adversarial review confirmed that the Windows path currently skips Unix uid/mode
checks in the state store and log guard. Windows equivalent ACL protection is not
established by the Darwin tests and must be addressed/verified along with native
named-pipe and process-lifecycle acceptance. Do not claim Windows-private-state
parity from these receipts. Remaining gates also include actual plugin-qualified
active-turn drain and final-head CI/review. #1359 remains draft; #1302 stays open.

# Actual source and independently installed lifecycle evidence

Implementation head: `90ec6828fba4e5d05f3f9a5f6b5d39892f286306`.
Original full process 61680 exited 0: **5,777 pass, 35 skips, zero failures**
across 23 isolated groups, followed by standalone typecheck and build.
[Machine-readable gate record](supervisor-local-gates.json). The working tree
remained frozen for that entire run; subsequent additions are documentation and
this manually invoked evidence harness.

The committed [headless harness](e2e-detached-lifecycle.mjs) runs the actual CLI
with isolated configuration, an explicit dummy API profile and no inference.
It starts two concurrent launchers for one endpoint and requires exactly one
`ready-created` and one `ready-existing` result with matching identity. A second
endpoint gets a distinct instance; both remain ready after their launchers exit.
Stopping the first leaves the second ready; repeated stop is idempotent. Both
persist startup/shutdown output in their endpoint logs.

- [Source receipt](source-lifecycle.json): actual Bun 1.3.14 running `bin/cli.ts`.
- [Installed receipt](installed-lifecycle.json): actual Node 22.22.3 running an
  independently npm-installed tarball, no symlinks to source dependencies.
- [Package identity](installed-identity.json): tarball integrity and installed
  Meridian/SDK/Claude versions (1.81.0 candidate / 0.2.141 / 2.1.296). This is a
  candidate built from the branch, not a newly published 1.81.0 release.

Both runs are Darwin ARM64. The harness generates a Seatbelt policy denying
external IP networking and reads of the real Claude/Codex/config/keychain stores;
it permits loopback and local Unix sockets. `/bin/ps` alone runs outside that
sandbox because macOS rejects the setuid executable at spawn otherwise. It is
used only by existing read-only process identity checks; the CLI, server and
SDK descendants retain the fence. Credentialless local readiness does not
establish model entitlement or successful inference, and no scrub-qualified
live model acceptance is claimed here.

Reproduce with a fresh scratch directory outside the home directory:

```sh
node docs/maintenance/evidence/1302-detached-cli-20261012/e2e-detached-lifecycle.mjs \
  /absolute/path/to/runtime /absolute/path/to/cli-entry /tmp/fresh-detached-proof
```

Preserved initial failures: [sandbox attempt](source-initial-sandbox-failure.json)
failed before child creation because `/bin/ps` was denied with EPERM and process
incarnation could not be captured. Allowing Unix sockets alone did not resolve
it. With the narrowly scoped ps exception, startup/reuse/cleanup worked, but the
[initial readiness assertion](source-readiness-assertion-failure.json) expected
`ok` instead of the route's `ok\n`. Correcting that assertion produced the
source and installed passing matrix above. Neither failure was hidden by a
rerun or worked around by weakening production ownership checks.

Remaining before acceptance: crash/stale-owner and startup-error application
matrix, claimed-platform qualification, plugin-qualified actual active-turn
drain, final-head CI and adversarial final review. #1359 remains draft and #1302
remains open. No auth refresh, account switch, model calls or Docker changes.

The following checkpoints are historical; their narrower scope remains explicit.

# Supervisor and CLI implementation — current checkpoint

The CLI now dispatches `start --detach [--json]` and `stop [--json]` through
an endpoint-specific supervisor. Its original child uses private IPC for
readiness and graceful shutdown; the launcher commits ownership before exiting.
An uncommitted launcher disconnect cancels startup. Cleanup joins the child,
its log sink and private listener before releasing ownership. Existing foreground
shutdown behavior retains its second-signal force exit; repeated private stop
requests do not force exit.

`src/__tests__/detached-supervisor-process.test.ts` bundles the production
supervisor, command, child control and store into a Node fixture, then uses real
separate processes. On Darwin ARM64 / Node 22.22.3, its 19 assertions pass:
concurrent launchers produce exactly one created and one existing result with
matching identity; both launchers exit while the listener remains ready; foreign
ports are neither adopted nor stopped; fresh stop drains the child and preserves
stdout/stderr/shutdown logs; repeated stop is idempotent; pre-commit launcher
disconnection closes the original child and supervisor and removes owned state.
This fixture replaces the server only; it is not installed-package or live SDK
acceptance.

The initial concurrent-start run failed with Node exit 13 and “unsettled top-level
await”: the reused server coordinator has unreferenced lock retry timers, so a
standalone waiting command could exit before returning JSON. The command now owns
a referenced, bounded deadline timer and clears it in finally. The same process
regression passes after that correction. Other corrections place early ownership
acquisition inside supervisor cleanup, detach cancelled launcher IPC immediately,
and remove abort listeners on cancellation as well as normal completion.

The final focused suite passed 25 tests / 121 assertions plus standalone
typecheck; this includes the process test with 19 assertions.
Full current implementation gates are pending. Source CLI, independently installed
package, multiple managed endpoint matrix, claimed-platform acceptance and
plugin-qualified actual active-turn drain remain required. #1359 remains draft;
#1302 remains open. No model calls, credential operations or Docker changes.

The following checkpoints are historical and qualify only their named revisions.

# Detached CLI implementation checkpoint

Issue #1302, draft delivery #1359. Base e0f9feab. This is a new maintainer
implementation, not incorporated contributor code.

Implemented foundations:
- `src/cli/detachedProtocol.ts`: bounded single-frame parsing, strict private
  identity validation, constant-time nonce/instance comparison, and lifecycle
  transitions that admit graceful stop only once.
- `src/cli/detachedControl.ts`: bounded private socket connections, authenticated
  inspect/stop, original-connection close on success/error/timeout, explicit
  reporting of a failed graceful callback. No public HTTP route or PID signaling.
- `src/cli/detachedLog.ts`: one backpressure-aware writer, 10 MiB active plus one
  rotated file across launches, private single-link files, rejection of symlinks,
  over-limit history and replacement before rotation. The supervisor must own the
  enclosing directory and serialize writers; the logger does not supply that lock.

Focused command:

```sh
bun test src/__tests__/detached-control.test.ts \
  src/__tests__/detached-control-socket.test.ts \
  src/__tests__/detached-log.test.ts \
  src/__tests__/detached-node-bundle.test.ts
npm run typecheck
```

16 tests / 69 assertions pass on Darwin ARM64 with Bun 1.3.14. Standalone
typecheck passes. The bundle test launches actual Node 22.22.3 and verifies
framing/admission, real private socket concurrent stop and log rotation, then
joins the original child. This is compiled-module proof, not an installed npm
package or full detached application lifecycle test.

Adversarial findings resolved during implementation: validate hex lengths before
Buffer decoding; retain a cancelled-start state despite late readiness; surface
stop-callback failure instead of swallowing it; never retry it as a force stop;
wait for the real socket-close event in the timeout test instead of assuming one
event-loop tick proves cleanup; use fileURLToPath for the Node probe on Windows.
Log rotation is bounded across process launches rather than restarting its budget.

Still required: private directory/record ownership and stale recovery, parent to
supervisor publication handshake, original child IPC/stream ownership, bounded
startup/readiness, CLI dispatch and output, source/installed actual multi-process
lifecycle matrix, claimed-platform proof, active-turn drain with matching plugins,
full local npm test/typecheck/build and final-head CI. The new commands are not
wired or exposed yet. Do not mark #1302 resolved or merge this draft based on these
foundational tests. No credentials, auth refresh, inference, or Docker changes.

## Foundation full gates and ownership checkpoint

Original67248 completed with exit0 on frozen
d8d393a715908d4af25f76e20e4e705065cd754e:5768 pass/35 skips/0 fail across23
isolated groups, standalone typecheck and build. See foundation-local-gates.json.

Subsequent ownership changes are separately qualified:24 focused tests/102
assertions and typecheck pass. They were prepared outside the checkout while
the original full run remained live, then copied in only after it exited. The
full result above does not cover these newer files.

`detachedStore.ts` adds endpoint-scoped, bounded, private ownership records and
short private control paths. A supervisor lifetime lease reuses the existing
CrossProcessTurnCoordinator and OS process-incarnation semantics, rather than
PID-only locking. Unknown/dead identity remains distinct; only confirmed dead
owners can be replaced. Stop inspection does not create missing state.

Adversarial checks reject endpoint mismatches, extra/malformed fields, symlinks,
multiple hard links, broad Unix permissions, oversized bodies and a changed
record. Removal moves the checked record aside and verifies its identity before
unlinking; an unexpected moved file is retained for explicit recovery. A real
lease test excludes a second acquirer, then admits a replacement after release.
That is same-process filesystem coordination proof, not yet two real supervisors.

A new regression covers release during publication: cleanup joins the original
publication before retiring its record/releasing the lease; a second concurrent
publication is rejected. Published record identity is privately copied so a
caller mutation cannot change which record cleanup owns.

The supervisor event loop, parent commit handshake, child IPC, CLI commands and
actual source/installed/platform lifecycle acceptance remain pending. No PID is
signaled by these components. No feature-completion or current-head full-suite
claim follows from the earlier foundation run.
