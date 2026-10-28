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
  only pure shared presentation from `src/telemetry` (`providerView`,
  `providerSetup`, `profileBar` tokens).
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
- **Failures are typed.** `DesktopState.connection` is `ok | stopped |
  unauthorized | wrong-port | not-meridian | starting` with message and fix;
  a failed read leaves `requests` null, never an empty list.
- **Account and settings parity over HTTP.** Switch, rename, reorder, ChatGPT
  seat sign-in/renew/remove, Claude sign-in (paste-code routes) and
  `/settings/api/*` writes go through the viewed server in either mode. Only
  Claude account removal needs the managed CLI (no HTTP route exists).
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
  *Today* (health, cache hit and requests heroes, serving account, latency,
  live feed, needs attention), *Traffic* (window stats, requests chart, the
  request table and detail with waterfall and routing chain), *Cache* (hit
  rate and tokens over time, savings, keepalive, low-cache continuations),
  *Accounts* (the only provider/account grid), *Logs*, *Service* (connection,
  process, versions, plugins, every server setting, desktop preferences). The
  time window (1h / Today / 24h / 7d, default since local midnight) applies to
  every windowed figure, including the request table.
- Visual rules follow [`design-language`](../../DESIGN.md) → *Native desktop
  preview*.

Lifecycle details: [`architecture`](../../ARCHITECTURE.md) → *Optional desktop
application (preview)*; usage in `apps/desktop/README.md`.

## Known limitations

- **macOS on Apple Silicon only**; Windows and Linux runtime verification is
  outstanding, and the app labels itself a preview.
- Crash recovery of an owned service stops after three attempts.
- The plugin installer never installs into an externally managed service.
