# OpenCode Desktop 2.2.0 qualification — 2026-10-28

**Status: Darwin arm64 / Opus 5.5 client qualification PASS; owner authorized
merge after final-head CI. This is not a published release.**

Owner authorization: configure Desktop to use Meridian; then explicitly add
2.2 support and launch adversarial reviews after implementation. No release
was authorized. Work starts from `origin/main` `95b3af5a2` in an isolated branch.

Merge follow-up: the owner selected **Opus 5.5** as the default, reported Desktop
was "working great", and explicitly requested merge. All CI on `4f12367fe`
(including `test`, smoke, desktop builds and Windows smoke) passed. The native
SSH signature was verified by GitHub. Owner acceptance is retained separately
from the automated Opus 5.5 gate below; neither turns the earlier refused
Opus 5 marker run into a pass. No release was authorized by the merge request.

## Before

- Actual macOS arm64 Desktop and its bundled CLI: **2.2.0**.
- Existing global configuration referenced the installed **V1** plugin.
- Actual Desktop-managed service reported that plugin failed:
  `Plugin must export a default definition with an id and an effect or setup function.`
- Published CLI `meridian` 1.83.1 rejected `setup --v2` for this exact executable.
  Main's allowlist also stopped at 2.0.31. No version gate was bypassed.
- New CLI regression test failed on unchanged production code: 14 pass, 1 fail,
  with setup returning 1 instead of 0 for 2.2.0.

## Candidate and configuration

Production change: one exact allowlist entry, `2.2.0`. The existing bundled
stable V2 plugin needs no API rewrite. The unknown `2.2.1` negative control
remains rejected without changing configuration. Tests cover replacement of the
V1 entry, deduplication, repeated setup and unrelated-setting preservation.

An independently packed/installed local candidate is retained outside the
worktree at `/Volumes/DevSSD/meridian/opencode-desktop-2.2-20261028`.
This is a local, unreleased build, not a new registry release.

The owner's global configuration was privately backed up before setup. Desktop's
actual running service then reported exactly one active `meridian` plugin from
that installed package and the effective Anthropic endpoint
`http://127.0.0.1:3456/v1`. Default model, title model, MCP settings and existing
local proxy key were preserved; supported legacy provider keys were converted
to native V2 shape. No application/service restart was used.

Identities:

- Bundled Desktop CLI SHA256:
  `7a9192584fd27afe39274f37a6c4ca7111e55884deb0248b20970e015fd3cefd`
- Installed `dist/meridian-v2/index.js` SHA256:
  `dc172a18132a604821e130499d0b4e2d8421f2dac61796475963acc2362276c5`
- Packed candidate: version metadata 1.87.0, SHA512 integrity
  `S/jrWpNREUEsFUSF8fBUl5DaTCkv0RDQ9Ig2AWsSzx++iPNMOe/ysUFBrDiD5GXSF5yqpoBbB1MKUbb2/5on7A==`.

## Reproducible credential-free gate

```sh
npm run build
E2E_OPENCODE_VERSION=2.2.0 \
E2E_OPENCODE_BIN=/Applications/OpenCode.app/Contents/Resources/opencode-cli \
  bun scripts/e2e-opencode-v2-stable-live.mjs --fixture
# Repeat with E2E_MERIDIAN_ROOT=<independently installed candidate package>.
```

Both final source and installed-package runs **PASS**, exit 0, with 12 Messages
requests each. This is the actual app's bundled executable, not a protocol
stand-in. Assertions cover exact setup/package loading, a plugin-originated
`/v1/models` fetch and adopted non-native 234567-token window, selected effort,
valid primary signature/session/agent, detached title/generate, assistant
answers, real client read/result round-trip, fork isolation and **completed**
compaction. All original client/server process and captured-pipe joins passed.
The generating process is the same server whose plugin/catalog were witnessed.

This fixture is not inference, native SDK custody, cold unseeded startup,
provider-model identity, a proxy restart, or another platform's qualification.
The harness deliberately requires an explicit `--fixture` or `--live`; it no
longer silently starts a credentialed proxy from the operator's ambient HOME.

