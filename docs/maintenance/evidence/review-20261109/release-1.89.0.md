# Release 1.89.0

Authorized by the owner on 2026-11-09. Release Please PR [#1486](https://github.com/rynfar/meridian/pull/1486).

## Candidate

- Head `3981573609fefec9ee869408fa8e72baaf3db0c0`, parent `89fab76f` (#1514). Diff: `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, `package.json` only.
- `main` was one commit ahead at merge (`936e8dfc`, #1515, documentation only).
- Candidate CI had been held as `action_required` because the bot created the branch. Approved by the maintainer, then all 13 checks passed: CI [42711088494](https://github.com/rynfar/meridian/actions/runs/42711088494), Docker [42711088637](https://github.com/rynfar/meridian/actions/runs/42711088637), desktop [42711088392](https://github.com/rynfar/meridian/actions/runs/42711088392), Nix [42711088331](https://github.com/rynfar/meridian/actions/runs/42711088331), Nix hash [42711088347](https://github.com/rynfar/meridian/actions/runs/42711088347), floor manifests [42711088636](https://github.com/rynfar/meridian/actions/runs/42711088636).

## Local gates on the candidate

Bun 1.4.3, Node 22.23.4, isolated `HOME`. Install, build, typecheck and `npm pack` passed. The packed tarball (`rynfar-meridian-1.89.0.tgz`) installed into an empty project and its `claude` reported 2.1.321.

The test chain was run segment by segment (29 segments). First run: 1 segment failed with 3 tests:
- `proxy-client-abort-resume` "after the session-turn watchdog", the known flake.
- `bookkeeping-server` "a resumed turn refused by a held writer lock leaves the conversation retryable": the retry got 503 `Session bookkeeping is unavailable`.
- `store-mutation-baseline` "matches actual legacy mutation durability/order": extra `link:data->data` / `unlink:data` events in the trace.

The two new ones passed 10 of 10 run alone. That segment was rerun in full: 8,316 pass, 0 fail. The first run took 2,095 s against 1,636 s for the rerun, so load is the likely cause. Neither failure appeared in the earlier batch runs. Treat both as load-sensitive until they reproduce.

## Live gate on the candidate

OpenCode 1.18.34, the packed Meridian's V1 plugin installed with `meridian setup --v1` into a disposable `HOME`/XDG/project, and `@rynfar/meridian-plugin-opencode-scrub` 0.3.0 listed active on `/plugins/list`. The resolved OpenCode config had exactly one Meridian `plugin` entry, pointing at the installed package. Credentials read-only (`MERIDIAN_CREDENTIALS_READONLY=1`), Max account. Requests went through a header-recording relay.

| Request | Status | Model | Stop | Plugin headers |
|---|---|---|---|---|
| title | 200 | claude-haiku-5-5 | end_turn | session, agent `title` (subagent) |
| turn 1 | 200 | claude-opus-5-5 | tool_use (`read note.txt`) | session, agent `build`, `x-meridian-opencode-turn` present |
| turn 1 after the tool result | 200 | claude-opus-5-5 | end_turn, token returned | same |
| turn 2 (`--session`) | 200 | claude-opus-5-5 | end_turn, token repeated without tools | same, proxy `lineage=continuation` |

Harness note: the first attempt sent no request at all. `opencode run` waited on stdin, and the scrub manifest was not in the `{"plugins":[...]}` form. Both were fixed before any model call.

## Merge and publication

- Merged `--merge --match-head-commit` as `8f5e705a72a928be910e4c234c6b75fc289c068d` at 2026-11-10T01:12:46Z.
- Release Please [42734138770](https://github.com/rynfar/meridian/actions/runs/42734138770): `release-please`, `publish` and `docker` passed. `desktop / mac` failed at notarization with `HTTP status code: 401. Unauthenticated`, as it did for 1.87.0 and 1.88.0. The Apple credentials in the repository secrets need renewing. The GitHub release has no desktop assets.
- Tag `meridian-v1.89.0` → `8f5e705a`. GitHub release published 2026-11-10T01:12:59Z.
- npm: `1.89.0` is `latest`, `gitHead` `8f5e705a`, integrity `sha512-hA/L6zxM89nIaRPJ/wchLaULOOsAYG0MjNUhszPX3jjjfQaPPlI0yCvKIiJDJzA0/q51k2ky6FnVlsaN4aCPgw==`, SLSA v1 provenance attestation present.
- Docker: `ghcr.io/rynfar/meridian:1.89.0` index `sha256:cb019085…` with linux/amd64 and linux/arm64. The `latest` push ([42734139014](https://github.com/rynfar/meridian/actions/runs/42734139014)) passed. Two earlier `main` pushes that day failed with `denied: permission_denied: write_package` (`74d1365`, `89fab76`), and the pushes on either side passed. The cause is unknown.
- Changelog: Release Please could not parse the merge commit of #1220 (`41d7b3e`), so the 1.89.0 notes do not name #1220.

## Published package

A fresh `npm install @rynfar/meridian@1.89.0` resolved the same integrity. Its `claude` reported 2.1.322. The same live flow passed on it: title on Haiku 5.5, then three Opus 5.5 requests (tool_use, end_turn, end_turn), all 200 with plugin headers and the turn header, the token returned and repeated on the continued session, and the scrub active.

The published image was run with no account logged in. `/health` returned 503 (`loggedIn: false`), `/livez` returned 200, and Docker reported the container `healthy` over four consecutive checks with no restarts. #1472 was closed with that evidence.
