# Reporter OpenCode 2.0.31 qualification

The accepted product head is `b409e105b6416f1424669eef040806fd461af530`,
based on main `30cc1d2d446a16de0add548fc108ace0932814ae`. Subsequent changes
only refine the manual evidence harness and documentation. [Provenance](provenance.json)
records independently packed/installed artifacts and exact native/client hashes.
The pre-fix control is main plus `600095b55508fe418c141d66e2115a28df4ad5ef`:
one setup-allowlist line admits 2.0.31 without bypassing normal setup. It has no
agent/session fix and is not described as a byte-identical main build.

The legacy `opencode-ai@2.0.31` package name and GitHub release tag were absent.
The actual official distribution is `@opencode/cli@2.0.31`; its Linux arm64
binary matches the official [pinned Homebrew formula](https://github.com/anomalyco/homebrew-tap/blob/c0945d387f5af410fbf1f93eb7a27612156f7b8a/opencode-v2.rb)
archive checksum. The runtime prints `opencode v2.0.31`. This version is now
explicitly admitted by setup; unknown future versions still fail closed.

## Reported flow

Both independently installed Linux artifacts used Debian bookworm arm64,
Node 24.20.0, actual OpenCode 2.0.31, bundled matching V2 plugin installed by
real `setup --v2`, server scrub 0.2.3, SDK 0.2.141, native Claude Code 2.1.301
and actual Haiku 5.5. The `reviewer` keeps the reporter's `mode: all` semantics.
Client discovery adopted Meridian's catalog. Build turns carry plugin-generated
human attestation; mode-all reviewer turns deliberately withhold that authority
while carrying primary-agent identity. Active scrub invocation is verified.

| Four user turns | Initial build | Switch reviewer | Same reviewer | Return build |
|---|---|---|---|---|
| Baseline model-facing reviewer canary | false | false | false | false |
| Candidate model-facing reviewer canary | false | true | true | false |
| Candidate actual answer contains canary | false | true | true | false |
| Candidate SDK resume | false | false | true | false |

[Original live baseline](live-baseline-r1.json) reproduces stale instructions;
[original live candidate](live-candidate-r1.json) passes. The original user
history survives all four turns. Each arm makes five Haiku 5.5 generations,
including title work; response IDs/models correlate across the provider,
original native stdout and public SDK history. No refusal, alternate model or
extra paid usage was observed. Credentials are read-only, grants contain no
refresh token, and each outer batch removes its private grant. Every original
subprocess and captured pipe joined. Container machine identity is initialized
normally; no process-lock bypass is enabled.

The committed harness is `scripts/e2e-opencode-agent-switch.mjs`. Run with
Node and the absolute `E2E_MERIDIAN_ROOT`, `E2E_OPENCODE_BIN`, `E2E_NATIVE_BIN`,
`E2E_PLUGIN_PATH`, `E2E_EVIDENCE_DIR`; pin `E2E_OPENCODE_VERSION=2.0.31`,
`E2E_SCRUB_VERSION=0.2.3`, and `E2E_EXPECT=baseline` or `candidate`. The default
runs the actual client/SDK/native against a loopback responder, without model
calls. `--live` additionally requires explicit `E2E_ALLOW_LIVE_MODEL=1`, a
private access-only `E2E_LIVE_PROFILE_FILE`, and a fresh read-only
`E2E_USAGE_GUARD_FILE` proving paid extra usage is disabled. Admission stops
before another generation after refusal, wrong model, upstream failure or the
12-generation bound. All preexisting product assertions remain enabled.

## Adjacent flows and recorder controls

[All four E41 arms](e41-qualified.json) pass with their original source-history,
call/result pairing, durable fork, exact one-answer and 95% cache-continuity
assertions. Sixteen real Haiku 5.5 generations correlate provider/native/stored
IDs. This separate host uses macOS arm64/native 2.1.302, rather than claiming
it substitutes for the reporter's Linux/native-2.1.301 proof above.

[E42 beta receipts](e42-beta-qualified.json) cover all three supported betas
18314, 18866 and 19271 in both source and independently installed package modes,
with live extended flows and separate client/proxy directories: real process
restart, resume, warm/cold xhigh discovery, actual tool/result, original/fork
isolation, undo, parallel general subagents and compaction. All six runs and
both original proxy workers per run are qualified; every actual model is
Haiku 5.5, and all original children/pipes join. Their 133 generations include
hidden and nested work; no failed case was regenerated to obtain clearance.

[E42 stable receipts](e42-stable-qualified.json) additionally pass source-build
and independently installed 2.0.31 plus installed 2.0.16 and 2.0.21, with
real setup, title/generate isolation, signed primary turns, resume, xhigh
discovery, actual tool result, fork isolation and compaction, using separate
client/proxy workdirs and the same strict model/custody qualification.

The original recorder failures remain evidence:

- Offline r3 wrapped `Readable.read`, but the native pipe can emit bytes
  directly; it observed no native rows and correctly failed correlation.
  Offline r4 observes `emit` in place without adding a data listener or changing
  flowing mode. Both loopback control arms then pass unchanged assertions.
- One beta's original SDK project directory differed after client-cwd adoption;
  public `getSessionInfo` supplied the original session's exact directory.
- The public conversation projection returned no info/messages for several
  auxiliary sessions. The public `importSessionToStore` API, with an in-memory
  metadata sink, exposes those stored assistant response IDs/models. Original
  failed reports and zero-new-generation qualifications are retained in E42
  receipts. No private SDK transcript file was directly read or edited.

The E42 model observer, proxy worker and exact gate substitutions are escrowed
in PR #1423's body; the underlying product assertions remain the committed E42
scripts. All probes preserve original failures and fail closed on model mismatch.

[Local validation](local-validation.json): `npm test` passes 7,042 tests,
36 skips, zero failures across all 25 isolated invocations, including pretest
typecheck. Standalone typecheck/build and 80 focused setup/agent/fingerprint
controls pass. Existing malformed digest, durable atomic publication/reload/
rollback, exact pending tool-result and dynamic same-agent controls are retained.

The adversarial pass checked every new server publication site, default-profile
and priority storage, old-writer migration, agent switch-back, failed/malformed
proof, replay/checkpoint UUID revocation, adapter dependency direction, client
prompt opt-out and headerless/subagent negative controls. No public plugin
header, lifecycle interface, model mapping or release metadata changes.
Same-agent instruction hot edits retain the native resume limitation.
Historical Opus refusal/cache/load failures remain open for their separate task;
this reporter-matching Haiku task neither retries nor clears them. No release
or Mac notarization was attempted.
