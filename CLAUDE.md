# CLAUDE.md

Project guidelines for AI agents working in this codebase.

## Repository skills and continuation

For contributor PR/issue reviews, maintainer fixes to those contributions,
authorized releases, or resuming this backlog, read and follow
[meridian-upstream-review](.agents/skills/meridian-upstream-review/SKILL.md)
before acting. Claude also has a discovery entrypoint in `.claude/skills/`;
both use the same canonical instructions.

For continuation, read [the current review handoff](docs/maintenance/REVIEW_HANDOFF.md),
then refresh GitHub and origin/main. Update that handoff at a meaningful stop or
handoff point. Do not rely on personal memories, old chat summaries, or a goal
runner's status to decide what shipped or what remains. User instructions take
precedence; this workflow does not start the backlog or authorize external
actions by itself.

## What This Is

A proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK). See `ARCHITECTURE.md` for the full module map and dependency rules.

## Commands

```bash
npm test          # Run all tests — ALWAYS use this, never bare `bun test`
npm run build     # Bundle with Bun, emit declarations and check Node entrypoints
npm start         # Start the proxy server
npm run typecheck # tsc --noEmit (CI runs this separately; tests do not typecheck)
```

**`npm test` is not a thin wrapper around `bun test`.** Some files use
process-global mocks; the npm script excludes those from the main pass and runs
them in separate Bun invocations. Use that script for the full suite. Targeted
`bun test <file>` runs are useful during development but do not replace it.

## Code Rules

### Module Boundaries

- **Do not add code to `server.ts` that belongs in a leaf module.** If it's pure logic (no HTTP, no Hono), extract it.
- **`session/lineage.ts` must stay pure.** No side effects, no I/O, no imports from cache or server.
- **Leaf modules (`errors.ts`, `retryAfter.ts`, `models.ts`, `tools.ts`, `messages.ts`) must not import from `server.ts` or `session/`.** Dependencies flow downward only.
- **No circular dependencies.**

### Agent-Specific Logic

OpenCode-specific behavior is documented in `ARCHITECTURE.md` under "Agent-Specific Logic". When modifying these areas:

- Add a `NOTE:` comment marking the code as agent-specific
- Do not spread agent-specific logic into new modules
- Future work will use an adapter pattern — see `DEFERRED.md`

### Testing

- Every extracted module must have unit tests
- Pure functions get direct unit tests (no mocks)
- Integration tests go through the HTTP layer with mocked SDK
- **All tests must pass before any change is considered complete**
- New test files go in `src/__tests__/`
- **Live E2E is required for every accepted behavior change and before releases**, using the real SDK/model and affected client flow. See [`E2E.md`](./E2E.md) and the upstream-review skill. Mock-only tests, a different model/platform, or a green rerun do not prove the reported problem fixed.

### Style

- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- No empty catch blocks
- Match existing patterns — check neighboring code before writing
- Keep `server.ts` as thin as possible — it should orchestrate, not compute

### Design (web UI + brand assets)

- **All user-facing surfaces follow [`DESIGN.md`](./DESIGN.md)** — the full design language (palette, chrome, components, principles).
- Color tokens come from `themeCss` in `src/telemetry/profileBar.ts`; never hardcode hex colors in page CSS.
- Every page embeds the shared site header (`profileBarCss/Html/Js`) and must not set its own `body` background.
- Blue (`--accent`) = interactive/active; violet (`--accent2`) = code/meta/brand-secondary — never swap these roles.

## Architecture Quick Reference

```
server.ts          → HTTP routes, SSE streaming, concurrency (orchestration only)
concurrency.ts     → Abortable SDK query semaphore, max-concurrency config
requestAbort.ts    → HTTP request abort → SDK query abort bridge
sessionTree.ts     → Live parent→child request registry, subtree cancellation (PURE bookkeeping)
shutdown.ts        → Bounded HTTP drain, socket tracking, forced close
adapter.ts         → AgentAdapter interface (extensibility point)
adapters/
  opencode.ts      → OpenCode-specific: headers, CWD, tool config
  forgecode.ts     → ForgeCode-specific: XML CWD, patch/shell tools, passthrough
query.ts           → buildQueryOptions (shared stream/non-stream SDK call builder)
errors.ts          → classifyError (pure)
retryAfter.ts      → Retry-After seconds for 429/503/529 (PURE)
models.ts          → mapModelToClaudeModel, resolveClaudeExecutableAsync
buildInfo.ts       → build provenance + semver compare (PURE)
updateCheck.ts     → cached npm registry check for the newest release
tools.ts           → BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME
messages.ts        → normalizeContent, getLastUserMessage (pure)
fileChanges.ts     → PostToolUse hook: file write/edit tracking + summary formatting (pure)
design.ts          → Claude Design MCP proxy: token store/refresh, auth precedence, login flow
session/
  lineage.ts       → Hashing, lineage verification (PURE — no I/O)
  fingerprint.ts   → extractClientCwd, getConversationFingerprint
  cache.ts         → LRU caches, lookupSession, storeSession (stateful)
  turnCoordinator.ts → Process-wide strict serialization for reliable session IDs
```

