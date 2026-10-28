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
- **HTTP only.** The main process talks to existing Meridian endpoints; the app
  needs **no server API or plugin-contract changes**. It may import only pure
  shared presentation from `src/telemetry` (`providerView`, `providerSetup`,
  `profileBar` tokens).
- **Sandboxed renderers** reach a narrow preload interface; IPC accepts only the
  exact main frame and local entry URL of its own windows. Clipboard requests
  carry choices, revalidated by the main process — never arbitrary text.
- **Ownership is explicit.** Docker, Nix and other external supervisors keep
  ownership when the app connects; only compatible macOS LaunchAgents can be
  transferred, via a confirmed action and an encrypted journal that survives
  until the original supervisor is healthy again. Quit drains only the child
  the app owns.
- Managed versions run under bundled stock Node (not Electron's ABI) and are
  installed atomically; a failed activation restores the previous version.
- **UI recovery is separate from service recovery.** Each window reloads its
  fixed local entry after renderer loss, an abnormal GPU-process exit or a
  persistent unresponsive event. Reopening, waking and unlocking probe the UI
  first; healthy renderers keep their unsaved forms. An unresponsive renderer
  is terminated before reload, without restarting the main process or service.
  Recovery preserves window visibility and sandbox/IPC restrictions. Per-window
  retries stop after three attempts in one minute, including apparently
  successful reloads, so crash loops cannot reset their own budget. A native
  dialog and **Reload interface** in View and the tray menu permit explicit
  retries. Recovery can discard unsaved UI forms, never persisted credentials
  or service state. Shutdown disables recovery.
- Visual rules follow [`design-language`](../../DESIGN.md) → *Native desktop
  preview*.

Lifecycle details: [`architecture`](../../ARCHITECTURE.md) → *Optional desktop
application (preview)*; usage in `apps/desktop/README.md`.

## Known limitations

- **macOS on Apple Silicon only**; Windows and Linux runtime verification is
  outstanding, and the app labels itself a preview.
- Crash recovery of an owned service stops after three attempts.
- A live macOS WindowServer/compositor reset has not been reproduced. Renderer
  termination/hang recovery does not establish recovery from every blank native
  surface, particularly when Chromium reports no renderer or GPU failure.
- The plugin installer never installs into an externally managed service.
