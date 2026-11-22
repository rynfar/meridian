# Deferred Items

Items identified during architectural refactor planning that are intentionally deferred to separate PRs.

## Tooling & Config
1. **Biome linting/formatting** — Add with clean project-specific config (not copy-pasted). Separate PR.
2. **Dependency classification fix** — Move `hono`, `@hono/node-server` from devDeps to production deps.
3. **Docker directory reorganization** — Move Docker files to `docker/`. Needs migration docs.
4. **`src/index.ts` barrel export** — Single entry point for npm consumers. Needs backwards-compat analysis.

## Deprecation Paths
5. **`bin/oc.sh` deprecation** — Evaluate whether to deprecate. Needs user communication first.
6. **`claude-max-headers.ts` plugin deprecation** — Needs migration path for users who have it configured.

## Feature Enhancements
7. **`prepareMessages` / prompt builder extraction** — Centralize Anthropic messages → text prompt conversion. Fits into adapter pattern as `preparePrompt()`.
8. **Native-mode `maxTurns` configurability** — Native (non-passthrough) SDK mode still hardcodes 200. Passthrough already computes its own budget (`computePassthroughMaxTurns` in `query.ts`: 1 by default, lifted for deferred tools, advisors, structured output or the early-stop kill switch) and can be pinned with `MERIDIAN_PASSTHROUGH_MAX_TURNS`. Native mode should get an equivalent env var or adapter config.