## Retained live failure, not replaced by a green fixture

The independently installed client package was exercised against the actual
operator-authorized Meridian 1.86.0 service on loopback. The active profile had
fresh included capacity and **paid Extra Usage disabled** before admission.
The installed server SDK is 0.2.141. Requested model: `claude-opus-5`; proxy
telemetry routed `opus[1m]`. The exact native version was not pinned before
these attempts; a subsequent read-only version observation was Claude Code
2.1.312. That observation is not retroactive native-version evidence.

1. First primary returned the exact owned `OC2_STABLE_<uuid>` fixture.
   Resume retained the prior user input and signed identity, and telemetry
   recorded HTTP 200, `lineageType=continuation`, `isResume=true`, 23206 cache-read
   tokens and 141 cache-created tokens. **The assistant nevertheless refused to
   repeat the fixture, citing a safety classifier. The harness exited 1.**
2. The running server's scrub module was older than its already-saved manifest:
   module version 0.1.0 from package 0.2.0, versus configured 0.3.0. With zero
   in-flight requests, the existing manifest was reloaded; actual loaded
   opencode-scrub 0.3.0 and successful `onRequest` activity were verified.
3. The same marker and assertions were retried with that specific correction.
   The initial answer again succeeded; resume again cited a safety filter and
   did not return the fixture. **Exit 1; the correction did not resolve it.**

No entitlement failure is inferred from HTTP 200 or from these natural-language
refusals, and no credential refresh or paid fallback was requested. Dependent
variant/tool/fork/compaction live arms did not run. A later ordinary-chat
diagnostic stopped at its usage guard because fresh quota was unavailable;
it did not make another model request.

The two exact refused assistant excerpts are retained in
[`live-failure.json`](live-failure.json), without keys or customer transcripts.
The UUID is an owned test value, not a credential or user secret.

## Closed acceptance: real Opus 5.5, clean admitted run

The owner's corrected default is **Opus 5.5**, not Opus 5. The actual Desktop
2.2.0 bundled CLI and independently installed candidate package passed the full
stable live gate with requested model `claude-opus-5-5`, Meridian 1.86.0, SDK
0.2.141 and Claude Code 2.1.312 on Darwin arm64. The native file hash was unchanged
before/after. Supported `getSessionMessages` calls, restricted to the exact
request-correlated test SDK session IDs, witnessed **`claude-opus-5-5`** for every
Opus request, and `claude-haiku-5-5` for title work. No raw SDK/customer transcript
or credential is published.

The clean run has **12 Messages requests, all 12 correlated server statuses
200, no server errors**, 12 scrub invocations with zero hook errors, exact
assistant answers, successful resume/cache reads, real read/result, discovered
`xhigh`, isolated fork/original histories, detached title/generate, completed
compaction on `opus[1m]`, and all original test process/captured-pipe joins.
The signed/session/agent wire witnesses, server-resolved profiles, exact request
IDs and public-SDK model witnesses are preserved in [`live-pass.json`](live-pass.json).

### Admission and scope

The real owner proxy has four profiles. The controller supplies an **explicit
single-profile capability boundary**, not a claim that the owner proxy itself
has one profile: it pins `x-meridian-profile: personal` after the actual client
plugin, before forwarding each Messages request, and presents that same forced
scope in the admission inventory. Quota values are real upstream observations,
not fixture values. Fresh numeric included capacity and disabled paid Extra
Usage are required; every correlated server record independently resolves to
`personal`. No account configuration or OAuth credentials were copied/changed.

The exact, machine-specific execution controller is escrowed in
[`run-pinned-live.mjs`](run-pinned-live.mjs), SHA256
`ac54998d091bdaf55f9eedc48e84d42859cfcf632b8fb94f21e06482b772a8e9`.
It is forensic/manual evidence, **not an auto-run setup or CI entrypoint**.
Review its absolute paths and selected profile before intentionally invoking
this included-usage live test. Its private attestation key enters only through
the child environment; no key or token is retained in results.

