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
  (`duplicateProfiles.ts`), the post-sign-in re-read state
  (`profileFactsRefresh.ts`) and each credential's login history
  (`authLifecycle.ts`);
- routing modes (`routing.ts`): `active` (default), `sticky` (rendezvous
  hashing), `priority` (fail-over pool) and `active+priority`, plus
  follow-another-instance mode (`followActive.ts`, with its usage figures in
  `followUsage.ts`);
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
  The one fact scoped wider is a priority exhaustion mark from a quota
  refusal, which also lands on the profiles verified at that moment to hold
  the same account (see *A quota refusal speaks for every profile signed in
  to that account*); the windows, spent records and usage snapshots behind it
  stay per profile.
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
- **A restart keeps a running conversation on its account.** The LRU lives in
  process memory, so after a restart an unattested session (Pi, Oh My Pi,
  OpenCode without its plugin) has no assignment. The account holding the most
  recently used mapping (`<profile>:<session>`) of the conversation's root or
  of the request's own key stands in for it; otherwise the conversation would
  start on the head of the order and replay its whole history there, though
  its prompt cache is warm on the old account. The root counts because a
  subagent keyed apart has no mapping on its first request, and its dispatch
  would assign the head of the order to the whole conversation. The stand-in
  only retains, like the lost assignment: a benched or removed account still
  falls through to the order, and it never grants promotion authority. A store
  read error answers 503, like the durable route lookups beside it, rather
  than guessing an account.
- **Keyless forks share the parent's account on purpose.** This deliberately
  diverges from the session-resume guard, which forces keyless `fork-` /
  `subagent-` requests to replay fresh: a *session* collision would
  cross-contaminate history, while an *assignment* collision only pins two
  conversations to one account and keeps its prompt cache warm. Do not "fix"
  the two into consistency.
- **The weekly reserve is approximate and never fetches.** A profile with a
  `weeklyReserve` percentage (`MERIDIAN_WEEKLY_RESERVE` wins over the setting)
  leaves the pool-routing candidate list once the newest observed `seven_day`
  utilization, from SDK rate-limit events or the cached OAuth snapshot, reaches
  100% minus the reserve. It adds no usage requests, because the usage endpoint
  rate-limits. A reading past its reset is ignored, so the hold lifts at the
  reset without new data; a reading with no reset counts for one hour, because
  a held profile gets no traffic that could refresh it. A profile with no
  reading is never held, and a newer reading without a utilization figure does
  not lift a hold, since it says nothing about the level. Unlike exhaustion, a
  held profile is not a last resort: when every pool member is held the request
  gets 429 with the earliest reset as a capped `Retry-After`. Retain-only work
  (no promotion authority) keeps its route even while held, because the
  alternative is failing it. Cache-keepalive beats skip held profiles. Pins and
  the `active` / `sticky` modes ignore the reserve. Invalid values and reserves
  naming no profile are logged once and ignored.
