# Deferred Items

Items identified during architectural refactor planning that are intentionally deferred to separate PRs.

## Tooling & Config
1. **Biome linting/formatting** — Add with clean project-specific config (not copy-pasted). Separate PR.
2. **`src/index.ts` barrel export** — Single entry point for npm consumers. Needs backwards-compat analysis.

## Deprecation Paths
3. **`claude-max-headers.ts` plugin deprecation** — Needs migration path for users who have it configured.

## Feature Enhancements
4. **`prepareMessages` / prompt builder extraction** — Centralize Anthropic messages → text prompt conversion. Fits into adapter pattern as `preparePrompt()`.
5. **`maxTurns` configurability** — Currently hardcoded to 200. Should be configurable via env var or adapter config.
