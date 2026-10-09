# Native Claude Code progress-caption proof

This manual gate drives native Claude Code 2.1.292 through the official Agent
SDK 0.2.141, with a separate real SDK backend and a selected full model ID.
The current fixture is Darwin arm64, Bun 1.3.11 and Claude Opus 5.5. The report
in #1288 does not identify its client/SDK/model/platform tuple; this supported
fixture cannot establish compatibility with that unknown tuple.

The native client must generate its own caption while a named foreground Agent
reads owned files. The sequential case requires a real pending Read checkpoint,
then working mapping/generation/history preservation and actual checkpoint
resume/fork after the caption. `--expect baseline` instead requires the original
mutation and subsequent replay. A successful answer without a caption fails.
Only the selected case is accepted; overlap, cancellation, disabled/isolation,
hint fallback, independently installed package, E41 and E55 remain separate.

Example shape (replace every absolute path with the exact selected input):

```sh
/path/to/bun-1.3.11 scripts/e2e-claude-code-progress-captions/caption-native-gate.mjs \
  --live-authorized --case sequential --expect fixed --hints 1 \
  --model claude-opus-5-5 \
  --entry /accepted/source/src/proxy/server.ts \
  --adapter-entry /accepted/source/src/proxy/adapters/claudecode.ts \
  --gate-entry /accepted/source/src/proxy/session/sdkProcessGate.ts \
  --state-entry /accepted/source/src/proxy/sessionStore.ts \
  --tree-entry /accepted/source/src/proxy/sessionTree.ts \
  --sdk /accepted/source/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs \
  --native /independent/native/claude --node /canonical/node \
  --task-root /canonical/private-task \
  --output /canonical/private-task/new-arm \
  --token-file /canonical/private-task/grants/access-token \
  --provenance /public-inputs/source-provenance.json
```

`task-root` and its grant ancestors must be owned/private (0700), with one
access-only grant file (0600, no refresh token). This gate never logs in,
refreshes the owner login or deletes grants/config/history. Its clean worker
environment preserves HOME/home/CODEX_HOME. Provenance schema 1 supplies
`kind: source`, `codeCommit`, `codeTree`, the exact SDK/client/backend/Bun/model/
platform/arch tuple, and canonical SHA256-pinned input rows including each
supplied entry role, including `adapter-entry`, and a `hono-entry` row for
the Hono entry resolved from the selected server source. The fixed baseline is `ae470d511f1f170168c7b95140ba0bb56d99d179`
with tree `0fef592183db00ce0bc81c988d51124b76bd374a`, equivalent to main
`30c738d77d5e7839577ebc5d144b74da4590e319`. Supplied rows are not an implied full
transitive or whole-OS closure. Root must qualify that scope in its receipt.

The source observer delegates the real SDK process gate and requires its actual
executor/handle/publication join, native init and query settlement, direct
process/stdio/callback joins and local HTTP/socket/writer joins. Review both
`report.json` and `parent-settlement.json` before removing a task grant.
Unobserved secondary processes/global absence stay unknown; no arbitrary PID
sweep or config/history cleanup is authorized. Forced interruption can leave a
missing report. Cancellation's private cache/live-child and actual-parent
observations remain explicit missing coverage; a source singleton cannot observe
a bundled package's living registry. Bundled package provenance is rejected by
this source-only observer.

The exact two scripts passed independent static review after three corrections
(second MCP status check, real client UUID attribution and sticky PostToolUse
first failure). They have **not yet run live**. On 2026-10-07 the supported work
and personal reads returned no credential object, and default had no
subscription access token. No grant was staged and no model query ran. A ready
owner login location is needed; no token should be sent in chat. Those facts describe the historical preparation; current status is recorded below.

The current-main correction derives every working snapshot from the real
selected `claudeCodeAdapter.getSessionId`, with the native request headers/body
and the Hono Context resolved from that same source. `adapter-entry`, state and
tree entries must name that server source's actual modules. Its exact profile
slot is required; root, old concatenated, sibling or other-profile slots do not
substitute. Mapping and generation observations use the same derived identity,
and receipts expose only identity/key digests. The six credential-free controls
in `src/__tests__/caption-native-working-mapping.test.ts` deliberately mutate
root and agent independently. The helper and harness correction require current
root review and local gates; the earlier independent review covered the original
two scripts, not this changed observer.

Current proof is tracked in the [current-main review](../../docs/maintenance/evidence/1292-current-main-20261008/REVIEW.md).
The fixture remains source-only and pinned to the historical Darwin tuple. Its
exact runtime availability, grant/custody and native invocation remain separate
gates; this correction alone establishes no native acceptance.

Credential-free observer causality control (run with an empty owned HOME/config):

```sh
bun scripts/e2e-claude-code-progress-captions/mapping-observer-control.mjs
```

It executes the exact historical snapshot excerpt and the current snapshot
function with controlled mapping/public-SDK fixtures. It reproduces the old
false pass and false failure, checks the new agent generation argument and
prints a small sanitized result. It launches no SDK/native process or model.
