# Meridian 1.89.0 — publication paused

Final Release Please #1486 head **`f4c1dcbcfd8c2d01cfd3c4eaa49479c25560aef2`**, base **`cafdcf780f1b40c8f0dee17481132f47b4cbb353`**. Nowaker/#1220 credit is intact. No product runtime, dependency or constant change.

## Passed on the final head

- [Local suite](after1507-final-local-receipt.json): **8,857 passed / 65 skipped / 0 failed**, 29 process groups; standalone typecheck and certified build pass.
- [CI 42080848312](after1507-final-ci-receipt.json): **8,894 passed / 28 skipped / 0 failed**, 29 groups; relevant Windows, Docker, desktop and Nix checks pass.
- [Independent final delta review](after1507-final-delta-review.md): no material finding; [full tag-range review](full-range-final-review.md) retained.
- [Independent package](after1507-final-installed-verification.json): all 703 artifact hashes and integrity match; SDK 0.2.141 confirmed.
- [Packaged Node runtime](after1507-final-packaged-runtime-receipt.json): migration, two HTTP processes, restart, export, legacy reader, SIGKILL recovery and bootstrap pass.
- [All six E79 fixtures](after1507-final-e79-receipt.json) pass, including actual Pi1.4.0 and OpenCode2.2.0 with matching Meridian integrations. [Configuration and runtime witnesses](after1507-final-e79-witnesses/). Scripted upstream, not a live-model stop pass.

## Still open

The release-artifact actual OpenCode V1 / scrub0.3.0 / SDK.141 / native.296 / Opus5.5 read/result/continuation check **did not run**: fresh read-only usage admission returned HTTP429 before inference. No model call, refresh, owner credential write or provider contact. [Blocked receipt](candidate-actualclient-blocked-receipt.json). Earlier owner-accepted #1220 risks and [named additional coverage gaps](range-review-receipt.json) remain disclosed, not passing tests.

**[Owner release decision needed](final-release-decision.md): wait for fresh live admission or explicitly authorize publication with this missing artifact check.** Publication has not started. Fresh registry real-model verification may remain blocked too. No blind retry is queued.

## Retained correction evidence

The [original local failure](final-local-failure-receipt.json) remains archived. [#1507 landed proof](contract-isolation-postmerge-verification.json), [held-candidate control](contract-isolation-control-receipt.json), [independent review](contract-isolation-adversarial-review.md): unchanged six contract tests isolated, no weakened assertions/deadlines. The original sweep caller remains unproven.

After any authorized normal Release Please merge, verify tag/npm version/latest/integrity/provenance, fresh registry-installed runtime and affected-client flow, Docker tags/both architectures and desktop assets/status before claiming completion. [Next authorized queue](../next-backlog-20261105/README.md) stays held until release stability.
