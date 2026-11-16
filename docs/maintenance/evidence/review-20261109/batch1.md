# QA — #1489, #1491, #1492, #1497: contributor batch 1

## What changed
Renaming a profile keeps its place in the routing pool. Long hostnames and executable paths wrap on a phone instead of widening the page. Password managers are told to ignore the Profiles page's text fields. The (i) details popup on a home-page account card spans the card.

## Setup
- Tree: `origin/main` (cafdcf7) plus the five PR heads and the #1490 correction, merged locally (detached worktree `batch1`, cc501c2). Baseline: `origin/main`.
- Start: `bun run ./bin/cli.ts` under Bun 1.4.3, with isolated `HOME`, `MERIDIAN_CONFIG_DIR` and `MERIDIAN_SESSION_DIR`. Batch on port 3471, baseline on 3472.
- Data: `profiles.json` with profiles `work` and `spare`, no credentials.
- Long host: `a-very-long-meridian-instance-host.localhost`.

## Steps

| # | Action | Expected result | Status | Evidence |
|---|--------|-----------------|--------|----------|
| 1 | Baseline: `PUT /settings/api/routing` with `profileOrder: ["work","spare"]` | Saved order returned | PASS | `{"success":true}` |
| 2 | Baseline: `POST /profiles/rename` from `work` to `employer` | Rename succeeds | PASS | `"from":"work","to":"employer"` |
| 3 | Baseline: `GET /settings/api/routing` | Bug shown: `employer` is last | PASS | `'profileOrder': ['spare', 'employer']` |
| 4 | Batch: repeat steps 1 and 2 | Rename succeeds | PASS | `"from":"work","to":"employer"` |
| 5 | Batch: `GET /settings/api/routing` | `employer` stays first | PASS | `'profileOrder': ['employer', 'spare']` |
| 6 | Baseline: open `/` on the long host at 320px | Page wider than the viewport | PASS | `scrollW 426, clientW 320`, chip `w 419`, `nowrap` |
| 7 | Batch: open `/` on the long host at 320px | Page width equals the viewport, chip wraps | PASS | `scrollW 320, clientW 320`, chip `w 274, h 39`, `normal` |
| 8 | Batch: open `/` on the long host at 1280px | Chip stays on one line | PASS | chip `w 419, h 18`, `nowrap` |
| 9 | Baseline: open `/settings` at 390px | Page wider than the viewport, if the path is long enough | FAIL | Bug not present on current main. With a 113-character path, `scrollW 390, clientW 390`, `overflow-wrap: anywhere` inherited from `.setting-status` |
| 10 | Batch: open `/settings` at 390px | Page width equals the viewport | PASS | `scrollW 390, clientW 390`, code right edge 327, card right edge 366 |
| 11 | Batch: open `/profiles` and read the search box attributes | `data-lpignore`, `data-1p-ignore`, `data-bwignore`, `data-form-type` present | PASS | `lp true, p1 true, bw true, form other, ac off` |
| 12 | Batch: on `/profiles` open the rename field on a card | Same attributes, `type="text"` | PASS | `id rename-input, type text, lp true, p1 true, bw true, form other` |
| 13 | Batch: on `/profiles` open the add-profile form | Name field has the same attributes | PASS | `login-input add-input, type text, lp true, p1 true, bw true, form other` |
| 14 | Batch: on `/` at 1280px hover (i) on an account card | Popup spans the card, 6px inside each edge | PASS | Measured without hover: `left 7, right 7` from the card's outer edge (6px plus its 1px border), `w 434, card 448` |
| 15 | Batch: on `/` at 390px hover (i) | Popup inside the viewport, no sideways scroll | PASS | Measured without hover: popup `15` to `375`, `scrollW 390, clientW 390` |

## Negative / edge cases
- Renaming a profile that is not in the saved order leaves the order unchanged: PASS, saved value stayed `['spare']`.
- A real password manager extension is not installed here: NOT RUN. #1492's fill behavior was not observed, only the attributes.

## Regression checks
- Console on `/`, `/settings`, `/profiles`: only `503` resource errors, all from `/health` for the logged-out test profiles, on baseline and batch alike. No script exceptions: PASS.

## Known gotchas
- Plain `bun` on this machine is 1.3.11 and cannot open the session store; use 1.4.3.
- Step 9 means the Settings rule in #1491 is redundant on current main. It is harmless.
