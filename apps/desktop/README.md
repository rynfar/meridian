# Meridian Desktop — development preview

An optional Electron app for local Meridian installations. The first platform
is macOS, with native Liquid Glass through
[electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass)
on supported Macs. Linux and Windows integration remains unverified.

## Run locally

```sh
cd apps/desktop
npm ci
npm start
```

To build an unsigned local Mac app:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

On Apple Silicon, open `release/mac-arm64/Meridian Desktop.app`. Output
architecture follows the build machine. This is not a signed/notarized release.
Desktop dependencies are separate: headless npm, CLI, Docker and Nix users do
not install Electron or need the app.

## Connect to an existing installation

Opening the app detects Meridian at `http://127.0.0.1:3456`. Settings accepts
another local HTTP address and an optional API key, encrypted with Electron's
secure storage. Docker works through its published local port; Nix, npm and
other supervisors expose the same Meridian HTTP interface. Remote connections
and native Docker/Nix update integrations are not implemented.

Connection alone does not grant installation or process ownership. External
services remain running when the app closes or quits. Their versions are
updated through their existing package manager. Account switches, plugin
reloads and feature changes apply to the connected service when explicitly
requested in the UI.

## App-managed installation

1. In **Versions**, check for releases and install a version for the app.
   This downloads a separate copy and leaves any external installation intact.
2. In **Service**, choose app management and an available port. To reuse an
   existing service's port, first stop that service through its current owner.
3. Start Meridian. The app verifies the version and owned listener before
   reporting success. Installed versions stay pinned until explicitly changed.

**Close window** keeps the service running in the menu bar. **Quit app** drains
and stops its owned process. Unexpected child exits trigger up to three recovery
attempts. Settings can start managed Meridian when the app opens; the packaged
Mac app can also open at login.

Version activation drains the old child, starts the selected CLI, and rolls back
the selection/process if startup fails. Installed older versions remain available
for manual rollback. The app runs the published CLI under bundled stock Node,
using normal Meridian config and Claude credential locations. It does not copy,
reset or rewrite those stores. Shell-specific environment overrides are not
imported automatically when creating a new managed installation.

Automatic takeover of an existing supervisor is **not enabled yet**. The draft
launchd implementation only considers direct, current-user, loopback CLI jobs
with a sufficiently long drain timeout and unchanged plist. Its encrypted
recovery journal is written before supervisor changes. Wrapper scripts,
containers, system services and declarative installations stay externally owned.

## Monitoring and troubleshooting

- Live health, profiles, quota windows/reset times, request history and cache
  history; polling pauses during lifecycle operations.
- Search requests by model, account, client or ID; filter failures and low-cache
  continuations. Open a request for timing, token counts and session identifiers.
- Separate searchable views for alerts, diagnostic events and managed
  process/installer output.
- Opt-in notifications for newly observed failures, repeated low-cache
  continuations, and fresh quota crossings at 80% and 95%. Existing history is
  seeded without replaying a notification storm on launch.
- Profile sign-in through the selected managed CLI, account switching, plugin
  reload, and client feature toggles.
- Export an operational summary with aggregate timings and counts, excluding
  raw logs and prompts.

Summary metrics use the server's reported time window. Request history can
include older requests. Missing quota data is not zero usage. Cache alerts are
advisory: three recent continuations are grouped by account, model and client
source, not proof of a cache bug in one SDK session.

App preferences, encrypted connection credentials, installed versions and
bounded incident history live under Electron's user-data directory in the
`preview` subdirectory (retained for compatibility with the first preview).
Service output is bounded in memory. Secrets, request histories and raw logs
are not included in the diagnostic export.

## Verification status

Focused tests exercise real Node child startup, request draining, occupied-port
refusal, failed-version rollback and crash recovery. The actual unsigned Mac app
has installed published releases and switched its owned service between 1.71.1
and 1.71.0 while leaving the external service on 3456 untouched.

The real `claude-haiku-4-5` request reached the SDK but failed because the selected
account's OAuth session was expired and could not refresh. Successful model
responses across restart/version switching remain a required gate; see
[`E2E.md`](../../E2E.md#desktop-interface-preview). Automatic takeover, system
notification delivery, sign-in completion and other platforms also need live
verification before release. The native notification test reported
`UNErrorDomain error 1`, which is displayed in Settings; delivery has not passed.
This work is not release-ready.
