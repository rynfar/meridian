# Plugin API boundaries

## Stable API Contract

External plugins depend on these interfaces. **Changes require project owner approval; an explicit request for that contract change supplies it.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Plugins that spawn proxy instances |
| `ProxyInstance.close()` | `types.ts` | Plugins for graceful shutdown |
| `ProxyConfig` type | `types.ts` | Plugin configuration |
| `x-opencode-session` header | `adapters/opencode.ts` | Session tracking from agent plugins |
| `x-meridian-profile` header | `server.ts`, `profiles.ts` | Per-request profile selection |
| `GET /health` response shape | `server.ts` | Plugin health checks |
| `/health` `build` block | `buildInfo.ts` | Version/provenance drift detection |
| `POST /v1/messages` request/response format | `server.ts` | All agents (Anthropic API contract) |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |
If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.
