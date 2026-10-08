# Choose the Claude Code executable at runtime

This is the contributor's historical evidence for the earlier source identified
below. Its execution, cleanup and local-gate statements describe that source,
not the corrected integration harness. The owner approved the bounded contract
in [#1319](https://github.com/rynfar/meridian/issues/1319) on 2026-10-08.
[The current maintainer review and joined proof](claude-executable-selection-review-20261008.md)
supersede this record for acceptance; final delivery-head CI remains required.

Settings gains a Claude Code Executable choice, backed by authenticated
`GET`/`PUT /settings/api/claude-executable`: **system** (the `claude` on PATH,
the default and #1250's order), **bundled** (the packaged CLI first, PATH as
the fallback) or **custom** (an absolute path that must answer `--version` like
Claude Code). `MERIDIAN_CLAUDE_PATH` still outranks it. Each turn resolves its
executable as it starts, so a change applies to the next turn of a running
proxy and a turn in flight finishes on the executable it started with.

Contract additions for owner review: the settings route; same-origin browser
writes, using the header setting's check, now shared as `src/sameOrigin.ts`;
and the `custom` value of `/health` `claudeExecutable.source`, reported only
when custom is chosen.

Why: after #1250, a host whose Homebrew cask held Claude Code 2.1.277 ran it
instead of the bundled 2.1.284, below the 2.1.280 that Opus 5.5 requires
(#1246), and the only way back was `MERIDIAN_CLAUDE_PATH` plus a restart. An
operator whose installation is newer than the bundle keeps #1250's default.

## Controls

Feature commit `d9429138f9d1c319e5f849068f40d14c66ad3a5b`, base
`30c738d77d5e7839577ebc5d144b74da4590e319`. With the feature's tests on the
base, all 7 `claude-executable-settings.test.ts` tests fail (no route), and 3
of the 6 new resolver tests fail: bundled, custom and vanished custom, because
the preference is ignored. The other 3 pin the existing order. The settings
test runs the real resolver against fake executables placed first on PATH, and
passes under the pinned Bun 1.3.11.

Rendering the card in headless Chromium found one defect before review. At
390 CSS px, a bundled path (one unbroken string) pushed a `<code>` 95 px past
the card and widened the layout viewport to 461 px. Paths in the card now wrap,
and the viewport stays at 390 px with nothing past the card, as on the base
page.

## Actual HTTP proof

```sh
npm run build
E2E_PROFILE_CLAUDE_DIR=<logged-in config dir> E2E_SYSTEM_CLAUDE=<a real claude> \
  node scripts/e2e-claude-executable-setting.mjs
```

The harness starts the built Node server once, with disposable config,
sessions, project, HOME/XDG and port, and read-only credentials. The `claude` on
PATH and the custom executable are wrappers that log which of them started and
then exec a real Claude Code; bundled is the package's own binary. The SDK
process gate execs Claude Code in the server's direct child, so procfs
attributes each turn's process to the executable that started it.

Environment: Linux x86_64, Node 26.10.0 running a Bun 1.3.11 build, SDK
0.2.141 and bundled Claude Code 2.1.284. The PATH entry runs an
operator-installed 2.1.292 (Arch `claude-code`); custom runs the bundled binary
through its own wrapper. Turns are actual `claude-haiku-4-5` requests, each with
an exact random receipt.

| Step | Feature | Base |
| --- | --- | --- |
| Starts on PATH; `/health` reports `path-lookup` | PASS | PASS |
| Turn: only the PATH executable started Claude Code | PASS | PASS |
| Settings state: system 2.1.292, bundled 2.1.284 | PASS | FAIL: 404 |
| Missing custom path refused with 400, nothing saved | PASS | - |
| Switch to bundled; next streaming turn ran it directly | PASS | - |
| Switch to custom; next turn ran the custom wrapper | PASS | - |
| Switch to system while a streaming custom turn was answering (landed 7.0 s before the turn ended); that turn finished on custom | PASS | - |
| Next turn ran the PATH executable | PASS | - |
| One server process throughout; zero residual processes | PASS | - |

The feature passed on every run: before and after the layout fix, and again
after rebasing onto the base above, which brought the 45 s PATH probe budget
(#1287) and owned resolver processes (#1300). The turns carry no
client headers, so Meridian's fallback adapter (`opencode`, plugin-less) served
them. Executable selection runs before any adapter-specific step, and no
OpenCode client flow is claimed. The run removes only its own transcript
project from the credential directory.

## Browser

Headless Chromium (chrome-headless-shell 1243, Playwright 1.54.2) ran against
an isolated built server at 1280x900 and 390x844 (mobile emulation). There was
no document overflow and nothing past the card. Interaction checks:

- Choosing bundled, then a custom path, re-renders the card with that executable.
- A nonexistent path answers 400 with an alert naming it, and keeps the saved path.
- Choosing system returns to `path-lookup`.

No page errors. The only console entry is Chromium's log of that deliberate 400.

## Local gates and limits

Bun 1.3.11: typecheck and build pass. Of the `npm test` stages, each run on its
own, the main stage gives 5098 pass, 1 skip and 1 fail, and all 19 isolated
stages pass (381), including `claude-executable-settings` 7/7. The failure,
Antigravity's multi-megabyte attachment test, needs `node
--experimental-transform-types`, which the local Node 26 no longer accepts. The
base fails it identically (5092 pass, 1 skip, 1 fail; its 18 isolated stages
pass, 374).

The setting has also run since 2026-10-05 on three deployed instances (two
Linux x86_64, one macOS arm64), set to bundled through the API. A day of their
logs shows no executable warnings, resolution failures or CLI-too-old refusals.

Windows is covered by the resolver's mocks only; no Windows turn is claimed.
Final-head CI remains the merge gate. Sanitized results are in
[claude-executable-setting-results.json](claude-executable-setting-results.json).
