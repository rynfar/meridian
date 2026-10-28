# Release 1.87.0 — candidate validation (2026-10-27/28)

Owner-authorized 2026-10-27 ("once #1463 is merged … cut a release", scope: #1463 + #1193 + bot PRs #1462/#1459).

## Candidate
- Release Please #1457, head `d6116af6ab2a66e78daf96139ee37d855260823d`, directly on `main` `253457540`. Diff from main: `.release-please-manifest.json`, `package.json`, `package-lock.json` (1.86.0 → 1.87.0) and `CHANGELOG.md` only.
- Contents since 1.86.0: #1445, #1429, #1193, #1446 (features); #1456, #1463, #1261, #1458, #1410, #1443 (fixes); #1444 (perf); plus #1455 (spec graph docs), #1459 (Nix scrub pins), #1462 (OpenAI pricing). Each PR was adversarially reviewed and live/headless-tested before merge (see each PR).
- Candidate workflows were waiting for approval and were approved. All succeeded: CI (incl. `test`, smoke, windows-smoke), Docker, desktop, Nix installable builds, Nix node_modules hash, claude-code availability.

## Local gates on the candidate
- Darwin arm64, Bun 1.3.14, Node 24.20.0, Homebrew SQLite 3.53.4 via `MERIDIAN_TEST_SQLITE_LIBRARY` (`scripts/run-test-groups.sh`).
- All 26 `npm test` groups ran: 8,467 pass, 65 skip, 6 fail (group 01). Four are real-Node-child SQLite tests (`bookkeeping-lifecycle-deletion` ×3, `bookkeeping-lifecycle-publication` ×1) that fail identically on unchanged `main` 253457540 (re-run side by side: 89 pass / 4 fail on both). The other two (`integration` concurrent headerless publication, `bookkeeping-cli` migrate→export ×50) pass in isolation on the candidate — load-timing under the full run; CI `test` passed.
- `npm pack`: `rynfar-meridian-1.87.0.tgz`, sha256 `fc39f2b541e6ed41ef8d48db53dad73afa417eefd90093a978a432ce3c23ef49`, 728 files; new files vs 1.86.0 are only this release's modules. No `transcriptSweep` in `dist`.

## Packed-package validation (installed tarball, isolated prefix, port 3497, read-only owner credentials, personal Max)
- `/health` → 1.87.0 healthy. Defaults: transcript retention off (`days 0, source default`); update check off with `plugins[]` listing opencode-scrub 0.3.0 and pi-scrub 0.2.3 (no registry traffic); cache keepalive 0 beats.
- OpenCode 1.18.34 with the package's V1 plugin (`setup --v1`; installed plugin sha256 = tarball's) + opencode-scrub 0.3.0 (fresh npm): Sonnet 5.5 read-tool loop returned the fixture marker `REL187-ca39178b`; `opencode run --session` continuation resumed (`lineage=continuation`) and repeated it.
- Pi 1.4.0 with the package's extension (`setup --client pi`, disposable agent dir) + pi-scrub 0.2.3: Haiku 5.5 read-tool loop returned `PI187-03bc9e8c`; `pi -c` continued (`lineage=continuation`).
- Opus 5.5 primary turn via OpenCode routed to `opus[1m]` and answered.
- Both scrubs active with 0 errors. No refusal, 402, billing_error or "extra usage" text.
- The validation worker was interrupted by a rate limit after packing and the test run; the client flows above were run by the maintainer on the same installed instance.

## Publication
- Merged #1457 with `--merge --match-head-commit d6116af6a`: `94725800af58015daae796be04034ae03d2fec73`.
- [Release workflow run 40621487880](https://github.com/rynfar/meridian/actions/runs/40621487880): `release-please`, `publish`, `docker` succeeded; `desktop / mac` failed at notarization with HTTP 401 `Unauthenticated` (same rejected Apple API credential as 1.85.0/1.86.0). All other workflows on the merge commit succeeded.
- Tag `meridian-v1.87.0` → `9472580`. [GitHub release](https://github.com/rynfar/meridian/releases/tag/meridian-v1.87.0) (no assets) with upgrade notes added for #1261, #1193, #1445, #1429 and the missing desktop download.
- npm `@rynfar/meridian@1.87.0`, dist-tag `latest`, `gitHead` `9472580`, integrity `sha512-f8/X3oC+cZalBxL6rGCvPECYd1T73bkoNI6aQjkonq8VKWWDzoaVGUnOxGGYQdhyolEjTwVc1VJAwkKHKsZr6w==`, SLSA provenance v1. Registry tarball sha256 `94359105…8bbd` (differs from the local pack only by publishing npm version).
- Docker `ghcr.io/rynfar/meridian:1.87.0` and `:1.87`, digest `sha256:2485d29b19b4cd40a4525c1570bdaab1e822c80e1c9bc3dc0d74bdc0f75ba255`, linux/amd64 and linux/arm64.

## Fresh registry install
- `npm install -g --prefix <tmp> @rynfar/meridian@1.87.0`; downloaded tarball sha512 matches the published integrity. `/health` → healthy 1.87.0 `source: npm`.
- Real OpenCode 1.18.34 with the registry package's V1 plugin (`setup --v1`) + opencode-scrub 0.3.0: Sonnet 5.5 read-tool loop returned `REG187-0bf7a0d0`; scrub 3 invocations, 0 errors.
- The owner's own launchd service (port 3456) was not upgraded.

## Not established
- No notarized desktop download for 1.87.0; the CI Apple notarization credential still needs replacing.
