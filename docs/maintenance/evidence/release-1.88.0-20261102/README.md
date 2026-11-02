# Release 1.88.0 — candidate validation and publication (2026-11-02)

Owner-authorized 2026-11-02 ("lets get it done and merged and lets cut a new release"), after #1484 (weekly reserve) was reviewed and merged.

## Candidate
- Release Please #1469, head `6b4bf0c22b7610ee73810592fde3945283a71903`, directly on `main` `2a806fde1`. Diff from main: `.release-please-manifest.json`, `package.json`, `package-lock.json` (1.87.0 → 1.88.0) and `CHANGELOG.md` only. No dependency change since 1.86.0 other than the version field.
- Contents since 1.87.0 (15 commits): features #1470 (desktop redesign) and #1484 (weekly reserve); fixes #1473, #1476, #1482, #1475, #1478, #1471, #1477, #1467; plus docs/review records. Each PR carries its own review and E2E record.
- Candidate workflows were waiting for approval and were approved. All succeeded: CI (`41401425932`, incl. `test`), Docker, desktop, Nix installable builds, Nix node_modules hash, claude-code floor manifests.

## Local gates on the candidate
- Darwin arm64, Bun 1.3.14, Node 22.22.3, Homebrew SQLite 3.53.4 via `MERIDIAN_TEST_SQLITE_LIBRARY`.
- `npm test`: 8,253 tests; 4 failures, all in files that fail identically on unchanged `main` on this machine (`error-reporting` real-process ×2, `stream-idle-guard` real sockets, `plugin-update-routes` registry timeout). Typecheck and build pass.
- `npm pack`: `rynfar-meridian-1.88.0.tgz`, sha256 `d792f6d7e415d5ea09b584e3ce1a2c3a531c61a12fb0b1596004063eb1500e73`, 730 files. Against the published 1.87.0 file list (chunk hashes normalized), the only additions are `dist/telemetry/timeseries.d.ts{,.map}`; no tests, scripts or evidence are packed.

## Packed-package validation (installed tarball, isolated prefix, port 3498)
- Operator's real profiles and server plugins (opencode-scrub 0.3.0, pi-scrub 0.2.3, openclaw-scrub; the configured Hermes scrub path does not exist locally, so it loads with 1 error). The first attempt used the operator's settings (`active` mode, active profile at 100% weekly) and was rate-limited throughout; the counted run used env-only `MERIDIAN_ROUTING=priority MERIDIAN_PROFILE_ORDER=personal,<fallback>` with no settings written.
- `/health`: healthy 1.88.0, `plugin.opencode` and `plugin.pi` configured.
- OpenCode 2.2.0 with the package's V2 plugin (`setup --v2`, disposable client dirs): Sonnet 5.5 read-tool loop returned fixture marker `OC188-ef8c6951`; `--continue` resumed (`lineage=continuation`) and repeated it; Opus 5.5 routed to `opus[1m]` and answered.
- Pi 1.3.0 with the package's extension (`setup --client pi`, disposable agent dir): Haiku 5.5 read-tool loop returned `PI188-eb67721a`; `-c` continued (`lineage=continuation`).
- No refusal, 402, billing_error or "extra usage" text.

## Publication
- Merged #1469 with `--merge --match-head-commit 6b4bf0c22`: `cdca353924556acdc00eca8f4162f296f2dab875`.
- Release workflow run `41403136263`: `release-please`, `publish`, `docker` succeeded; `desktop / mac` failed at notarization (`HTTP status code: 401. Unauthenticated`), the same rejected Apple API credential as 1.85.0–1.87.0. All other workflows on the merge commit succeeded.
- Tag `meridian-v1.88.0` → `cdca3539`. [GitHub release](https://github.com/rynfar/meridian/releases/tag/meridian-v1.88.0) published 2026-11-02T06:57:10Z (no desktop asset).
- npm `@rynfar/meridian@1.88.0`, dist-tag `latest`, `gitHead` `cdca3539`, integrity `sha512-viHKwoF6UMWkYU0TNzJcqsKtTSui3wvROkCiZOpWIGrTHZDQ62fxtHMc/vY1SyX/RuwyH6UH2WqTpHoQ0DKYlg==`, SLSA provenance v1 (sigstore log index 3637908192). The registry returned 404 for several minutes after `publish` succeeded ("Your package is being processed"), then served it.
- Docker `ghcr.io/rynfar/meridian:1.88.0` and `:1.88`, digest `sha256:9f6ed70c7058a907e34d59e2339e116658c7dfa96650442990a59248163f71cb`, linux/amd64 and linux/arm64.

## Fresh registry install
- `npm install -g --prefix <tmp> @rynfar/meridian@1.88.0`; `/health` healthy 1.88.0, source `npm`.
- Same flows as above on port 3499: OpenCode V2 read loop `OC188-52546bf7`, continuation, Opus turn; Pi read loop `PI188-344b17f9` and continuation. No refusals.
- The owner's launchd service (port 3456) was not upgraded.

## Not established
- No notarized desktop download for 1.88.0; the CI Apple notarization credential still needs replacing.
- Live #1484 observation: Anthropic still refused one profile with "You've hit your 5-hour limit" on 2026-11-02, so the 5-hour window is still enforced on at least some accounts.
