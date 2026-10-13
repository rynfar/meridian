# Framework ACL correction: native tests pass, CLI startup still fails

Application head f5f7cb5f7d56cb5157f9b4c2b4256acea963cdb7.
[Native Windows job](https://github.com/rynfar/meridian/actions/runs/38352227847/job/115146976249).
[Original receipts artifact](https://github.com/rynfar/meridian/actions/runs/38352227847/artifacts/11791711180).

Seven native ACL/supervisor tests pass with 41 assertions, including the new
module-discovery restriction, private directory/file inspection, wrong-kind
rejection and existing broad/inherited ACL rejection without repair. All three
configuration diagnostics pass in 281–286 ms; previous diagnostics timed out or
failed module loading. The unchanged assertions now pass after the Framework
API correction, establishing that this stage improved.

Both source and independently installed actual CLIs still fail startup. They
now allocate/report the owned log path; cleanup returns already-stopped with
exit 0. Earlier failures never reached this path. This does not establish real
Windows lifecycle acceptance. The artifact omitted startup logs, so the next
harness captures only log paths inside its own scratch config/detached directory,
limits retained text to 8192 characters and keeps the clean hosted-runner/dummy
profile restrictions. No ACL bypass, credential refresh or inference is added.

Full local npm test, standalone typecheck and build exit 0; see
framework-acl-local-gates.json. Native lifecycle, live active-turn drain and
final-head CI remain gates. Issue #1302 and draft #1359 stay open.
