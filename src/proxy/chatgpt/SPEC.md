---
id: chatgpt-backend
type: module-design
status: active
title: ChatGPT backend
parent: architecture
depends-on: [session, profiles-routing, telemetry-ui]
references: [api-contract]
---

## Responsibility

Serve OpenAI models from the operator's **ChatGPT subscription seats** (opt-in):
`/v1/responses` turns for OpenAI model ids and the OpenAI Images routes are
passed through to the Codex backend on one seat, with seat failover, plan/credit
policy, usage and cost telemetry. Also owns seat sign-in and renewal, the
`meridian chatgpt-migrate` and `meridian instance-import` commands, and the
read-only oc-codex usage view on the dashboard.

Code: `src/proxy/chatgpt/` (incl. `migrate/`), `src/proxy/codex/`,
`src/proxy/upstream/`, `src/proxy/instanceImport/`, `backends/chatgpt*.ts`.

## Boundary

- **Provider is decided first.** `upstream/provider.ts` (pure) maps a model to
  its provider *before* profile resolution, session lookup and transcript work,
  because all of those are Claude-shaped. `upstream/backend.ts` is the
  provider-neutral seam; it is a separate axis from `AgentAdapter` (which
  describes the client), so a Codex client can be served by Claude or ChatGPT.
- **Never enters the Claude pipeline:** no Agent SDK, adapter detection, system
  prompt, or plugin hooks, so a Claude-oriented plugin cannot rewrite a GPT
  request. Bodies are adapted only where the Codex backend requires it; the
  response streams back byte for byte. A GPT model is never answered by Claude
  (`/v1/messages` returns 404 when ChatGPT is configured).
- **Exactly one program refreshes a seat.** ChatGPT refresh tokens are
  single-use: exchanging one invalidates every other copy and breaks the account
  (`refresh_token_reused`). Hence:
  - `owned` mode holds a machine-wide **writer lease**, taken explicitly at
    startup (never in `createProxyServer`, which tests and embedders call), and
    fails rather than degrades if it cannot;
  - `follow-external` and `codex/` only **read** the oc-codex-multi-auth pool
    and never write it, its locks or the token endpoint;
  - migration *moves* refresh authority rather than copying it;
  - the `exchangeStartedAt` stamp, written before an exchange goes out and
    cleared by the commit of its result, is what stops a second exchange: the
    refresher and renewal pass refuse any stamped seat. For **listing** only,
    a stamp means "needs a sign-in" once no exchange can still clear it. The
    lease holder asks its refresher which exchanges it has out; other readers
    (`MERIDIAN_CREDENTIALS_READONLY`) treat a stamp younger than the exchange
    timeout plus 5 s as in flight, so they may lag a lost sign-in by up to
    about 20 s, and a stamp dated in the future is not trusted (#1463).
- Seats are profiles with `type: "chatgpt"` and their own active pointer; they
  never live in Claude's profile config. All additions are absent unless
  ChatGPT is enabled, and existing fields keep their meaning
  ([`api-contract`](../../../.agents/references/api-contract.md)).
- `chatgpt/migrate/` and `instanceImport/` are CLI-only — **the server never
  imports them**.
- Reuses only `session` durability primitives (durable file writes, process
  incarnation, recovery claims) — never session lineage or caches.

User-facing behavior: `docs/configuration.md` → *ChatGPT subscriptions*,
*ChatGPT migration*, *Moving ChatGPT seats between instances*.

## Known limitations

- Only the Responses and Images APIs reach ChatGPT; `/v1/chat/completions` and
  `/v1/messages` refuse a ChatGPT-served model rather than serving it.
- Cost figures use OpenAI list prices; Fast-mode requests are underestimated.
- With `MERIDIAN_CREDENTIALS_READONLY=1`, owned seats are not renewed ahead of
  expiry by this instance.
