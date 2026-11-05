# 1.89.0 release decision — awaiting owner disposition

## Candidate and scope

- Release Please PR #1486, final head `f4c1dcbcfd8c2d01cfd3c4eaa49479c25560aef2`, tree `6addd303a448894714a97675bfc87a9f307d53fd`.
- Main `cafdcf780f1b40c8f0dee17481132f47b4cbb353` includes merged #1220 and test-only #1507. Product runtime and dependencies are unchanged from the accepted #1220 main. The release delta is version metadata and corrected notes.
- Nowaker's #1220 credit is present. Notes accurately say JSON lock waits and durable filesystem writes are asynchronous; reads, parsing and serialization remain synchronous.
- No publication has started. No manual version, tag or npm publication was used.

## Passed on this exact head

| Gate | Result |
| --- | --- |
| Full local npm test | 8,857 passed; 65 skipped; 0 failed; 29 process groups |
| Standalone typecheck and certified build | PASS; clean exact head; Bun 1.4.3 / Node 22.22.3 / Darwin arm64 / SQLite 3.53.4 |
| CI 42080848312 | 8,894 passed; 28 skipped; 0 failed; 29 groups; relevant Windows, Docker, desktop and Nix checks pass |
| Independent final delta review | No concrete material finding; full earlier tag-range review retained |
| Independent tarball install | All 703 manifest artifact hashes and SHA512 integrity match; SDK 0.2.141 confirmed |
| Packaged Node runtime | Migration, two HTTP processes, restart, export, legacy reader, SIGKILL recovery and bootstrap pass |
| E79 fixtures | All six pass; real Pi 1.4.0 with Meridian extension and OpenCode 2.2.0 with matching V2 plugin/config/runtime headers; scripted upstream, not live-model stop proof |

The original local release failure remains archived: 8,293 passed / 65 skipped / 1 failed when migration found a live lifecycle candidate. #1507 isolates the unchanged six contract tests. A held-candidate control proves the process boundary without weakening live-residue refusal; the historical originating sweep remains unproven.

## Open live gate

The planned actual OpenCode 1.18.34 / Meridian V1 plugin / scrub 0.3.0 / SDK 0.2.141 / native 2.1.296 / Opus 5.5 read, real tool result and same-session continuation has **NOT RUN** for this release artifact. Fresh read-only OAuth usage admission returned **HTTP 429 before inference**. No release model call, credential refresh, owner credential write, billing change or provider contact occurred. The earlier HTTP 200 / Extra Usage OFF receipt is not fresh capacity proof. No blind admission retry is queued.

Earlier owner-accepted #1220 E41 SSE refusal/unrun parallel and historical cache/native/runtime risks remain accepted gaps, not passing tests. The full-range review also retains unqualified concurrent publication, E71/E72, awaited-clear/E42 and real-model stop/priority-client extensions. Existing #1220 risk acceptance is not silently extended to this new missing release-artifact check.

**Decision needed:** wait for fresh live admission and finish the actual-model check, or explicitly authorize publication with this missing release-artifact live verification disclosed. Neither choice turns it into PASS. If publication is authorized with the gap, fresh registry real-model qualification may remain blocked too; publication/installed-package verification must still be reported separately.

## After any authorized publication

Use the normal Release Please exact-head merge. Verify the release/tag/source SHA, npm version/latest/integrity/provenance, fresh registry-installed runtime and affected-client flow, Docker semver/minor tags for both architectures, and desktop assets/status. Do not claim the release complete while required publication or installed-package evidence is missing. No new queue implementation starts before the release is stable.

No product constants changed.
