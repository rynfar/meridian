---
id: profiles-routing
type: module-design
status: active
title: Profiles, auth and account routing
parent: architecture
---

## Responsibility

Own the operator's **Claude accounts** and decide which one serves a request:

- profiles — resolve, list, add, rename, switch, browser/pasted-code OAuth
  login, token refresh/health, plan and usage facts, and the cross-process
  profile config store (`profile*.ts`, `auth*.ts`, `tokenHealth.ts`,
  `tokenRefresh.ts`, `oauth*.ts`,
  `planAllowance.ts`, `credentialsMode.ts`), the account each profile is
  signed in to (`organizationName.ts`), profiles signed in to one account
  (`duplicateProfiles.ts`) and the post-sign-in re-read state
  (`profileFactsRefresh.ts`);
- routing modes (`routing.ts`): `active` (default), `sticky` (rendezvous
  hashing), `priority` (fail-over pool) and `active+priority`, plus
  follow-another-instance mode (`followActive.ts`);
- per-profile rate-limit and exhaustion tracking (`rateLimitStore.ts`,
  `limitDetection.ts`) and human-turn attestation verification for priority
  failback (`priorityAttestation.ts`).

## Boundary

- Does not import `server.ts`, `session/` or adapters. The core supplies the
  session/assignment key and performs dispatch and failover. One deliberate
  exception to the downward flow: `profileCli.ts` (the `meridian profile` CLI)
  calls `chatgpt/seatCli`, because one CLI covers Claude profiles and ChatGPT
  seats.
- Rate-limit facts are **keyed per profile**, and `profileId` is a required
  argument, so no call site can read one account's window for another. A
  profile switch clears nothing; `/auth/refresh` clears only its own profile.
- The `x-meridian-profile` pin always wins over any routing mode.
- Claude profiles never hold ChatGPT credentials (those live in
  [`chatgpt-backend`](chatgpt/SPEC.md)); routing never crosses providers.

User-facing behavior: `docs/profiles.md`. Throttling and `[1m]` bench scope:
[`architecture`](../../ARCHITECTURE.md) → *Throttling Contract*.

## Decisions

- **Automatic account switching is opt-in.** Several users explicitly do not
  want it, so the default stays `active`. `MERIDIAN_ROUTING` /
  `MERIDIAN_PROFILE_ORDER` fall back to settings; unknown ids are logged and
  unlisted profiles go last — a typo must never change routing.
- **Priority keeps cache affinity.** An existing session stays on a healthy
  account (prompt cache is per account); each profile is tried at most once per
  request; an exhausted pool surfaces the last-tried account's error; only new
  conversations drain back to a recovered preferred account
  (`priorityFailback: next-user-turn` additionally allows an attested human turn
  to fail back).
- **`active+priority`** puts the manually active profile first and the priority
  order behind it, and the active profile **outranks** an existing session
  assignment: here the head moves only because a human or supervisor moved it,
  and moving running conversations is what they moved it for. Affinity still
  applies below the active profile, so an outage costs one cold cache rather
  than one per turn.
- **Keyless affinity.** The priority assignment key is the root session id, else
  `fp:<fingerprint>`, else none. It is only an *account* key, never a session
  key, so a collision merely shares an account. Subagents use their root
  session and stay on the parent's account. Assignments are an LRU (cap 5000);
  keyed routes are additionally durable in SQLite bookkeeping.
- **Keyless forks share the parent's account on purpose.** This deliberately
  diverges from the session-resume guard, which forces keyless `fork-` /
  `subagent-` requests to replay fresh: a *session* collision would
  cross-contaminate history, while an *assignment* collision only pins two
  conversations to one account and keeps its prompt cache warm. Do not "fix"
  the two into consistency.
- **Cooldowns are layered:** Anthropic's named reset first, then the profile's
  own observed window (5-hour or 7-day, capped per window), then a 10-minute
  default. An OAuth-usage refinement may only *extend* a cooldown, runs only at
  full utilization, is not awaited, and is skipped for non-`claude-max` and
  billing refusals.
- **Account identity is Meridian's own record, re-read per credential.**
  `GET /api/oauth/profile` supplies the organization name, account and
  organization UUIDs and email; they are kept in `organizations.json` beside
  settings (never in a credential file, which Claude Code owns and rewrites),
  keyed by profile, with the stored access token's expiry they were read for.
  The page path only reads the file; a record is refreshed in the background
  when it is a day old or when the stored token changes (login, re-login,
  renewal), and a finished Meridian sign-in reads it at once. The file is
  replaced atomically (temporary file + rename, owner-only).
- **Only a record read for the current token is trusted.** The shown email
  comes from that account read in preference to `claude auth status`, whose
  cached email still names the previous account after a Meridian sign-in; a
  record read for an earlier (or unreadable) token falls back to
  `claude auth status` and contributes nothing to duplicate detection, so a
  profile re-logged into another account with `claude login` is never flagged
  from its previous account's record.
- **Duplicate detection is informational only.** `duplicateOf` /
  `duplicateBasis` on `/profiles/list` name profiles holding one account: a
  Claude account is account UUID **and** organization UUID (email **and**
  organization name only while the UUIDs are unknown); a ChatGPT seat is its
  seat id, or the same email in the same workspace; email alone never matches,
  and providers never match each other. Nothing is removed, renamed or
  excluded, and routing, cooldowns and failover treat every profile as its own
  account. Cooling down detected twins on a quota refusal was split out of
  #1446 to be proposed separately.