## Stable API Contract

External plugins depend on these interfaces. **Do not change without project owner approval.**

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

## Git & Workflow

### Commit format

- Format: `type: brief description`
- Types: feat, fix, refactor, perf, test, docs, chore
- No AI attribution lines

### Development workflow — NEVER push directly to main

1. Use a feature branch from current main, preferably in a fresh isolated
   worktree, preserving the user's checkout. For upstream reviews, use the
   repository skill above to assess desirability and preserve contributor
   Author/AuthorDate through cherry-picks and separate maintainer corrections.
2. Commit, push the feature branch, and create a PR targeting main. Use
   Conventional Commits and describe the final behavior and validation.
3. Run the required local checks and affected-flow live E2E, then wait for all
   relevant final-head CI checks, including `test`. Recheck the head, base and
   merge state immediately before merging; a changed head invalidates old checks.
4. Normal PRs use `gh pr merge <N> --squash --match-head-commit <verified-SHA>`.
   Delete only branches owned by this workflow after they are no longer needed.
   Release Please PRs use `--merge` instead.
5. Verify the merged tree and contributor credit. Recheck an incorporated
   original PR's head before closing it, so newer contributor work is not lost.
   Only close an issue when the validated behavior actually resolves it.

Squash keeps changelog entries one per PR. Preserve repository settings
`squash_merge_commit_title=PR_TITLE` and `squash_merge_commit_message=BLANK`;
do not paste intermediate conventional-commit subjects into the squash body.
Verify human contributor credit instead of assuming every maintainer integration
PR automatically receives all needed co-author trailers. No AI attribution.

Signed-commit requirements can block a contributor PR. Inspect the actual block;
use an authored cherry-pick in a maintainer integration PR when needed, with
separate maintainer fixes. Never retype a contribution under your own authorship.
Do not routinely use `--admin` or bypass checks.

Do not post comments or send messages to others without explicit authorization;
draft explanations locally. Never run `git push origin main` directly.

## Releasing

**Do NOT run `npm version`, `git push --tags`, or `npm publish` manually.**

For release validation and publication verification, follow the repository skill
above and its release reference. Releases are handled automatically by [Release Please](https://github.com/googleapis/release-please):

1. Merge PRs to `main` using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
2. Release Please auto-creates/updates a release PR that batches all unreleased changes
3. Review the release PR — the changelog should only show changes since the last release
4. When ready to ship, merge the release PR:
   ```bash
   gh pr merge <RELEASE_PR_NUMBER> --merge
   ```
5. Merging the release PR automatically:
   - Bumps `package.json` and `CHANGELOG.md`
   - Creates a git tag (`meridian-v*`) and GitHub Release
   - Runs tests, builds, and publishes to npm with provenance

Multiple PRs get batched into a single release. Never publish manually.

### Troubleshooting releases

- **Changelog shows entire history?** — Release Please can't find the previous release tag. Check that `meridian-v<version>` tags exist for recent releases: `git tag -l 'meridian-v*' | tail -5`
- **Release PR not updating?** — Inspect the Release Please run and PR state. Changes still reach main through normal PRs; never push directly to main to trigger the bot.
- **Publish failed with E403?** — Check the actual registry version, release commit and provenance before deciding an existing publication is correct; do not blindly ignore the error.
- **`publish_only` workflow dispatch** — Emergency escape hatch to publish the current version without Release Please. Only use when the normal flow is broken.

### Release config files

- **`.release-please-manifest.json`** — tracks the current released version. Release Please updates this automatically when a release PR is merged. **Do not edit manually** unless resetting the version anchor.
- **`release-please-config.json`** — defines the release type (`node`), component name, and changelog section mapping.
- **`.github/workflows/release-please.yml`** — the workflow that runs on every push to `main`. It creates/updates the release PR and publishes to npm when merged.
