---
id: desktop-app
type: module-design
status: active
title: Meridian Desktop (macOS preview)
parent: architecture
references: [design-language, api-contract]
depends-on: [telemetry-ui]
---

## Responsibility

An optional Electron app for macOS that manages a Meridian service without a
terminal: connect to an external service or own a separately installed one,
install/switch versions, take over and return a launchd service, install
curated plugins, show usage/providers/requests, and deliver rate-limited
notifications from a window and a menu-bar panel.

## Boundary

- **Independent package.** Headless installs never install or import it; it
  ships as signed DMG/ZIP releases, not in the npm package.
- **HTTP only.** The main process talks to Meridian's HTTP endpoints and
  needs no plugin-contract changes. The one server addition it relies on is
  `GET /telemetry/timeseries` (owner-approved 2026-10-28, see
  [`telemetry-ui`](../../src/telemetry/SPEC.md)); against an older Meridian the
  charts are estimated from the latest 500 requests and say so. It may import
  only pure shared modules from `src/telemetry`: `providerView`,
  `providerSetup`, `profileBar` tokens, `settingRow` (the settings page's own
  env-override wording) and `pricing` (each request is valued exactly as the
  server's `computeCostEstimate` values it — pin, family fallback, tiers —
  with the overrides from `GET /settings/api/pricing`).
- **Sandboxed renderers** reach a narrow preload interface; IPC accepts only the
  exact main frame and local entry URL of its own windows. Clipboard requests
  carry choices, revalidated by the main process — never arbitrary text.
- **Data source is the Meridian the clients use** (`detect.ts`). On launch and
  on *Re-detect*, candidates are gathered in order — loaded launchd jobs
  mentioning meridian (port from `launchctl print`'s environment, else the
  loaded plist), OpenCode/Pi client configs (read-only), `127.0.0.1:3456`, the
  saved endpoint — deduplicated by base URL, loopback-only, and verified with
  `/health`. A verified service that is not the app's own child (by URL or
  listener pid) is attached; a running managed child is drained and the
  managed copy is not started. The managed copy runs only when nothing is
  found. Attaching reads only; it never takes ownership or imports secrets.
  Detection's read-only commands time out (5 s) and a probed `/health` body is
  capped at 64 KiB (API reads at 32 MiB): any local listener may answer.
- **The API key stays with its endpoint.** A key entered in Service →
  Connection is bound to the endpoint saved with it (`apiKeyFor` in the
  encrypted blob; `localhost` and `127.0.0.1` count as one service) and is
  sent only there; in managed mode it goes only to the running child started
  with it. Detection switching the viewed service never
  carries the key along: the new service reads as unauthorized, naming where
  the saved key belongs, until a key is entered for it.
- **Configuration errors are scoped.** An unreadable `desktop.json` blocks
  every write (it holds the encrypted secrets and handoff journal). A failed
  handoff recovery blocks other changes but not writing the journal, so
  *Return to headless* (shown once a takeover completed) can be retried until
  the original supervisor is healthy. A takeover that crashed before it
  completed is retried on the next launch.
- **Failures are typed.** `DesktopState.connection` is `ok | stopped |
  unauthorized | wrong-port | not-meridian | starting` with message and fix;
  a failed read leaves `requests` null, never an empty list. When the service
  answers but one read fails, the part that needs it says *Could not read …*
  with the error and Refresh (window and menu bar) instead of a skeleton, and
  nothing claims "no failures" without the data behind it.
- **Account and settings parity over HTTP.** Switch, rename, reorder, ChatGPT
  seat sign-in/renew/remove, Claude sign-in (paste-code routes) and
  `/settings/api/*` writes go through the viewed server in either mode. Only
  Claude account removal needs the managed CLI (no HTTP route exists). ChatGPT
  seats are added, signed in, renewed and removed here only where Meridian owns
  their logins (`chatgpt.owner.name === 'meridian'` with `webSignIn`);
  otherwise the app shows the owner's login/refresh/import commands as
  selectable text and the seat's `removal` text, as `/profiles` does.
