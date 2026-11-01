---
id: client-integrations
type: module-design
status: active
title: Client integrations (OpenCode plugins, Pi extension)
parent: architecture
references: [api-contract]
---

## Responsibility

Code that runs **inside a client process** so Meridian receives a reliable
conversation identity and the right request shape:

- `meridian.ts` / `meridian/` — OpenCode V1 plugin: session, request and
  agent-mode headers on every Anthropic request (installed by `meridian setup`).
- `meridian-v2.ts` / `meridian-v2/` — OpenCode V2 plugin (qualified betas and stable hosts): detaches hidden
  title/summary one-shots from the visible conversation before they reach the
  proxy, enforcing identity again at the final HTTP boundary.
- `pi/` — Pi extension: registers a `meridian` provider from Meridian's model
  catalog and delegates streaming, tools and cancellation to Pi's built-in
  Anthropic implementation (installed by `meridian setup --client pi`).
- `priority-attestation.ts` — shared client-side signer for human-turn
  (priority failback) attestations.

## Boundary

- **Never imports server code.** Plugins depend only on their client SDK
  (`@opencode-ai/plugin`, `@earendil-works/pi-*`), Node built-ins and each
  other; everything reaches Meridian over HTTP headers.
- Header names, the attestation generations (`pi1` accepted only by the Pi
  adapter; OpenCode generations only by OpenCode) and `/health` plugin fields
  are public contract — see [`api-contract`](../.agents/references/api-contract.md).
  The server-side reading of these headers belongs to
  [`adapters`](../src/proxy/adapters/SPEC.md).
- Identity headers a client or stale configuration may have set are replaced,
  never trusted, so a request cannot bind to an unrelated conversation.
- OpenCode V2 attached compaction (`fork-compaction`) and Pi compaction and
  side calls (`fork-side-call`) declare a `fork-` source, never `subagent-`:
  they carry the conversation's history, so they keep its model tier. Owner
  decision 2026-10-26 (#1448). Delegated children and detached one-shots (V2
  title/summary) keep the base (200k) subagent tier.
- The Pi model catalog mirrors the server's effort list (`VALID_EFFORTS`); a
  test keeps them identical.
- Pi's `allowNetwork: false` phase is cache-only and never contacts Meridian
  (#1476), so a slow or hung Meridian cannot delay Pi's startup. Its answer is
  never empty (`cacheOnlyModels`): the catalog last discovered from the same
  Meridian URL while it is fresh; once expired, only while it still lists
  every built-in model, since a catalog that lacks one usually predates the
  Meridian version that ran setup; otherwise the built-in catalog. An
  empty answer would leave Pi with no Meridian models on a fresh install or a
  new URL: `--model meridian/…` would fail in every mode, and a
  `defaultProvider`/`defaultModel` naming a Meridian model would start Pi on
  its direct Anthropic provider, silently, whenever an Anthropic credential is
  configured.
- Discovery runs only when Pi permits network access, and only its result is
  persisted. When it fails, or lists no Claude models, the extension answers
  with the stored catalog if it is fresh (7 days); otherwise it throws, and Pi
  records the error and keeps the list its cache-only phase published.
- The built-in catalog mirrors what `/v1/models` serves without the legacy
  Opus 4.6 1M entitlement or the 1M opt-out (`buildModelList(false)`); a test
  keeps them identical. Setup installs it with the rest of the extension, so it
  describes the Meridian version that ran setup.
- `plugin/` ships in the npm package; the V1/V2 plugins are bundled into
  `dist/` by `scripts/build.ts`.

Every live OpenCode test through Meridian's Claude path uses the matching
plugin generation (see `E2E.md` → *Required Meridian OpenCode plugin
preflight*).

## Qualified hosts

Setup admits exact tested versions, not a semver range. OpenCode Desktop 2.2.0
uses the same stable provider/model domains and session hooks already supported
by the V2 bundle; it does not need a separate Desktop plugin. Qualify the app's
actual bundled CLI with `scripts/e2e-opencode-v2-stable-live.mjs`, including an
independently installed Meridian package. Its `--fixture` mode exercises client
protocol without inference; a fixture pass does not replace the live gate.
Unqualified patches and nightlies remain rejected. Provider endpoint settings
remain explicit user configuration, separate from plugin installation.
The 2.2.0 live gate closed on Darwin arm64 with the independently installed
client plugin, actual Opus 5.5 and supported public-SDK history witnesses.
Its controlled route was explicitly profile-pinned; this does not qualify
unpinned priority failback or another platform. Owner acceptance separately
covers normal Desktop use with Opus 5.5. Retain earlier failed attempts and
the exact admitted controller/results in the evidence record.

## Known limitations

- With no catalog discovered from the configured URL, the built-in catalog
  stands in until a discovery succeeds (interactive and RPC modes discover;
  print mode never does). It shows Opus 4.6 at 200k even with the legacy 1M
  entitlement, and 1M windows even under the 1M opt-out, where Meridian then
  rejects requests past 200k instead of Pi compacting first. A Meridian of
  another version at that URL (remote, or upgraded without rerunning setup)
  may serve models it lacks, or lack models it lists. In that case the
  coverage test can misjudge an expired catalog: one from a Meridian that has
  removed a model gives way to the built-in catalog, and one that still lists
  every built-in model keeps any model its Meridian has since removed. Within
  the 7 days, a fresh catalog wins even if it lacks a model an upgrade added,
  so print mode sees that model only after an interactive or RPC run or once
  the catalog expires.
- Pi updates a running session's model only when a provider is registered, not
  when a discovery publishes a new catalog. A session that started on a
  built-in or expired definition keeps it until the model is selected again
  or Pi restarts.
- The OpenCode **V1** plugin still declares compaction as a subagent
  (`plugin/meridian.ts`), so V1 compaction of an Opus/Fable `[1m]`
  conversation runs on the 200k tier. Unlike V2 it changes agent mode, which
  also changes the session key, so it needs its own fix.