- **Extra Usage is a last resort under pool routing** (`claudeExtraUsage` /
  `MERIDIAN_CLAUDE_EXTRA_USAGE`, default `reserve`). An account whose next
  turn would be paid with Extra Usage moves behind every account with plan
  allowance and is no home for an existing assignment, so a conversation on
  it moves on its next turn; when no account with plan allowance can take
  work, the pool keeps its order. The evidence is already observed, never
  fetched (the usage endpoint rate-limits): the newest of the SDK's
  `isUsingOverage` from an account-wide bucket (`five_hour`, `seven_day`,
  `default`, `overage`; a per-model bucket such as `seven_day_opus` says
  nothing about other models, as in #1524) and a cached OAuth snapshot whose
  `five_hour` or `seven_day` window is at 100%. `extraUsage.isEnabled` is not
  consulted: Team seats can report it off while organisation overage serves
  them (#1347). A reading past its reset, or one with no reset older than an
  hour, says nothing. `never` drops such accounts and answers 429 with the
  earliest plan reset as `Retry-After` when none is left; it is not a spend
  cap, because evidence arrives only after a paid turn and retain-only work
  still runs on the account. `immediately` changes nothing. Retain-only
  work keeps its route, as with the weekly reserve. Cache-keepalive beats
  skip such accounts under every mode. The three words match the ChatGPT
  Codex credits policy.
- **Cooldowns are layered:** Anthropic's named reset first, then the profile's
  own observed window (5-hour or 7-day, capped per window), then a 10-minute
  default. An OAuth-usage refinement may only *extend* a cooldown, runs only at
  full utilization, is not awaited, and is skipped for non-`claude-max` and
  billing refusals.
- **A per-model weekly refusal benches only that model.** When Anthropic
  names a per-model weekly bucket (`seven_day_opus`, `seven_day_sonnet`,
  `seven_day_fable`) for a refused request of that same model family, pool
  routing skips the profile only for requests of that family (the tier
  `mapModelToClaudeModel` sends the request to; Mythos is fable), until that
  bucket's named reset, else its own exhausted window, capped like `seven_day`,
  else the 10-minute default. Other models keep using the profile. An inferred
  (`cached_usage`) bucket, an unknown one, or one naming another family keeps
  the profile-wide bench: a wrong per-model guess would keep sending every
  other request into an account that refuses them all. A confirmed reset that
  clears the bucket lifts its model bench. `/profiles/list` (pool modes) and
  `/profiles/health` list these as `exhaustedModels`
  (`{id, modelFamily, until, reason}`); `exhausted` keeps profile-wide marks
  only. The `spent` record (`/v1/usage/quota/all`, `/profiles/list`,
  `/profiles/health`) keeps its fields and adds `modelFamily`
  (`"opus" | "sonnet" | "fable" | null`): non-null exactly when this refusal
  took the per-model path, so the profile is benched for that family alone.
  `diagnosis.bucket` cannot say that on its own, because a rejected SDK event
  from an earlier refusal can name a bucket this refusal was not benched for.
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
- **Login history is Meridian's own record, per credential.**
  `auth-lifecycle.json` beside settings (Claude Code owns and wipes the
  credential file) keeps, keyed by the credential store's `refreshKey`: when
  the current grant was obtained and whether Meridian performed the login
  (`login`) or found it on disk (`observed`, timed when noticed), Meridian's
  last renewal of that grant, the last deadline seen, a truncated SHA-256 of
  the refresh token (never the token), and when and why authentication was
  first found failing. A rename that moves the credential directory moves
  the record, and removing a profile deletes the records of the credential
  directories it removed. Every transition is logged and stored in
  diagnostics under `auth`.
- **Writers serialize across processes.** The server and
  `meridian profile login` both write the file. Each update reads, applies
  and publishes under one exclusive lock file (`lockedFile.ts`, shared with
  `profileConfigStore.ts`), so no transition is overwritten by a stale copy.
  A file that cannot be parsed is never replaced, and a held or failed lock
  leaves the file as it was. Reads for display take no lock.
- **The history never holds up a request.** Token refreshes and
  `/profiles/list` queue their history writes in the background, one at a
  time, and never await them; `/profiles/list` shows the record the
  observation leads to before it is written. A lock left behind by an
  interrupted writer therefore costs only skipped history entries, never a
  slower refresh or page. Only `meridian profile login`, a rename and a
  removal wait for the lock.
- **Only a grant rejection is a logout.** A refresh answered with RFC 6749
  `invalid_grant` is `refresh_rejected`, and only when a successful re-read
  shows the refused refresh token is still the stored one, twice, 750 ms
  apart (another Claude Code process may have just rotated it). Other OAuth
  errors, statuses without that code, outages and unreadable stores record
  nothing: unknown stays unknown. A credential read successfully with no
  access token is `credentials_cleared`.
- **A new grant replaces the record.** The refresh token identifies the
  grant: a different one with a different deadline, nearer or later, is a
  new login (`new_grant`, `observed`); with the same deadline it is the same
  grant rotated elsewhere; where either side's token or deadline is unknown
  and what is known differs, the record keeps no login time
  (`credential_replaced`) rather than a wrong one. A new grant or a Meridian
  login drops the previous grant's renewal time, deadline and logout.
- **A refused renewal still serves.** Its access token keeps working until it
  expires, so until then `/profiles/list` keeps `loggedIn` and the card says
  "Renewal refused, stops in …" next to the access-token countdown. Only
  after that expiry, or for a cleared credential, is the account logged out
  (`loggedIn: false`, "Logged out … ago").
- **Duplicate badges are informational.** `duplicateOf` /
  `duplicateBasis` on `/profiles/list` name profiles holding one account: a
  Claude account is account UUID **and** organization UUID (email **and**
  organization name only while the UUIDs are unknown); a ChatGPT seat is its
  seat id, or the same email in the same workspace; email alone never matches,
  and providers never match each other. Nothing is removed, renamed or
  excluded because of a badge.
- **A quota refusal speaks for every profile signed in to that account.**
  Profiles holding one Claude account hold one quota, so under pool routing a
  quota refusal on one marks every other such profile exhausted until the same
  reset (and the OAuth-usage refinement extends them with it), and the
  request's remaining candidates skip them instead of spending an attempt each
  to hear the same answer. The proof is stricter than the badge's: the account
  UUID **and** organization UUID only, never email and organization name, and
  only from records read for the access token each profile stores at the
  moment of the refusal, the refused profile's own included
  (`organizationRecordCurrent`). A profile re-logged into another account with
  `claude login` still carries its previous account's record until the
  background re-read lands, and benching it on that record would park a
  healthy account until someone else's reset. Credentials are read only for
  profiles whose saved record already names the refused account, so a fleet
  without twins pays no read. A failed lookup benches no one beyond the
  refused profile. Billing and other refusals stay per profile: only a quota
  refusal carries a reset that is the account's own.
  A per-model weekly refusal benches each such profile for that model family
  only, the same way it benches the refused profile.
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
- **A follower reads usage from the instance it follows.** Under
  `MERIDIAN_FOLLOW_ACTIVE`, unforced usage reads serve the followed
  instance's `/v1/usage/quota/all` figures (matched by profile id, polled every
  two minutes, marked `stale` after five, withdrawn after ten) and make no
  Anthropic call. Forced reads, and profiles the followed instance could not
  read, use this instance's own credentials; a forced read newer than the
  followed copy is not replaced by it.
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
- **Extra Usage amounts are served in major units.** The usage endpoint's
  `extra_usage.monthly_limit` / `used_credits` are minor units (cents):
  claude.ai's admin API reports the same member's limit as
  `{amount_minor: 500, exponent: 2}` where this endpoint says `500`.
  `extraUsage.monthlyLimit` / `usedCredits` are divided by
  `10^decimal_places` (2 when absent) and carry that as `exponent`, whose
  presence tells a consumer the amounts are dollars; a followed instance or
  service without it still serves cents and is converted. Used may exceed the
  limit (a turn that starts under it can finish past it), and Anthropic clamps
  `utilization` at 100, so displays take the share from the amounts and show
  the overshoot.
- **Grant-selection fields are passed through, not computed.** `bankedResets`
  exposes the provider's `nextGrantId` (null unless it names a listed grant)
  and `ineligibleReason`, and per grant `startsAt`, `paused` and `usableNow`;
  malformed values become `null`. Meridian never picks a grant itself.

### Banked reset scope

- `kind: "full"` means the provider lists `seven_day` in `clears`. For example, `full-reset-2611` has `type: "weekly"` and clears `seven_day` and `seven_day_overage_included`. A Team grant with `type: "full"` also counts as full if it clears `seven_day`; the raw type does not determine scope.
- `kind: "fable"` identifies the known Fable launch grants (`launch-2610-fable`, `launch-2610-fable-6mo`, `launch-2610-fable-12mo`) when `clears` contains `seven_day_overage_included` and no other window except optional `five_hour`, and `gives_back_weekly` is not explicitly false. Personal grants have been observed clearing only the former; Team grants clear both. The observed grants have `type: "full"` and `gives_back_weekly: true`. Order and repeated window IDs do not affect classification or change the reported `clears`. Other grant IDs do not become Fable grants just because they share these windows and flags.
- If `clears` is absent or null, those exact IDs are a fallback when `gives_back_weekly` does not contradict the known scope. An explicit empty or different list, or an unreadable list, does not trigger that fallback. If no rule identifies the scope, `kind` is `"unknown"` and the provider's ID, type and label remain available.
- `providerType`, `clears`, `givesBackWeekly`, `description` and `percentUsed` preserve the corresponding readable provider metadata. `description` is the provider's `label`, not a scope rule. `percentUsed` keeps finite numeric values from 0 through 100 inclusive, including `seven_day_overage_included` and unfamiliar window IDs, without rescaling or coercing them. These fields describe the inventory only; 0% does not override the provider's `usableNow` flag.

## Known limitations

- A refresh token rotated by another process and given a new deadline in the
  same rotation reads as a new login found on disk. Rotations measured so
  far keep the deadline.
- A refresh Claude Code performs itself is not a Meridian renewal, so it
  never sets `lastRefreshAt`.
- Exhaustion and cooldown state is in memory; a restart forgets it.
- A twin benched by a shared-quota refusal and then signed in to another
  account with `claude login` stays benched until that reset, exactly as the
  refused profile itself would; a Meridian sign-in or `/auth/refresh` clears
  it.
- A twin whose access token was renewed after its account was last read is not
  recognized until that record is read again, which happens when something
  polls `/profiles/list` (any open Meridian page does). On an instance with no
  page open, the busy twin has usually renewed, so the request still tries it
  once and hears the same refusal, as it did before.
- **No failover after content streams.** A rate limit arriving after the first
  real SSE frame is relayed to the client instead of failing over —
  deliberately, so a stream the client is consuming is never yanked.
- A followed instance behind `MERIDIAN_API_KEY` always fails the follow poll
  (no credentials are sent) and the follower falls back to its local profile.
- Clients with no session identity bench `[1m]` profile-wide on a rate limit,
  because there is nothing narrower to scope it to.
