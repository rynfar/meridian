---
id: plugins
type: module-design
status: active
title: User plugins
parent: architecture
depends-on: [adapters, telemetry-ui]
references: [api-contract]
---

## Responsibility

Let operators customize Claude request behavior and observe session decisions
**without changing core code**: discover, validate, load and reload user
`Transform` plugins, keep per-plugin stats, and render the read-only `/plugins`
page.

Motivation: feature toggles proposed for single clients (e.g. moving the system
prompt into the first user message) kept growing `server.ts`; such
customizations belong in user space, outside the release cycle.

Code: `src/proxy/plugins/`. The `Transform` interface and pipeline runner live
in `transform.ts`, owned by [`adapters`](../adapters/SPEC.md).

## Boundary

- **Pipeline order:** the adapter's built-in transforms first, then plugins in
  `plugins.json` order. Plugins declare no priority numbers; the user owns order.
- **Scoping:** `adapters: [...]` limits a plugin to named adapters (omitted =
  all); unknown names warn, duplicate plugin names are skipped.
- **Failure isolation:** a hook returns a new context; a throwing hook is
  logged and the previous context continues — a plugin never crashes the proxy.
- **Discovery:** files in the config `plugins/` directory plus absolute paths
  in `plugins.json`; unlisted files are appended and enabled; both resolve
  through the relocatable config path. `POST /plugins/reload` reloads.
- **Resume correctness stays in core:** `onSession` runs after lineage
  classification and its return value is ignored. Plugin changes to messages
  affect SDK execution but never the lineage proof (see
  [`session`](../session/SPEC.md)).
- **Claude path only.** ChatGPT requests never enter plugin hooks, and
  Antigravity has its own separate plugin/observer interface.
- The `Transform` type and plugin configuration are public contract
  ([`api-contract`](../../../.agents/references/api-contract.md)).
- **Update check (`../pluginUpdateCheck.ts`).** Each loaded plugin's nearest
  `package.json` (never at or above the plugin directory or the home
  directory) is read for its name, version, `private` and
  `publishConfig.registry`; a manifest that is not a JSON object makes the
  plugin not checkable instead of failing a load or reload. Package names go
  to a registry **only while the `checkForUpdates` check is on** — the same
  toggle as Meridian's own check, owner-approved with the `plugins[]` field of
  `/settings/api/updates` (#1445). They go only to the registry the operator
  chose: `MERIDIAN_UPDATE_CHECK_REGISTRY`, else npmjs — but when
  `MERIDIAN_UPDATE_CHECK_URL` alone routes Meridian's check to a mirror, no
  plugin is checked, because a registry cannot be derived from that URL and
  the public one is what the operator routed around. A package whose
  `publishConfig.registry` names a registry other than public npm and the
  one being asked is not checkable (its name may be internal); packages
  published to public npm are checked through a configured mirror.
  A pass runs at most four lookups at once under one deadline equal to a
  single fetch timeout, so switching the check on answers in about one
  timeout; only one pass runs at a time, a request during it queues one
  follow-up pass, and switching off cancels the pass in flight without
  recording the cancelled lookups.

Author guide: `PLUGINS.md`; official packages: `docs/plugins.md`.

## Known limitations

- **Response hooks are not wired.** `onResponse` and `onTelemetry` types exist,
  but the Claude HTTP path does not call them; `onToolUse`, `onToolResult` and
  `onError` are reserved.
- **The `/plugins` UI is read-only** (list + reload); enabling, disabling and
  reordering require editing `plugins.json`.
- Under Node (npm installs) plugins must be compiled `.js`; `.ts` works only
  when Meridian runs under Bun.
- **Not every plugin is update-checkable.** A lone file in `plugins/`, a
  symlink placed there (the path is not resolved, so the search stops at the
  plugin directory), a plugin pinned in the Nix store without its
  `package.json`, a private package, and a package published to another
  registry are listed as not checkable, with the reason.
- **The tracked plugin list is process-wide.** `pluginUpdateCheck.ts` keeps
  one list for the process (as `updateCheck.ts` keeps one version), set by
  whichever server last loaded or reloaded plugins; embedders running several
  proxy instances in one process see the last instance's plugins in every
  `/settings/api/updates`. `stopUpdateCheck()` forgets the list (shutdown,
  tests); a server that keeps serving tracks its plugins again.
