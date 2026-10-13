# Startup fails before any log file exists

Head cecdaeb9925bf332c58f77b44b42c7656a7466f9; application remains f5f7cb5f.
[Windows job](https://github.com/rynfar/meridian/actions/runs/38352970255/job/115149328074)
failed both real source and installed CLIs. All three path/ACL controls still pass
in286–298 ms. Both command-reported log paths are absent (ENOENT), including after
idempotent cleanup. A returned logPath is only the computed destination; it does
not establish allocation or child launch. Earlier wording describing allocation
was too strong. The uploaded receipt now retains this concrete observation.

The launch coordinator runs between successful detachedPaths and supervisor
spawn/log creation; it captures OS-backed process identity. The next source-only
probe executes the same owned launch lease acquisition and releases it, recording
whether paths or launch-coordination failed. Controls compare the restricted
environment, PSModulePath alone, Windows module variables together, and clean
hosted runner environment. The last control imports only detachedStore and the
coordinator; no CLI, SDK, model or environment dump. A referenced deadline keeps
the standalone lease probe alive; acquisition remains bounded and fail-closed.

These are diagnostic controls, not feature acceptance. No process identity bypass,
ACL relaxation, auth refresh, profile switch or inference is added. The application
has not changed since the full5778-test/typecheck/build result. Draft #1359 and
issue #1302 remain open; actual Windows lifecycle and live active-turn drain are
still gates.
