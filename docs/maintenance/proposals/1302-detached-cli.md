# Detached CLI lifecycle — implementation proposal for #1302

Status: commands and lifecycle implementation are wired in draft #1359. Actual
credentialless source/installed lifecycle evidence and native Windows fixture
checks exist; final package/platform and active-model drain acceptance remain
open. The feature has not shipped. See the [implementation evidence](../evidence/1302-detached-cli-20261012/README.md). This proposal adds CLI lifecycle behavior and a private local
control protocol. It does not modify public plugin interfaces or introduce a
public HTTP shutdown route. Implementation must preserve that boundary; a change
to an existing public interface needs the approval described in AGENTS.md.

Source: https://github.com/rynfar/meridian/issues/1302
Reviewed base: e0f9feabf6fcef99a056141031f221da535d5391.

## Why this feature belongs

An application should be able to start its local Meridian backend, exit, and
later inspect or stop that exact backend. The existing foreground CLI is useful
and remains the default. OS service management remains separate: detached start
is not install-at-login, systemd activation, restart policy, or deployment.

This comes after paid-overage routing, cwd preservation, and checkpoint/context
fixes. Those fixes retain their actual-account/platform gates. The detached CLI
has an independent lifecycle verification path and can progress without inventing
provider acceptance or triggering paid usage.

## Proposed commands and outcomes

- `meridian start --detach [--json]` starts an instance for the existing effective
  `MERIDIAN_HOST` / `MERIDIAN_PORT` and configuration directory. Reject unsupported
  arguments rather than silently entering the foreground default action.
- `meridian start` is an explicit foreground spelling of the existing behavior.
- `meridian stop [--json]` stops only a detached instance registered in that same
  configuration directory for the selected endpoint. It never stops every
  Meridian process, discovers a PID from a port and kills it, or takes ownership
  of a desktop/launchd/systemd/foreign server.
- Existing `meridian status` remains compatible. Detached start and stop print
  their own outcome and log path. A separate log-follow command is unnecessary
  for the first implementation.
- Use environment endpoint selection initially; document two-instance examples.
  Do not add a second, conflicting precedence system just for these commands.
- Default startup timeout: 60 seconds. Default stop observation: 45 seconds.
  Timeout means the requested transition was not established; it is not proof
  of process death. Do not delete a live/indeterminate owner's record on timeout.

Structured output has `schemaVersion: 1`, `action`, `outcome`, `endpoint`,
`managed`, and a log path when owned. Include a diagnostic code for failures.
Never emit credentials, control nonces, environment dumps, or profile objects.
Print exactly one JSON object to stdout with `--json`; diagnostics go to stderr.
Exit zero for ready-created, ready-existing, stopped, or already-stopped. A port
conflict, readiness failure, ambiguous owner, unmanaged stop, or drain timeout
returns nonzero. Consumers should use `outcome`, not scrape human prose.

Reusing an existing Meridian endpoint is a start result, not permission to stop
it. Report `managed: false` for a recognized existing instance without a verified
private control record. If the endpoint cannot be authenticated/identified,
report the ambiguity and leave it alone. The current status probe's generic
`authentication_error` envelope is not a sufficient ownership proof.

## Ownership and process structure

Use one detached lightweight supervisor per managed instance. It owns the exact
CLI child handle for its entire lifetime, its stdout/stderr streams, bounded log
writer, and private control listener. The short-lived `start` invocation receives
an explicit readiness/ownership handshake and then disconnects and exits.

The supervisor is not an automatic restart loop. An unexpected CLI exit ends
that instance after joining its streams and recording the exit result. A later
start can create another instance. This avoids silently adopting the existing
shell supervisor's 50-restart behavior or the desktop manager's recovery policy.

Persist a versioned instance record under the effective Meridian configuration
root. Its key derives from the canonical configuration root and bind endpoint;
include host and port without conflating wildcard and explicit bind addresses.
The persisted record contains schema version, random instance ID/control nonce,
supervisor process incarnation, host, port and startup time. Phase is read from
the authenticated live control channel; log paths derive from the endpoint key.
The supervisor retains the original child handle rather than persisting a PID
for later process control.
Nonce/state files must be private, bounded, atomically replaced, and protected
against symlink and replacement races. Do not persist inherited environment.

Local control uses a Unix-domain socket on POSIX and a named pipe on Windows.
Authenticate every request with the record's random nonce and instance ID. The
listener reports the same ID; a response from a replacement endpoint is not a
match. Keep the protocol private/versioned, with bounded frames, connection
count, read deadline, and no arbitrary command/path fields. Supported requests
are inspect and stop only. Stop is executed by the supervisor through its original authenticated child
IPC channel, never through a recorded numeric PID. The live child handle is
retained for lifecycle observation and joining.

Process incarnation is evidence for stale metadata recovery, not authorization
to signal an unknown process. Use the existing fail-closed process-incarnation
semantics: only confirmed `dead` permits retirement; `indeterminate` does not.
Darwin/Windows birth-time equality is intentionally indeterminate in the current
helper. Do not weaken that rule to make startup easier. Avoid blocking identity
probes in request handling; startup/recovery is a CLI control path.