- **Limits are current or say they are not.** A window whose reset has passed
  never limits an account (no limited badge, no Needs attention item, Use
  stays offered); it reads "reset at HH:MM, awaiting a new reading" in grey. A
  stale reading never draws as free capacity: warning colours stay dimmed,
  green turns grey. A refusal (`spent`) holds the account until its `until`,
  and so does a pool-routing bench (`/profiles/list` `exhausted`), shown as
  "benched" as the web dashboard does.
- **Ownership is explicit.** Docker, Nix and other external supervisors keep
  ownership when the app connects; only compatible macOS LaunchAgents can be
  transferred, via a confirmed action and an encrypted journal that survives
  until the original supervisor is healthy again. Quit drains only the child
  the app owns.
- Managed versions run under bundled stock Node (not Electron's ABI) and are
  installed atomically; a failed activation restores the previous version.
- **Renderers are React** (`src/ui`, bundled by esbuild; Tailwind v4 maps the
  DESIGN tokens through `@theme`). All presentation logic lives in pure view
  models under `src/ui/model` and is unit-tested; components only lay them out.
  React, Radix, TanStack Table, Recharts and Tailwind are build-time
  dependencies of this package only.
- **One purpose per screen, nothing repeated** (owner decision 2026-10-28):
  *Today* (health, "Prompt from cache" — the token-weighted share — and
  requests heroes, the day strip, serving account with limits and pace, live
  feed, needs attention; Extra Usage as a share of its monthly limit, never
  dollars), *Traffic* (window stats, requests chart, the
  request table and detail with waterfall and routing chain), *Cache* (hit
  rate and tokens over time, savings, keepalive, low-cache continuations),
  *Accounts* (the only provider/account grid), *Logs*, *Service* (connection,
  process, versions, plugins, every server setting, desktop preferences). The
  time window (1h / Today / 24h / 7d, default since local midnight) applies to
  every windowed figure, including the request table. Keepalive beats are
  excluded everywhere except the Cache screen's keepalive panel. Where a
  figure cannot cover the window it says so: Antigravity totals are labelled
  "since the service started"; a truncated timeseries, an estimate whose
  requests stop short of the window, and a table holding only the latest
  requests of a larger window each carry a note. Today's 24 slots follow the
  wall clock, so DST days lose or repeat no hour.
- **Polling respects the live proxy.** State refreshes every 10 s, but the
  window-scoped reads (summary, timeseries, routes) — synchronous scans in the
  process serving traffic — are reused within a per-window TTL (1h: none;
  Today: summary live, series 30 s; 24h: 30 s; 7d: 60 s). A forced refresh, a
  window change, a moved range start or a failed read re-reads at once.
- **Keyboard.** ⌘1–⌘6 open the screens; ⌘R is the application menu's
  *Refresh data* (the renderer leaves it to the menu, so it refreshes once) and
  ⇧⌘R *Reload window*. Request rows on Today and Traffic open with Enter or
  Space and show the accent focus ring. A deep link to a request opens it even
  outside the time window, noting so.
- Visual rules follow [`design-language`](../../DESIGN.md) → *Native desktop
  preview*.

Lifecycle details: [`architecture`](../../ARCHITECTURE.md) → *Optional desktop
application (preview)*; usage in `apps/desktop/README.md`.

## Known limitations

- **macOS on Apple Silicon only**; Windows and Linux runtime verification is
  outstanding, and the app labels itself a preview.
- Crash recovery of an owned service stops after three attempts.
- The plugin installer never installs into an externally managed service.
- The web dashboard's *Subtree cancels* card (`summary.sessionTree`) has no
  desktop equivalent yet.
- "Saved by caching" prices the summary's per-model totals at base rates, so
  it can differ slightly from the per-request cost column (SDK pins and
  long-context tiers).
