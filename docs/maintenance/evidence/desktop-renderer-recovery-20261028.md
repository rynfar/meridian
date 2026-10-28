# Desktop renderer recovery — 2026-10-28

## Scope and identity

- Source base: `95b3af5a2` (Meridian 1.87.0). No server, client-plugin or
  provider behavior changes. The PR head identifies the candidate source.
- Before: installed Meridian Desktop **1.86.0**, unmodified
  `Contents/Resources/app/dist/main.cjs`, SHA256
  `7d99049af554a0fd80c601b56e8ae69ad263d4d102f9271bc5d8cb8b053e9241`.
- After: locally bundled candidate desktop main, SHA256
  `fa04e09a0e90e103a81a45269a21e060eacde3cd0fd181bc96684a45a3f1a47c`.
- Actual runtime: macOS **26.6.2** arm64, Electron **44.3.0**. All native runs use
  disposable user-data/preferences and the unreachable fixture endpoint
  `http://127.0.0.1:1`. Neither the owner's running app nor its accounts or
  service is changed. No model, SDK generation or credential is implicated.

## Reproduce

The committed harness is `scripts/e2e-desktop-renderer-recovery.cjs`:

```sh
npm ci --prefix apps/desktop
npm run build --prefix apps/desktop
env -u ELECTRON_RUN_AS_NODE \
  E2E_DESKTOP_MAIN='/Applications/Meridian Desktop.app/Contents/Resources/app/dist/main.cjs' \
  apps/desktop/node_modules/.bin/electron scripts/e2e-desktop-renderer-recovery.cjs
env -u ELECTRON_RUN_AS_NODE \
  apps/desktop/node_modules/.bin/electron scripts/e2e-desktop-renderer-recovery.cjs
env -u ELECTRON_RUN_AS_NODE E2E_RECOVERY_CASE=signals \
  apps/desktop/node_modules/.bin/electron scripts/e2e-desktop-renderer-recovery.cjs
```

The first command must fail on the affected 1.86.0 build. It must not be pointed
at a fixed installation and called a negative control.

## Durable assertion receipts

| Arm | Result | Assertions |
| --- | --- | --- |
| Installed 1.86.0 | Exit **1** | Both renderers initially initialize; healthy wake/unlock does not reload. After actual `forcefullyCrashRenderer()`, **quick-controls stayed blank after renderer termination** for the ten-second gate. Electron also reports a disposed-frame state-send error. |
| Candidate crash-and-hang | Exit **0**, PASS | Each actual renderer is terminated and recovers; hidden windows stay hidden. An actual infinite JavaScript loop in the visible dashboard recovers through the bounded main-process health probe. The same main PID and both native window IDs remain. State IPC works and connection preferences/`owned: false` remain unchanged. |
| Candidate signals | Exit **0**, PASS | Healthy wake/unlock, transient unresponsive/responsive events, Utility crashes and clean GPU exits cause no reload. An injected abnormal GPU-exit event reloads both windows. An actually emptied quick-controls DOM recovers on wake. The native menu's Reload interface reloads both windows without renderer actions. State IPC still works. |

Final crash-and-hang diagnostics:

```text
Quick controls: Recovering interface: renderer killed (exit 2).
Quick controls: Interface recovered; service was not restarted.
Dashboard: Recovering interface: renderer killed (exit 2).
Dashboard: Interface recovered; service was not restarted.
Dashboard: Recovering interface: interface health check failed.
Dashboard: Interface recovered; service was not restarted.
```

Native reports were `rHpLGH` (baseline), `9PutrC` (crash-and-hang), and `FhTkff`
(signals), under `meridian-renderer-recovery-*` disposable directories. Those
paths are supplementary, **not** the durable proof: the runnable harness,
assertions, identities and receipts above are committed here. Before/after
quick-controls captures were inspected: the final panel contains its heading,
offline fixture status and actionable controls, rather than a blank surface.
Screenshots remain local, not uploaded artifacts.

## Adversarial review and corrections

- Page-load success must not reset the rolling crash budget. Direct tests prove
  three successful-looking reload/crash cycles still stop automatic recovery;
  manual retry and a later independent incident receive a new budget.
- Concurrent show/resume/crash/GPU signals coalesce. Late promises cannot finish
  a newer attempt, and destruction/shutdown prevents recovery. Reload/probe
  rejection, blank DOM and never-settling promises have bounded failure paths.
- A forced renderer termination initially raced `loadFile`, wasting a retry.
  The Electron adapter now awaits its actual `render-process-gone` event, with
  a two-second bound, before loading. Final native diagnostics above show one
  reload for each failure, not an unexplained green rerun.
- An initial production-clock default shadowed its initializer; corrected and
  covered without injecting a test clock. Native startup now passes.
- The harness originally selected a window by its transient title; it now
  requires exact local `index.html`/`tray.html` URLs. Final receipts use that
  correction. Sandboxing, fixed entry files and exact main-frame IPC validation
  are unchanged. No arbitrary URL, script or service action is accepted.
- An intermediate concurrent native run failed in screenshot capture with
  `UnknownVizError`, before recovery assertions; a subsequent run also emitted
  Chromium overlay-mailbox errors. Capture now explicitly keeps hidden windows
  hidden and records media failures separately from behavior. Final sequential
  runs have no media failures. This is not proof of compositor-reset recovery.
- No dependency, lockfile, managed-service lifecycle, credential store, plugin
  interface, account routing or server endpoint changed.

## Validation and remaining gates

- 47 desktop tests across eight files pass, including eight controller tests;
  root typecheck and desktop typecheck/build pass.
- Root build passes. An earlier concurrent build exceeded its existing
  two-second source-fingerprint budget; the serial run certified successfully.
- The first full test attempt used Apple's unqualified SQLite 3.51.0 and timed
  out. The full gate is being rerun with the documented patched SQLite selection;
  its final result and final-head CI belong in the PR before merge.
- Test library: Homebrew SQLite 3.53.4,
  source ID `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`,
  dylib SHA256 `75feed7151d3e496343ffee9c25960d85188ed99b2ffb1051fe016f912c6c808`.
- **Missing:** the owner's exact overnight WindowServer reset, a real GPU-process
  crash/compositor reset, native glass recovery after such a reset, active-model
  requests during that reset, and Windows/Linux runtime evidence. Synthetic GPU
  events are event-wiring evidence only. No claim covers an alive renderer with
  a silently broken native surface. No release or installed-app replacement is
  authorized or performed here.
