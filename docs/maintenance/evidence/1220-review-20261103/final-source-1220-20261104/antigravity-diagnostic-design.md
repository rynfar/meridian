# Antigravity idle local diagnostic design

Date: 2026-11-04

## Status

**Ready for design review only. Not READY to execute.** Parent alone executes after freezing and verifying a SHA256-named read-only helper. No command, test, build, helper execution, credential access, model call or network operation was performed. No existing source/helper was edited.

## Artifacts

- Plan: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/PLAN.md`
- Candidate preload: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/antigravity-local-preload.mjs`
- Candidate SHA256: `e2efd77a20016f108b6dbdb9f80cfed6a51945303ad72fddcd4b76fa3b2c9306`
- Source/proposed-test/hash manifest: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/design-manifest.json`
- One future exclusive capture file: `/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/antigravity-local-diagnostic-design/run-1.events.jsonl`

Source: `/Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104`; HEAD read directly from worktree metadata: `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`. The unchanged original/proposed test SHA256 is `0e856c9b393d2e712c7e09d23e78adb00f8a110763ac7655f304b740a2f01fe4`. There is no new test file; the proposed diagnostic uses the unchanged original test and body.

## Narrow mechanism

One Bun preload installs a fixture-path-scoped spawn spy, then a spy on the actual `createAntigravityServer` export. The backend returns a plain `app: { fetch }`, not Hono. The spy invokes the original factory exactly once, returns the same server, and wraps only that matching fixture runtime's fetch. Fetch delegation preserves receiver, argument objects, original Promise and Response identity. Non-200 responses alone are asynchronously cloned to retain the full error body; the original status assertion/body/cleanup remain unchanged.

The spawn spy likewise delegates exactly once using the same receiver, executable, argv and options objects and returns the identical real child. Matching child and pipe emitter proxies retain spawn/error/exit/close/end/finish facts and stdout/stderr emitted byte counts without adding consuming data listeners or starting flow. Only exact safe probe argv and conversation flag names are logged. No prompt, model value, arbitrary argv, full environment, stdin data or stdout/stderr contents are retained. Stdin byte count is intentionally absent; pipe close/finish is retained.

The added diagnostic `afterAll` awaits original matching child/pipe joins and body capture; no new internal timeout or limit is added. Parent owns the outer command, original command pipes and unchanged detached fixture groups. Proposed parent-only bound is 180 s plus at most 5 s TERM and 10 s KILL/reap/pipe-join grace. If custody cannot be established, do not execute; if cleanup cannot be proven complete within the bound, retain an explicit incomplete-custody gate. Test actor exit alone is insufficient.

No child-entry witness exists: that would require changing the fixture, dispatch or child environment. The actual shebang-selected interpreter remains unproven.

## Invariants and limits

- Production 20 s probes, original 10 s turn, 400 ms idle wait, all assertions and Bun's original 30 s test limit stay unchanged.
- No executable/argv/options/environment/dispatch replacement, fake model/account, retry or limit change. No explicit-Node launcher.
- Existing original fixture loopback MCP behavior remains; helper adds no network or model calls.
- Earlier backend import, spy/emitter function identities, sparse synchronous artifact writes, Promise reaction, failure-only clone tee and added custody hook perturb scheduling. This is not zero-overhead observation.
- Bun export/builtin spying and emitter coverage remain unexecuted hypotheses. Missing coverage, any capture errors, uncounted data events or incomplete joins must be reported as incomplete instrumentation.
- A green targeted diagnostic is expected to be **inconclusive**, not a fix or proof of the historical 20,010 ms 503. It cannot clear the red final `npm test` gate and does not reproduce full-suite load order.

The plan specifies a separately authorized local-503 clone/identity negative control plus known-byte/pipe-close control that would verify observer plumbing, not this failure. Neither is executed or injected into the original test. If safe export interception fails, stop; a separate minimal-body-observation worktree plus passive spawn preload is a new reviewed diagnostic, not an automatic fallback.

## Assumptions and constants

The supplied final-source worktree is the intended immutable source. Existing constants and files are unchanged. New constants are fixed diagnostic source/fixture/output paths, the safe metadata allowlist and proposed outer custody bounds. Runtime output is opened with exclusive creation and mode `0600`; parent must make the separate frozen helper mode `0444` and verify its content hash before announcing readiness. This report and the three design files are the only authored outputs.
