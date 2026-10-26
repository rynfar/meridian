# Release 1.86.0 (2026-10-26)

Owner-authorized on 2026-10-26. Published and installed-package validated.

## Candidate

- Release Please [#1438](https://github.com/rynfar/meridian/pull/1438), head `a9e2c95aef79fbecdd01c263432c22b148444198`. The diff from `main` is only the version bump, lockfile version and changelog.
- Contents: #1408 Pi extension, #1426 `x-session-id` on `/v1/chat/completions`, #1437, #1440, #1452 and #1453. Each was adversarially reviewed and live-tested before it merged; the earlier release review of `49245d4e` found no code or packaging blocker.
- The candidate's six workflows were waiting for approval and were approved. All final-head checks passed, including `test`.

## Local gates on the candidate

- Darwin arm64, Bun 1.3.14 with Homebrew SQLite 3.53.4 preloaded for tests, Node 24.20.0.
- Typecheck and build pass. All 26 test groups ran: 8,132 pass, 63 skip, 14 fail. The 14 are the same environment-only real-process SQLite/cleanup set as unchanged `main`.
- `npm pack` (sha256 `faf277dd…7de2f`) installed into an isolated prefix and run on a spare port with an isolated config holding only pi-scrub 0.2.0. Real Pi 1.4.0 with the extension from that package, Claude Max:
  - Haiku 5.5 tool loop read a fixture (`KIWI-1860`); `pi -c` resumed it as `lineage=continuation`.
  - Opus 5.5 parent on `opus[1m]` ran pi-subagents 0.82.1's foreground `delegate` child, which arrived as `source=subagent-delegate model=opus agent=subagent`.
  - The scrub processed all six requests with no errors.

## Publication

- Merged with `--merge --match-head-commit`: `e521c5feb190d1b73b812b42bb51d1d068b3f11c`. The first merge call returned a GitHub GraphQL error and did not merge; the retry did.
- [Release workflow run 40340044246](https://github.com/rynfar/meridian/actions/runs/40340044246): `release-please`, `publish` and `docker` succeeded; `desktop / mac` failed at notarization with HTTP 401 (`Unauthenticated`), the same rejected Apple API credential as 1.85.0.
- Tag `meridian-v1.86.0` points at `e521c5f`. [GitHub release](https://github.com/rynfar/meridian/releases/tag/meridian-v1.86.0) has no assets; upgrade notes for #1426, the Pi extension and scrub, and the missing desktop download were added to it.
- npm `@rynfar/meridian@1.86.0`, dist-tag `latest`, `gitHead` `e521c5f`, integrity `sha512-PXOIvE4OPxt8OOd3GL8Ks2m2ctyDv40FtcflIuaDMHLWdP8oYPM4mkrmj6r3lV17l2pxJjCjssNt+HF3NIlodQ==`, with SLSA provenance v1 and the npm publish attestation. The version took about a minute to appear after the publish step.
- Docker `ghcr.io/rynfar/meridian:1.86.0` and `:1.86`, digest `sha256:4597b41a9677f6778b054fa3c6844e0627aebd62b56dd7c2a41caf6cc31c18e7`, linux/amd64 and linux/arm64.

## Installed-package validation (owner machine)

- Fresh registry install of 1.86.0 into a new pinned launchd runtime; lockfile integrity matches the published package. The owner's launchd service runs it on port 3456 (healthy, Max, pi-scrub active), with the previous plist backed up.
- `meridian setup --client pi` from that package updated the owner's Pi extension; the installed files match the package. A real Pi 1.4.0 Opus 5.5 tool loop through the service returned the fixture value and continued as one session.
- Meridian Desktop: the release desktop job produced no download, so the app was built locally from `e521c5f` with the workflow's electron-builder command, signed with the owner's Developer ID (`ZCL6PL2MJJ`), notarization off. The app reports 1.86.0 and passes `codesign --verify --deep --strict`. It runs its managed Meridian 1.86.0 on port 3489 (healthy, pi-scrub active).

## Found during validation

The owner's previous desktop app, running since 2026-10-16, showed an empty menu-bar panel. It had no renderer processes left, and the app does not reload a window whose renderer is gone, so only the native glass layer drew. A fresh launch of that same build, and the 1.86.0 build, render the panel normally on macOS 26.6.2. Reinstalling restarted the app; recovering a dead renderer is a follow-up.

## Not established

- No notarized desktop download exists for 1.86.0; the CI Apple notarization credential needs replacing.
- A live `next-user-turn` promotion on Pi remains unqualified.
