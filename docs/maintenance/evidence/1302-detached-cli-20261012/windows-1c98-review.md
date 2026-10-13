# Missing module path prevents launch-owner identity capture

[Native Windows job](https://github.com/rynfar/meridian/actions/runs/38353597974/job/115151309189)
on 1c98b21c failed both real CLIs; application remains f5f7cb5f.

The new owned launch-coordination probe establishes a specific environment
cause: paths/ACL succeeds, then the restricted environment fails after 10.382s
with "cannot capture turn-lock owner process incarnation". Adding only the
runner PSModulePath makes the identical lease acquisition/release pass in1.137s.
Adding the Windows module variables together passes in1.083s; clean hosted
runner environment passes in0.951s. No raw machine identity or environment
values are printed. Source/installed command logs remain absent.

Correction: preserve PSModulePath in the actual Windows harness's environment
allowlist. It supplies OS module discovery needed by the existing process-owner
probe, while all profile/auth inputs still come from isolated scratch and the
dummy API fixture. No application ownership or ACL check is bypassed. The
restricted diagnostic retains a without-module-path negative control.

This is a harness correction supported by same-operation before/after controls.
Actual source/installed Windows lifecycle must still pass. Full5778 local
application tests/typecheck/build remain qualified on unchanged f5f7cb5f; no
new application code or live inference. PR #1359 stays draft, issue #1302 open.
