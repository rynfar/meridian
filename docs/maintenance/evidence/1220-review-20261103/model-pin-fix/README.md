# Explicit-model refusal fallback — #1505

## Latest final local gate: FAIL

The final93b188f6 local run exits1:8247pass/65skip/2fail in group0. Bookkeeping
CLI beforeAll fails the unchanged2s full fingerprint; concurrent together passes
all200/ownership assertions but cleanupGC does not join within5000ms. Causes are
not established. Latergroups/typecheck/build do not run. No merge/timeoutchange
or green retry follows. [Receipt](failed-final-local-gate.json) and compressed
exact sanitized log retain the red; bounded independent diagnoses are pending.

Signed source head `41df72d664301d235df190a5afe2563aaf458c68` is independent
of contributor #1220. The existing per-request pin for recognized versioned IDs
adds `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`. Bare aliases stay unchanged.
This disables the installed native's refusal alternate-model switch only, not
refusals, same-model retry or separately configured SDK `fallbackModel`.

Focused tests fail36/5 without production change, pass41/0 after; model99/0,
typecheck/build pass. Final independent review covers all seven request/recovery
routes, env merge/stripping, POSIX/Windows gate forwarding and scoped limits.
Module spec records the decision. The validated product head was `41df72d6`.
After test-only #1504 merged, additive main integration advances #1505 to
`93b188f68d9664c46df62aa3249b4defffd884af`. Only the two test fixture files change in that merge;
all three model source/test hashes and the product spec remain unchanged.
Final combined local suite/typecheck/build and fresh final-head CI are running.

## Independently installed actual-client PASS

`npm pack --ignore-scripts` of the built exact head was independently installed
with its own dependencies (SDK0.2.141). Actual OpenCode1.18.34 ran on
Darwin arm64 / Node22.22.3 / explicit native2.1.296 / exact Opus5.5.
CLI setup installs exactly one generationV1 bundled Meridian plugin; actual
session/agent headers and server scrub0.3.0 runtime counters witness the route.
Four requests return200; real file receipt reaches the proxy; same-session
continuation repeats it; supported owned SDK history confirms only5.5 both
before continuation and after. All children/original pipes join.

The external verification env contains no fallback opt-out. A separately frozen
observer reads only the two allowlisted settings from successfully published
owned native gate files; all four gates contain the explicit5.5 pin and no-switch
flag1 from the **product**. Gate text/tokens/env maps are never retained. Offline
controls exercise the real gate, decoy assignments, malformed/missing/wrong/
duplicate settings, unrelated renames and error isolation. Independent review
findings against substring scanning were corrected before final live execution.

The first enhanced observer failed because it inspected the harmless shell
wrapper's spawn env rather than the later native gate. That attempt used
Node25.6.1 by mistake; its receipt stays failed, with no product-env failure
inferred. The final observer, offline controls and intended Node22 tuple pass.
No earlier result was relabeled. Only two metadata values enter the final report.

## Limits and custody

This is actual-client happy-path and subprocess-env evidence, not a deliberately
triggered refusal-switch before/after test or #1220 E41/historical acceptance.
The matched no-switch baseline E41 refusal remains failed and its matrix halted.
Included usage only; Extra Usage disabled; isolated access-only grant, no refresh,
credential writes, paid fallback or alternate account/model.

[proof.tar.gz](proof.tar.gz) and [manifest.json](manifest.json) escrow the exact
sanitized actual-client harness, observer, offline controls, before/after unit
logs, final report and receipts. Every archive member was reopened/hash-verified.
No token, private gate, raw transcript or client conversation is included.
The enhanced observer is retained as an exact PR artifact rather than a normal
repository E2E command; promoting this narrow witness into the existing committed
harness remains a follow-up if this fix is accepted. Existing actual-client
harness remains committed at `scripts/e2e-mcp-client-opencode.mjs`.
