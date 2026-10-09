# Attempt-owned checkpoint interruption: bounded offline qualification

Candidate code `bae7ada3995788c83f6de92e573807c447c587b5` changes production;
previous delivery `46ff481f` contained discovery only. Existing draft #1322 remains
held. The [scoped adversarial review](ROOT_REVIEW.md) records three material initial
findings, their separate correction and remaining acceptance gates.

The control belongs to one admitted SDK Query and its hook callbacks. It requires
complete public blocks, generation/metadata/UUID and exact forwarded-hook inputs;
releases complete prefix denials for serial dispatch, holds the final accepted
hook through public interrupt acknowledgement, then drains the same iterator.
Only a matching owned result/error relationship may qualify. Retirement precedes
cleanup awaits. Unjoined native/control custody retains fencing; cleanup failure
refuses checkpoint publication. Pre-intent SDK-owned/nested work keeps its normal
drain. Caps, kill switch, operator override and public interfaces are unchanged.

## Concrete before/after

- Initial mixed/nested fallbacks fail; three new regression assertions fail.
  Corrected focused suite: 46 pass, zero fail, plus typecheck.
- [Initial cap-one native FAIL](fresh-component-cap1/output/COUNTER_DISCOVERY.json):
  one API round, full parallel results/history, acknowledged interrupt and physical
  joins, but the new component rejects `error_max_turns` / `aborted_tools` / counter
  two. [Corrected cap-one fork](corrected-cap1-fork/output/COUNTER_DISCOVERY.json)
  passes that exact owned tuple and preserves both client results once in a distinct
  durable fork while original public source history remains unchanged.
- [Native discovery matrix](native-terminal-matrix/output/COUNTER_DISCOVERY.json)
  independently records eight one-request cap/tool combinations. Native counters
  count tool handling: cap two/two tools returns four; cap four/three tools returns
  five. [Corrected matrix](corrected-terminal-matrix/output/COUNTER_DISCOVERY.json)
  qualifies all eight with unchanged Query caps and independent generation bounds.
  Ordinary max-turn reasons, wrong sessions/flags/reasons/results, unrelated errors,
  caller abort and over-cap generations still refuse qualification.
- Integrated [source](integrated-http-source-textdecode/output/INTEGRATED_HTTP.json)
  and independently [installed package](integrated-http-installed/output/INTEGRATED_HTTP.json)
  each pass one-tool/three-tool × streaming/nonstreaming, eight native SDK/API
  requests per arm. Assertions bind exact calls/results, published assistant UUID,
  distinct durable fork, no denial tail and unchanged source public history.
  Source is SDK 0.2.141/native 2.1.284; installed tarball resolves SDK 0.2.141/native
  2.1.296 and uses only the installed package entrypoint and dependencies. This is
  installed proxy execution, unlike the earlier source-options discovery arm.

These are real SDK/native executions against an owned scripted loopback provider,
in network-disabled read-only Linux/x64 containers. No real credentials or models
were used and no actual supported coding client launched. Component probes retain
original native/stdio witnesses; integrated probes retain original HTTP/backend/
listener settlement, production join-qualified receipt and empty native census.
All original owned container attaches join, containers stop/PID zero and are removed;
private runtimes are removed and frozen inputs stay exact. Inspect each arm's
`INPUTS.json`, `INVOCATION.json`, `CONTAINER_TERMINAL.json` and `TERMINAL.json`.

Failures are preserved: lost prior image (no native invocation), missing build
example, unsupported raw image-ID Dockerfile FROM, missing fixture machine-id
(zero model requests), and an SSE decoder omitting text deltas. The latter failed
after two complete cases/six requests; its [isolated decoder reproduction](SSE_TEXT_DECODE_REPRODUCTION.json)
shows before FAIL/after PASS with unchanged fixture response and assertions.
The [first full-suite failure excerpt](initial-local-gates/HTTP_FAILURE_EXCERPT.log)
overlapped source correction; its two HTTP failures are unqualified for the final
head. A stable full module-load HTTP control passes. [Final local gates](final-local-gates/LOCAL_GATES.json) pass at `bae7ada3`: 5,935
pass / 36 skip / zero fail, all 22 npm batches including pretest; standalone
typecheck/build pass and all original processes join. Earlier failures remain.

## Reproduce without credentials

The exact archived controllers/probes are historical invocation inputs. The
portable [replay.py](replay.py) copies the chosen escrowed probe into a new frozen
input directory and owns one bounded container. It never modifies the checkout
or mounts host credentials. It requires the exact locally retained source or
installed image; image absence is a prerequisite failure, not a product outcome.

```sh
python3 docs/maintenance/evidence/1211-attempt-owned-stop-20261009/replay.py \
  --arm integrated-http-source-textdecode \
  --image sha256:5c6c12b979458a102211392bee139ae1803c8d6d699c1d8c7d5bf6b89e5bf2d1 \
  --output /absolute/new/source-evidence

python3 docs/maintenance/evidence/1211-attempt-owned-stop-20261009/replay.py \
  --arm integrated-http-installed \
  --image sha256:832db10cd5ea47922e0e5199daf383051bfa1e5c991940e8685b98b4af3bb1a9 \
  --output /absolute/new/installed-evidence
```

The archived Dockerfiles and input manifests record the exact selected Git archive,
parent image chain, native install and npm packing/install. Source base manifest
is pinned. A fresh package install may resolve newer semver dependencies; record
its new identity and qualify it separately. Do not reuse the old installed identity
or treat a changed tuple as this proof. The portable installed replay itself passes all four cases/eight API requests.
Including failed discovery/fixture attempts, all 51 scripted SDK queries have
direct recorded API rounds; these are unrelated to historical real-provider counts.
Images/binaries are not committed.

## Acceptance holds

Whole-change acceptance remains HELD. Actual affected client/model source/package
E41, mixed-auto handback, root/scoped/nested cancellation and incidental parent
HTTP-abort independence, caption/reporter baseline/cache/overlap/abort, wider
platform/client/package, historical provider-count/wait attribution and final-head
CI including `test` remain separate. Prior actual 24/27 source failure stays FAIL.
The maintained actual-client observer must bind this new owned interruption rather
than accepting arbitrary aborted/error results. Renewed `work` login is not assumed;
use `meridian profile login work` before bounded real-model admission.

Owner checkout/index/all twelve dirty files and all eighteen raw contributor
Author/AuthorDate/full-message/ancestry records remain exact. Expanded #1231 is
excluded; #1211/#1231/#1283/#1292 stay open. No new PR/worktree, merge, source closure,
release or external comment. Full backlog goal remains active.
