# Deferred Items

Items identified during architectural refactor planning that are intentionally deferred.

## Tooling & Config
1. **Biome linting/formatting** — Add with clean project-specific config (not copy-pasted).

## Deprecation Paths
2. **`claude-max-headers.ts` plugin deprecation** — Needs migration path for users who have it configured.

## Feature Enhancements
3. **`maxTurns` configurability** — Currently hardcoded to 200. Should be configurable via env var or adapter config.
4. **Stream writer extraction** — The SSE streaming path in `server.ts` (~400 lines) could be extracted to `streamWriter.ts`. High risk due to intricate state management (`skipBlockIndices`, `sdkToClientIndex`, `messageStartEmitted`).

## Completed
- ~~`src/index.ts` barrel export~~ — Done.
- ~~`prepareMessages` / prompt builder extraction~~ — Done. See `src/proxy/prepareMessages.ts`.
- ~~Agent definitions / fuzzy matching in adapter~~ — Moved to `adapters/opencode.ts`.
