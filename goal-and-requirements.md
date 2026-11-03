---
id: meridian
type: goal-and-requirements
status: active
title: Meridian — goal and requirements
---

## Goal

Let a developer run the coding clients they already use — Pi, OpenCode, Claude
Code, Codex, Crush, Droid and other Anthropic- or OpenAI-compatible clients —
against **their own provider subscriptions**, through one local API, with the
session continuity, prompt-cache reuse and usage visibility those clients would
otherwise lose.

## Problem

Subscription plans (Claude Max/Pro, Antigravity, ChatGPT) are consumed through
each vendor's own tooling, not a raw API key. Third-party coding clients speak
the Anthropic Messages or OpenAI APIs and resend full conversation history each
turn. Bridging the two naively loses session state, cold-caches every turn,
mixes accounts, and gives no view of usage or failures.

## Audience

A single operator — typically one developer — running Meridian locally, headless (Docker, Nix,
launchd/systemd), or through the optional Mac app, with one or more of their own
signed-in accounts. Downstream plugin authors and embedders consume its public
contract ([`api-contract`](.agents/references/api-contract.md)).

## Capabilities

- **Claude backend (default, released):** Anthropic Messages, OpenAI Chat
  Completions and OpenAI Responses served through the Claude Agent SDK, with
  persistent sessions (continuation, compaction, undo, divergence), cross-process
  session resume and prompt-cache-preserving replay.
- **Antigravity backend (preview):** the same client APIs served through the
  official, signed-in `agy` CLI, with client tools, warm conversation reuse and
  bounded saved-answer recovery. Runs standalone or mounted beside Claude
  (`backend: "combined"`).
- **ChatGPT backend (opt-in):** GPT models served from ChatGPT subscription seats
  on `/v1/responses` and image routes, off unless configured. Meridian either owns
  the seat store or follows an external one read-only.
- **Client adaptation:** automatic client detection and per-client adapters for
  session identity, working directory, tool mapping and transforms.
- **Accounts:** multiple Claude profiles with manual, sticky or priority
  (fail-over) routing, browser login and per-request profile selection.
- **Extensibility:** user plugins that transform requests and observe session
  decisions without changing core code.
- **Visibility:** telemetry dashboard, request/log history, quota and cost
  views, provider status, Prometheus metrics and opt-in crash reporting.
- **Client setup:** `meridian setup` installs the OpenCode and Pi integrations;
  migration commands move ChatGPT seats and instances.
- **Desktop (preview):** optional macOS app that manages the service, versions,
  plugins and notifications over the existing HTTP API.

## Non-goals

- **No automatic paid-API fallback.** Generation goes through the operator's
  signed-in subscription tooling (Agent SDK, `agy`, ChatGPT seats); Meridian
  never falls back to an API key or a provider model SDK on its own. An
  explicitly configured `apiKey` Claude profile is the operator's opt-in and
  still runs through the Agent SDK.
- **Not a hosted multi-tenant service.** Meridian serves one operator's own
  accounts; it is not a shared or resold gateway.
- **No exactly-once client-tool execution.** Recovery is bounded replay of saved
  answers and consumed tool IDs; Meridian never promises a client tool ran
  exactly once or that an active task can be reattached.
- **No simulated provider controls.** A control the provider's CLI/SDK does not
  expose (e.g. an exact output-token cap on Antigravity) is rejected or clearly
  labeled, never faked.

## Principles

- **Providers stay isolated.** Claude account routing, sessions and caches never
  leak into Antigravity or ChatGPT paths, and vice versa; account identities and
  quotas are reported separately.
- **Client-specific behavior lives in adapters**, not spread through the core.
- **Risky or costly behavior is opt-in.** Automatic account switching, native
  browser/subagent grants, the ChatGPT backend, update checks and crash
  reporting are off by default.
- **Honest bounds.** When Meridian cannot prove state (a session prefix, a
  recovery), it replays or refuses rather than guessing.
- **The public contract is owner-approved.** Changes follow
  [`api-contract`](.agents/references/api-contract.md).
- **Real-flow evidence.** A behavior change is accepted only with live E2E
  through the actual affected client, model and platform (`E2E.md`).
