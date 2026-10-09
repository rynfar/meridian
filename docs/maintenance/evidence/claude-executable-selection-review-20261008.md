# Executable selection: corrected integration review

The owner approved the bounded public contract in
[#1319](https://github.com/rynfar/meridian/issues/1319). This incorporates
[#1293](https://github.com/rynfar/meridian/pull/1293), source
`1a201f37ab49261ce9d463d2f43e1182ab66202a`, onto main
`74ee5515cde58a4df03a48c0ca38abb20ccad648`. System stays the default,
`MERIDIAN_CLAUDE_PATH` wins, accepted turns retain one executable through
retries, and only `custom` extends the existing health source enum. Source
acceptance and the bounded live gate pass; final delivery-head CI remains held.

Nowaker <spam@nowaker.net>'s actual commits were cherry-picked with Author and
AuthorDate intact: `c5811dc7` → `0de23574`, `1a201f37` → `32f64d54`.
Maintainer correction `bc695a99` separately owns settings/resolver probes,
revalidates writes and snapshots, and fixes cleanup/error recovery. Subsequent
commits change only the escrowed harness. Preserve human credit on integration.

## Root adversarial review

The root agent read the complete final diff, callers, tests, API/architecture
boundaries, UI and historical contributor evidence. No delegated independent
review is claimed. Three material source objections required corrections:

- Version checks belonged to neither their request nor the server. Disconnect
  or close could leave a child running, and another preference could evade an
  older resolver's missing join. Per-request/per-instance ownership now retires
  admission and cancels independent shared leases; missing process/pipe witnesses
  retain failed slots. Tests cover real suspended shell probes and synthetic
  unknown joins, including repeated bounded close and no replacement spawn.
- Asynchronous path vetting could overwrite a newer mode/path, or GET could
  mix its saved choice with another resolver's active identity. The route reads
  one preference/identity snapshot and rechecks the saved pair immediately before
  the synchronous merge, returning 409 on a conflicting mutation. A suspended
  version check with a concurrent cleared path and a foreign-writer GET control
  fail on the authored replay and pass after correction.
- The original harness could wait forever after leader exit and signal bare
  enumerated PIDs. It now captures original-child exit, close and both pipe
  witnesses at spawn, bounds TERM/KILL joins, preserves the first failure and
  uses residual enumeration only as a failure witness. Direct tests include a
  real Node leader exiting while a descendant retains its pipes.

Shared-probe tests also establish one version subprocess for simultaneous
callers and an unaffected surviving lease after the other request aborts.
Authenticated settings middleware and the existing same-origin/Host/port
browser policy remain in force. Leaf dependencies flow downward; no server or
session import enters a leaf. No model, tool, credential, retry or public plugin
contract expansion accompanies selection. UI reload failures now show an escaped
alert and Retry, and do not display a false default selection.

## Joined native controls

Both native arms use Linux arm64, Node 22.22.3, SDK 0.2.141, actual Haiku 4.5,
PATH Claude Code 2.1.292 and bundled/custom Claude Code 2.1.284. Main and
candidate are separately built from exact tracked archives with identical
locked dependencies and the package's normal native CLI installer. The first
container's inherited ignored-postinstall placeholder failed before inference;
that failure is retained, and normal installation was applied to both arms.
Candidate image `97ec04a8` has the same product/test inputs as correction
`bc695a99` and client-harness head `6fdd002a`; only the committed harness is
overlaid read-only. Full image/archive/harness hashes and joins are in the
[machine receipt](claude-executable-selection-review-20261008.json).

The raw HTTP baseline completed a real PATH turn, then failed at GET settings
with 404. The candidate passed twelve checks and all five real turns, including
JSON and SSE. The actual OpenCode V1 1.18.32 baseline independently completed
its signed, plugin-routed PATH turn, then failed at that same 404. The candidate
passed thirteen checks and five streaming turns in one saved client session:

| Turn | Actual executable | Completion |
| --- | --- | --- |
| Initial System | PATH 2.1.292 | PASS |
| After Bundled selection | Packaged 2.1.284 | PASS |
| After Custom selection | Custom wrapper → packaged 2.1.284 | PASS |
| Custom streaming while selecting System | Original Custom | PASS; switch landed 5,240 ms before turn ended |
| Following turn | PATH 2.1.292 | PASS |

Every turn delivered its random fixture receipt, started only the selected
Claude Code process, and completed. The actual client installed the tested
built V1 plugin using `setup --v1`; its effective config resolved that package
exactly once. Independently installed server scrub 0.2.3 was active. All five
primary requests carried valid plugin-signed session/agent/request identity
before relay forwarding, returned HTTP 200 and actual model
`claude-haiku-4-5-20251001`, and retained the same session. No manual client
headers or synthetic SDK/model were used. Invalid custom selection returned
400 without a mutation, and health/selection facts agreed.

OpenCode 1.18.32 returns file-URL config entries, emits no successful loader
log and omits CLI `step_finish`. Initial harness assertions for those shapes
failed and are retained. Actual signed outbound hooks, streamed `message_stop`
and completed assistant timestamps through OpenCode's public session API are
the corrected witnesses. No unexplained model rerun is counted as a fix.
Meridian exited zero; the client server was intentionally stopped with TERM.
Both leaders, captured pipes, all commands and relay handlers joined, without
KILL. Residual count was zero; the private borrowed grant was unchanged and the
run's credential snapshot removed. No private SDK files were inspected.

Reproduce after `npm run build`:

```sh
E2E_PROFILE_CLAUDE_DIR=<logged-in-profile> E2E_SYSTEM_CLAUDE=<actual-Claude-Code> \
  node scripts/e2e-claude-executable-setting.mjs
E2E_PROFILE_CLAUDE_DIR=<logged-in-profile> E2E_SYSTEM_CLAUDE=<actual-Claude-Code> \
  E2E_CLIENT=opencode E2E_OPENCODE_BIN=<absolute-V1-binary> \
  E2E_OPENCODE_VERSION=1.18.32 E2E_PLUGIN_PATH=<installed-scrub>/dist/index.js \
  E2E_PLUGIN_VERSION=0.2.3 node scripts/e2e-claude-executable-setting.mjs
```

## UI, local gates and limits

T3's collaborative browser exercised the real settings UI/API with a synthetic
version executable and no model calls. Selection persisted, the forced GET 503
showed an alert/Retry with no selection controls, and actual Retry recovered the
saved Bundled mode and enabled controls. The card fits 1280, 375 and 320 CSS px.
The document is 375 px at 375; at 320 it is 323 px because unchanged main's
existing SDK rows also end at 322.914 px. The new card ends at 296 px with no
overflowing descendants. Screenshots and targeted failure/Retry video were
reviewed and retained outside source. No GitHub media uploader is exposed;
these local media supplement the committed portable receipts.

`npm test` on `bc695a99` passed 5,502 tests, 35 skips, zero failures; its pretest,
separate typecheck and build passed. Later harness changes pass syntax/diff
checks, focused process-custody tests and the actual client gate; product,
plugin, package/build and test inputs are unchanged. Final delivery-head CI,
including `test`, remains required before merge. This establishes the named
Linux arm64 client/model flow, not Windows/macOS model behavior, an Opus-specific
version remedy, package publication or a release. The older contributor proof
remains explicitly historical. Supplemental private logs and reviewed media
are retained in `meridian-review-evidence-20261006/resumption-20261008-round2/executable1293`.
