# Next backlog inventory — read-only

**Final queue retrieval:** 2026-11-05T17:22:43.455747+00:00 to 2026-11-05T17:23:03.128576+00:00.  
**Scope:** discovery only. Parent owns release #1486 and evidence draft #1500. No source/code changes, code reviews, GitHub writes, comments, issues, merges, publication, model calls or credential access. Only local evidence files were created.

## Coverage

- Authenticated account and Meridian origin both identify `rynfar`.
- **169 accessible repositories**, account pages **100 + 69**; **106 private**, **3 archived**. All names were checked, not a fixed scrub list.
- All three organizations fully enumerated: Centeva **110** repos (100 + 10), pylon-code **3**, kraken-crm **1**. Their results add no repository outside the 169-account union. The account is an admin in pylon-code and kraken-crm and a member of Centeva; repo-level permissions were retained.
- Current-main plugin documentation links were fetched at `41d7b3e3a2ead7e95e2790cc473b469bd3e9b567`; no differently owned/renamed scrub link or new scrub candidate was found. All six scoped repos have verified ownership/admin/maintain rights; none is private or archived.
- **No known inaccessible candidate or failed request.** Entirely undiscoverable repositories cannot be ruled out by GitHub. Raw paginated responses and exact read commands are retained.

| Managed queue | Open PRs | Open issues* | Default head |
|---|---:|---:|---|
| `rynfar/hudscrub` | 0 | 0 | `c4784c23a5e5` |
| `rynfar/meridian` | 30 | 18 | `41d7b3e3a2ea` |
| `rynfar/meridian-plugin-hermes-scrub` | 0 | 0 | `06bbe816d43e` |
| `rynfar/meridian-plugin-openclaw-scrub` | 0 | 0 | `82057ec65911` |
| `rynfar/meridian-plugin-opencode-scrub` | 0 | 0 | `798071b48b30` |
| `rynfar/meridian-plugin-pi-scrub` | 0 | 0 | `09c4b53a0dc0` |

*PR records returned by the issues API were excluded from issue counts.*

## Next item, only after 1.89.0 stabilizes

Propose **[Meridian #1503](https://github.com/rynfar/meridian/pull/1503)**, source **`0ae44440ec7c02d356a4b0973f9965bd48331d90`**. It is the newest non-draft contributor PR in the new grouping. No explicit hold was found in its body or paginated discussions. First refresh its head/base and current main, then read the complete diff and repository rules; **no code review or acceptance has happened here**.

Its author reports a Nov4 headerless-checkpoint correction at this head. That is a discussion lead, not independent proof. Its description explicitly leaves long production-size Opus and some fallback/checkpoint live cases unqualified. Plan affected-client/model proof later; do not infer acceptance from the reported smaller-model runs or green CI.

### New PRs, newest first

| PR | Source head | Title |
|---|---|---|
| [1503](https://github.com/rynfar/meridian/pull/1503) | 0ae44440 | feat: fork a rewritten history at its last shared turn instead of replaying it |
| [1502](https://github.com/rynfar/meridian/pull/1502) | 56b04250 | feat: make the OAuth usage cache TTL configurable |
| [1501](https://github.com/rynfar/meridian/pull/1501) | 72d22d23 | feat: release a priority assignment when its account would only fresh-replay |
| [1499](https://github.com/rynfar/meridian/pull/1499) | 2797df42 | feat: take usage figures from the followed instance, not from Anthropic |
| [1498](https://github.com/rynfar/meridian/pull/1498) | d137682f | fix(profiles): notice a plan that changed, not only one that is missing |
| [1497](https://github.com/rynfar/meridian/pull/1497) | 260e4279 | fix(landing): size the (i) details popup to its card |
| [1496](https://github.com/rynfar/meridian/pull/1496) | 358db2b0 | fix(landing): finishing a text selection on a card does not switch accounts |
| [1495](https://github.com/rynfar/meridian/pull/1495) | b6948654 | feat(profiles): filter accounts by login state |
| [1494](https://github.com/rynfar/meridian/pull/1494) | dc73c218 | feat(routing): cool down profiles signed in to the refused account |
| [1493](https://github.com/rynfar/meridian/pull/1493) | e45f4dc8 | feat(profiles): remove a Claude profile from the Profiles page |
| [1492](https://github.com/rynfar/meridian/pull/1492) | 50429b62 | fix(profiles): keep password managers out of the page's text fields |
| [1491](https://github.com/rynfar/meridian/pull/1491) | 94c2fa02 | fix(ui): let long addresses and executable paths wrap on a phone |
| [1490](https://github.com/rynfar/meridian/pull/1490) | 643d7163 | fix(auth): refresh on Anthropic's "OAuth access token has expired" wording |
| [1489](https://github.com/rynfar/meridian/pull/1489) | 6654504d | fix(profiles): a renamed profile keeps its place in the pool order |

**Specific contract gate:** #1493 implements [#1488](https://github.com/rynfar/meridian/issues/1488), whose `POST /profiles/claude/remove` contract still requests owner approval. General backlog authorization is not approval of that exact route. Do not open a competing implementation.

All 14 new non-draft heads had successful `test` and other executed check snapshots (changelog duplication skipped). GitHub returned **UNKNOWN mergeability/state**. Recheck final head/base and required CI during execution; none is declared merge-ready.

## Assumptions and preserved holds

- “New” means **created on/after 2026-11-03 00:00 UTC**, inclusive. No authoritative exact prior queue snapshot was available. This is a date grouping, not proof an item was unseen before. **No open item was created Nov4 or Nov5.** All 14 new non-draft PRs were created Nov3.
- The only new issue is **#1488**, paired with #1493. PRs come first; issues then follow newest creation time across all repos. The JSON lists all 18 issues in that order, with each prior hold or carryover note.
- **10 drafts stay held:** #1500, #1468, #1464, #1402, #1359, #1347, #1322, #1317, #1266, #1050. #1402 also has an explicit author request to test/review it before maintainer eyes. #1464 was updated Nov3 but remains a draft.
- **Five older non-draft gate holds remain:** #1400, #1399, #1396, #1340, #1314. No newer event was found and none is automatically reactivated. Older issue holds also remain; #1461 is not universally resolved by #1505 and #933 is not universally resolved by bounded fixture fixes.
- Parent-owned release #1486 changed during discovery (`7902c2fa` → `e6c56043`); all contributor heads were stable. This inventory does not interfere with the release or confer new release authority.
- The authoritative handoff was the parent-supplied evidence worktree's Nov3 document (now containing Nov5 updates), not the stale Oct26 owner-checkout copy. Its exact snapshot/hash is retained.

## Files

- `inventory.json`: normalized complete queue, exact repo/PR SHAs, source status, dates, permissions, per-item hold notes and selection order.
- `request-manifest.json`: 138 exact read requests/commands and exit status.
- `artifact-manifest.json`: raw response retrieval times and SHA256 integrity list.
- `handoff-source-snapshot.md`: authoritative handoff snapshot used for preserved holds.
- Other JSON files: raw complete GitHub responses, reviews/comments and check snapshots.

**No product constants changed.** The Nov3 cutoff is the explicit discovery assumption above. Refresh the queue after the parent's release/merges; it is a time-stamped inventory, not a promise that GitHub remains unchanged.
