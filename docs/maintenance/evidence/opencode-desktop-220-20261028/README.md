# OpenCode Desktop 2.2.0 candidate — 2026-10-28

**Status: configured locally; live qualification OPEN. Do not merge the host
allowlist addition or describe this as released/fully qualified support yet.**

Owner authorization: configure Desktop to use Meridian; then explicitly add
2.2 support and launch adversarial reviews after implementation. No release
was authorized. Work starts from `origin/main` `95b3af5a2` in an isolated branch.

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
runs as successful evidence. Final follow-up review findings and final-head
validation remain PR gates.

## Validation and open gates

- Focused setup/plugin tests: 124 pass; evidence-helper tests additionally cover
  tool/echoed-marker false positives, unknown/future/pool admission, terminal
  current-turn completion (not a previous turn's idle), first-byte streaming,
  deadline rejection after partial output, byte budgets and request correlation.
- Typecheck and build passed. The full `npm test` command passed with the
  documented patched SQLite library; final helper refinements also passed
  their focused tests and typecheck. Required CI remains a separate gate.
- First full `npm test` failed because Bun's built-in SQLite 3.51.0 lacks the
  repository's required WAL-reset fix. Retest uses the documented test-only
  `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
  (Homebrew SQLite 3.53.4), and that full command passed; do not weaken runtime
  qualification.
- Live marker-resume and remaining live stable arms: **OPEN**.
- Actual native model identity/custody and older-host runtime requalification:
  not established by these runs.
- Required final-head CI, including `test`: **merge gate**.
- No merge, tag, publication, release or contributor-backlog work is authorized
  by this candidate configuration task.
