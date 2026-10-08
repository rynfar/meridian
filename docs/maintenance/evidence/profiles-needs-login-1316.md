# Profiles needs-login display proof — 2026-10-08

Source [#1316](https://github.com/rynfar/meridian/pull/1316) by Nowaker
<spam@nowaker.net>, `67c78683696712f7db714cbc5bb529bde8f5dfc3`, is preserved
as authored cherry-pick `b4d8095e2fb998396d4e3a217547888477b23199` on
`458cf15c59dc5ff99f50bf4dea4a002ff44b947f`. AuthorDate is
2026-10-08T19:13:59Z. No maintainer code correction was needed.

## Actual browser display gate

T3 collaborative HeadlessChrome 154.0.8037.92 executed the real baseline and
candidate `profilePageHtml` scripts with owned synthetic public HTTP roster and
quota responses. E2E.md permits these display gates without model generation.
There is no inference, OAuth, native-store or login-completion acceptance claim.

| Assertion | Baseline 458cf15c | Candidate b4d8095e |
| --- | --- | --- |
| Explicit logged-out card | Missing badge/red border | Badge and solid red border |
| Logged-in card with no_token quota | Missing badge/red border | Badge and solid red border |
| Active logged-out card | Blue border only | Red border and blue 1px outer ring |
| Healthy / API not_oauth | No needs-login flag | No needs-login flag |
| 1280 / 375 CSS-pixel page overflow | None | None |
| Paired card widths | 752 / 327 px | 752 / 327 px |
| Refresh after synthetic recovery | — | Both warnings removed |
| Fresh quota endpoint unavailable | — | Explicit logged-out card still flagged; authenticated card unflagged |

A 320px candidate control retained both warning badges without horizontal page
overflow. Saved desktop/mobile images were inspected: badges wrap, active ring
remains visible, and existing controls remain within the cards. Media contains
only synthetic example.invalid profile data. Static display needs before/after
images; no timing behavior requires video.

The supplement is retained at
`/Users/rynfar/repos/meridian-review-evidence-20261006/resumption-20261008-round1/profiles1316`:
`serve.mjs`, `BROWSER_RECEIPT.json`, `MEDIA_IDENTITY.json`, four before/after PNGs,
`REVIEW.md`, and final-gate command/result/log identities. The exact gate executes
Bun 1.3.11 `serve.mjs` against the indicated source trees, opens
`/baseline/profiles` and `/candidate/profiles` in T3 preview, and checks DOM badges,
computed border/ring colors, viewport/card geometry and refresh controls. Unexpected
HTTP endpoints are refused; real profile and provider boundaries are never used.

## Review and validation

Root adversarial review inspected all six source/test changes, shared predicate
parity with Home, prototype-safe quota lookup, missing quota and API-key controls,
active styling, shared tokens/header, and source tests. No material finding
survived. This is root review, not a delegated independent review. Focused tests:
68 pass, zero fail, 291 assertions. At exact code head `b4d8095e`, `npm test` under Bun 1.3.11 completed with 5,478 pass, zero fail and 35 skip; standalone typecheck and build exit zero. All 1,012 selected tracked rows retain before/after identity. Joined command/log receipts are independently rehashed. The later maintainer commit changes only this proof and the review handoff; required final-head CI still applies.

Only the display defect is accepted. Authentication, renewal, expired-login,
model/client/platform issues remain separate; no broader issue is closed.
Required exact final-head CI remains a merge gate. Release is not authorized here.

Media remains in the durable local evidence packet; no public image upload was available. The PR includes the assertions and review record, not a claim that GitHub hosts those PNGs.