Startup serialization must cover publication and child launch. A second starter
cannot retire the first launch merely because readiness is slow. Parent death
between spawn and record publication requires an explicit child/supervisor
handshake and nonce-checked ownership transfer. A process which loses its
reservation must close its own listener/child and cannot publish a stale record.
Recovery/unlink must compare the same instance and file identity immediately
before mutation. A replaced record is someone else's state.

## Readiness and graceful stop

The private child handshake ties readiness to the owned CLI process and its
bound server. A successful HTTP response from whatever occupies the port is
insufficient. The CLI should emit a bounded ready message after its own listener
has bound; the supervisor independently probes the existing `/readyz` route.
Ready means local server admission readiness, not guaranteed upstream model
entitlement, quota, or a successful inference. Do not add a model call to startup.

Stop sends a graceful-stop message once through the supervisor's original child
IPC channel. The CLI invokes the same close path used by its first shutdown
signal. This avoids Node's nonportable SIGTERM behavior on Windows. The
supervisor observes the child's original close event and both output streams.
Repeated stop requests during draining must not send a second signal: the current
CLI treats a second SIGTERM/SIGINT as forced exit. Preserve the current
`proxy.close()` drain semantics and configured grace window.

A stop command may time out while the supervisor continues waiting. Return
`draining`, retain ownership, and allow a later stop/inspect to observe completion.
Do not silently introduce force-kill semantics. On final child close, finish log
writes, remove only the matching record/control endpoint, and close the supervisor.
Listener disappearance alone does not prove SDK/native descendants were joined;
that remains the existing CLI/server close contract and needs an affected-flow test.

Reject detached startup under socket activation. The listening fd belongs to the
service manager; detaching would change its ownership/lifecycle. Foreground
socket-activation behavior remains unchanged.

## Logs and storage

The supervisor consumes both child output streams and writes private logs outside
stdout of the launching application. Bound storage to 10 MiB per active file plus
one rotated file per endpoint across successive launches, document the exact
path, and preserve stream ordering
as observed without making cross-stream ordering claims. Handle backpressure and
write failures explicitly; an unwritable log destination fails startup. A later
logging failure must remain observable and cannot leave unbounded in-memory data.
Keep log handling in the supervisor so the parent can exit without breaking pipes.
Do not log environment/config secrets. Tests must cover rotation and permissions.

## Repository boundaries

- `bin/cli.ts`: argument dispatch, invoking the detached lifecycle API, and the
  private child-ready/stop protocol. Keep default foreground behavior intact.
- New `src/cli/` modules: private protocol, instance persistence/recovery,
  supervisor, bounded logging, and command formatting. Separate pure parsing and
  lifecycle state transitions from I/O for direct regression tests.
- Reuse existing configuration-root selection, status/readiness probes, process
  incarnation semantics, and proxy shutdown. Do not import desktop code into the
  CLI or add management policy to `server.ts`.
- Update build entrypoints so source and independently installed npm packages
  launch the same supervisor. Resolve module paths from the installation, not cwd.
- `README.md`, `docs/configuration.md`, and `E2E.md`: command/exit behavior,
  multi-instance examples, ownership boundaries, logs, and reproducible harness.

## Verification gates before acceptance

1. Real subprocess startup from a temporary application, followed by application
   exit: owned Meridian remains reachable; a fresh CLI invocation stops it.
2. Two simultaneous starts for one endpoint yield exactly one child and distinct
   created/existing outcomes. Two endpoints remain independently controllable.
3. Foreign listener, auth-shaped impostor, existing unmanaged Meridian, replaced
   record, malformed state, stale PID reuse, unknown incarnation, symlink record,
   and replayed nonce never authorize termination or destructive cleanup.
4. Parent death before spawn, between spawn/publication, and before readiness;
   child bind failure, delayed readiness, early exit, startup timeout, and full
   disk/log failure leave no untracked owned child or stale winning reservation.
5. Stop during a real active client turn uses the matching client/server plugins,
   actual implicated SDK/model, and existing drain/close behavior. Concurrent and
   repeated stop do not force the second-signal path; timeout preserves ownership.
6. Log rotation stays within its bound and no pipe is left owned by the launching
   application. Verify deterministic close/readiness results, not model wording.
7. Run the lifecycle harness against source and an independently installed tarball
   on each claimed OS/runtime. POSIX mocks do not establish Windows named-pipe,
   detached process, or process-incarnation behavior.
8. Run npm test, standalone typecheck/build and exact final-head CI. Adversarially
   inspect the final diff and keep actual missing-platform/model gates explicit.

All eight details requested in the issue are accounted for: detached survival,
foreground compatibility, idempotent startup, incarnation-safe ownership,
graceful targeted stop, multiple instances, persistent logs, and bounded
machine-readable startup outcomes. This proposal is not evidence that any of
those new behaviors have shipped.