This qualifies the pinned client/model path. It does not qualify unpinned
priority failback, another platform, a registry release, or original external
native-child custody. Owner acceptance separately covers normal unpinned
Desktop use. A process-identity observation under the actual proxy showed the
same hashed native executable, but is not attributed to individual test-session
actors. The owner service remained running throughout.

### Preserved infrastructure failures and controlled correction

The first Opus 5.5 controller run mechanically completed its positive assertions
after 26 requests: 12 status 200 and **14 `api_error` failures**, with a Bun
10-second relay-idle warning. That noisy run is **not** the clean acceptance
record. It exposed the recording relay's implicit idle cutoff and the absence
of a fail-fast in-band error latch. Relays now disable that idle cutoff while
retaining the explicit 120-second deadline; SSE error frames stop qualification
and further model admission instead of letting automatic retries hide them.
A direct negative test covers error frames split across LF and CRLF chunks.

One repeat stopped at its fresh-quota guard before inference. After fresh real
usage was available, the final run reused the same Opus 5.5 marker and assertions
with those identified infrastructure corrections and passed cleanly with 12
requests. This is not a claim that the older Opus 5 classifier refusal was fixed.

## Adversarial reviews and corrections

Two independent reviews were launched after implementation. The compatibility
review found no production regression; 124 focused tests and its independent
actual-client fixture run passed. The evidence review found material harness
gaps, which prompted these corrections:

- Explicit live admission and an external authorized single-profile proxy;
  numeric fresh usage (unknown/future observations fail closed) and
  actual loaded scrub checks replace ambient-credential proxy startup.
- Inference through the witnessed host, with exact installed package path.
- Signature verification, not mere header presence; request-ID-correlated model
  telemetry, rather than an external server's unrelated historical logs.
- Assistant-text assertions and a negative test proving tool output cannot
  substitute for an assistant answer; completed compaction state is checked.
- Streaming relay with abort propagation and byte budget, bounded child termination/escalation and original
  process/pipe joins; the external proxy and its native children remain outside
  the harness's owned shutdown boundary.

Earlier fixture iterations exposed test bugs (title jobs have no read tool;
plugin listing is asynchronous; a canned summary must fill the client's exact
template). The final gate fixes those causes and does not count their failed
runs as successful evidence. Follow-up review accepted the pin-boundary scope
conditional on server-resolved-profile checks, public-SDK model witnesses and
durable controller/results; those checks are present in the clean record.
Final-head CI remains a separate merge gate.

## Validation and open gates

- Focused setup/plugin/evidence suite: **131 pass**, including 7 helper tests covering
  tool/echoed-marker false positives, unknown/future/pool admission, terminal
  current-turn completion (not a previous turn's idle), first-byte streaming,
  deadline rejection after partial output, byte budgets and request correlation.
- Typecheck and build passed. The full `npm test` command passed with the
  documented patched SQLite library; final helper refinements also passed
  their focused tests and typecheck. Required CI remains a separate gate.
- An interleaved build hit the existing two-second source-fingerprint budget;
  the unchanged build command passed without the parallel live workload. No
  provenance limit or qualification guard was weakened.
- First full `npm test` failed because Bun's built-in SQLite 3.51.0 lacks the
  repository's required WAL-reset fix. Retest uses the documented test-only
  `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
  (Homebrew SQLite 3.53.4), and that full command passed; do not weaken runtime
  qualification.
- Live stable arms on actual Opus 5.5: **PASS**, with request-correlated public
  SDK model identity. Earlier requested Opus 5 refusals remain retained limits.
- External native actor custody, unpinned priority failback, other platforms and
  older-host runtime requalification are not established by this run.
- Required final-head CI, including `test`: **merge gate**.
- The owner subsequently authorized merge after acceptance. Tagging,
  publication, release and contributor-backlog work remain outside this task.