- **A finished sign-in reports its re-read.** Every completed sign-in marks the
  profile `factsRefresh: updating` before the route answers, re-reads account,
  usage and auth status, then clears it or reports `failed` with the reason for
  five minutes; a newer sign-in supersedes an older run, and rename/removal
  forgets it.
- **Sticky routing is stateless** (rendezvous hashing): stickiness survives
  restarts without a persisted map, and adding a profile moves only the
  sessions that hash to it.
- **The default Claude context is checked only while a request can reach it**
  (#1471). With profiles configured, `resolveProfile` never yields the implicit
  `default`, so the CLI's start-up `claude auth status` pre-flight runs only
  when no profile exists or an effective profile has no credential override of
  its own (a bare `claude-max` profile, or an `api`/`oauth-token` one without
  its key or token), and the 45 s auth keepalive refreshes the default context
  only once no profile is left (`usesDefaultAuthContext`,
  `authKeepaliveTargets`). A signed-out host login therefore neither stops nor
  warns a profiles-only instance; the active profile's sign-in state surfaces
  on `/health`, and every profile's on `/profiles/list` and in the keepalive's
  log. A profile without an override is cached under its own id, which the
  default-context refresh never served, so the keepalive skips it and requests
  refresh it.
- **Banked resets are explicit-only** (owner-approved 2026-10-26, #1429).
  `GET /v1/usage/quota/all` lists each Claude profile's grants; only
  `POST /v1/usage/quota/reset` with an explicit `profile`, `grantId` and
  `requestId` redeems one. Meridian never redeems automatically (not on a
  refusal, failover, cooldown or poll) and never retries the mutation: a reset
  spends a scarce grant, and Anthropic does not promise to deduplicate it.
- **One redemption per profile, remembered per request ID.** While a
  redemption is in flight for a profile, any other for that profile gets 409
  `reset_in_progress` with no upstream call. Once the mutation POST has been
  dispatched, its outcome — confirmed, rejected *or uncertain* — is remembered
  in memory by (profile, requestId), bounded (256 entries, oldest evicted) and
  for 15 minutes. A repeat with the same requestId and grantId replays that
  response with `replayed: true` and sends nothing; the same requestId with a
  different grantId is 409 `request_id_conflict`. Uncertain outcomes are
  reported as `indeterminate: true`, never as success or failure, and replaying
  them is the point: a blind client retry after a lost response must not spend
  a second grant. Failures before dispatch (no token, unreadable organization)
  are not remembered, since nothing was sent. A restart forgets the ledger.
- **A confirmed reset is an explicit exception to "refinement may only extend
  a cooldown" and "a profile switch clears nothing".** Only a fresh (not
  replayed) `result: "reset"` may clear local state, and only the SDK buckets
  the provider lists in `cleared`, plus spent/exhaustion marks for that same
  profile whose reported bucket was cleared and that are quota refusals within
  the expected window. Uncleared weekly/model buckets, independent overage
  state, unknown-bucket and non-quota refusals, and other profiles are
  untouched; `already_used`, other results and uncertain outcomes clear
  nothing.
- **Usage reads resolve the profile type first.** `/v1/usage/quota`,
  `/v1/usage/quota/all`, cooldown refinement and redemption run
  `resolveProfile` before touching credentials, so a profile whose type is
  inferred from `oauthToken` (or mislabelled `claude-max` with a token) reports
  type `oauth-token` / `not_oauth` instead of reading the host's on-disk OAuth
  account under its id, and `/v1/usage/quota` returns `oauth: null` for any
  non-`claude-max` target.
- **OAuth usage request identity.** Usage, identity and reset requests send
  `User-Agent: claude-cli/<version> (external, cli)`, where `<version>` is the
  `@anthropic-ai/claude-code` package installed with Meridian
  (`bundledClaudeCodeVersion`), because Anthropic gates banked-reset
  eligibility by client version (`ineligible_reason: "cli_version"`) and the
  identity should match the client Meridian actually ships. Only when that
  package cannot be read does it fall back to a pinned `2.1.304`, the client
  the cedar_ember contract was read from; bump it with that contract. The usage
  GET adds only `?cedar_ember=1` (not Claude Code's `skip_spend=1`, which would
  drop `extra_usage`); it is on every usage read because all reads share one
  per-profile snapshot cache, and it only adds the `cedar_ember` block —
  windows and `extraUsage` parse identically with or without it. The identity
  and reset requests carry no query flags.
- **Grant-selection fields are passed through, not computed.** `bankedResets`
  exposes the provider's `nextGrantId` (null unless it names a listed grant)
  and `ineligibleReason`, and per grant `startsAt`, `paused` and `usableNow`;
  malformed values become `null`. Meridian never picks a grant itself.

## Known limitations

- Exhaustion and cooldown state is in memory; a restart forgets it.
- **No failover after content streams.** A rate limit arriving after the first
  real SSE frame is relayed to the client instead of failing over —
  deliberately, so a stream the client is consuming is never yanked.
- A followed instance behind `MERIDIAN_API_KEY` always fails the follow poll
  (no credentials are sent) and the follower falls back to its local profile.
- Clients with no session identity bench `[1m]` profile-wide on a rate limit,
  because there is nothing narrower to scope it to.
