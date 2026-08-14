# CLAUDE.md

Project guidelines for AI agents working in this codebase.

## What This Is

A proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK). See `ARCHITECTURE.md` for the full module map and dependency rules.

## Commands

```bash
npm test          # Run all tests (bun test)
npm run build     # Build with tsup
npm start         # Start the proxy server
```

## Code Rules

### Module Boundaries

- **Do not add code to `server.ts` that belongs in a leaf module.** If it's pure logic (no HTTP, no Hono), extract it.
- **`session/lineage.ts` must stay pure.** No side effects, no I/O, no imports from cache or server.
- **Leaf modules (`errors.ts`, `models.ts`, `tools.ts`, `messages.ts`) must not import from `server.ts` or `session/`.** Dependencies flow downward only.
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
- **E2E tests** are documented in [`E2E.md`](./E2E.md) — run manually before releases or after major refactors (requires Claude Max subscription)

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
shutdown.ts        → Bounded HTTP drain, socket tracking, forced close
adapter.ts         → AgentAdapter interface (extensibility point)
adapters/
  opencode.ts      → OpenCode-specific: headers, CWD, tool config
  forgecode.ts     → ForgeCode-specific: XML CWD, patch/shell tools, passthrough
query.ts           → buildQueryOptions (shared stream/non-stream SDK call builder)
errors.ts          → classifyError (pure)
models.ts          → mapModelToClaudeModel, resolveClaudeExecutableAsync
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

All changes go through this process, no exceptions:

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/my-feature main
   ```

2. **Make changes, commit, push the branch:**
   ```bash
   git add -A && git commit -m "feat: my feature"
   git push origin feat/my-feature
   ```

3. **Create a PR** targeting `main`:
   ```bash
   gh pr create --title "feat: my feature" --base main
   ```

4. **Wait for CI** — the `test` job must pass before merging:
   ```bash
   gh pr checks <PR_NUMBER>
   ```

5. **Merge the PR** (squash merge preferred):
   ```bash
   gh pr merge <PR_NUMBER> --squash --delete-branch
   ```

   Squash is the default because Release Please parses every commit on `main`
   for the changelog — squashing keeps changelog entries 1:1 with PRs, whereas
   merge commits leak every intermediate `fix:`/`feat:` commit into the release
   notes.

   **Use `--squash` for external contributions too.** `--merge` was tried in
   #693 and #700 and produced *duplicate* changelog entries, not merely an
   extra one: GitHub's merge commit carries the branch commit's subject in its
   body, so Release Please parses both and emits the same line twice.

   Squash still credits the contributor. GitHub auto-generates a
   `Co-authored-by:` trailer, which counts toward their contribution graph and
   renders both avatars on the commit. The only thing lost is sole `Author` on
   the commit, which is not worth a changelog that repeats itself every release.

   **The duplicate-entry trap is closed by repo settings, not by remembering.**
   The same failure reaches squash whenever a branch has 2+ conventional
   commits: GitHub would paste each commit subject into the squash body and
   Release Please would parse them all. The repository is configured so that
   cannot happen:

   | Setting | Value | Why |
   |---|---|---|
   | `squash_merge_commit_title` | `PR_TITLE` | the changelog line is the PR title, never a branch commit's subject |
   | `squash_merge_commit_message` | `BLANK` | the body carries no commit subjects, so there is nothing extra to parse |

   Verified 2026-08-03 on a throwaway PR: the resulting squash body contained
   *only* `Co-authored-by:`, which GitHub still appends under `BLANK`. So
   contributor credit and a 1:1 changelog both hold with no flags.

   **Therefore: plain `gh pr merge <N> --squash --delete-branch` is correct for
   every PR, single- or multi-commit.** Do not hand-craft `--subject`/`--body`
   to work around the old trap; that was only needed before these settings, and
   a hand-written body can reintroduce the duplicate. Do not change these two
   settings back. Check them with:

   ```bash
   gh api repos/rynfar/meridian --jq '{t: .squash_merge_commit_title, m: .squash_merge_commit_message}'
   # expect {"t":"PR_TITLE","m":"BLANK"}
   ```

   `--admin` is **not** routinely required. `main` requires signed commits, and
   `commit.gpgsign` is enabled locally, so normal work merges `CLEAN`. Reach for
   `--admin` only when a PR is genuinely `BLOCKED`, and check
   `gh pr view <N> --json mergeStateStatus` first rather than adding it by habit.

   **`main` requires signed commits, so fork PRs can never be merged directly.**
   An external PR sits at `mergeStateStatus: BLOCKED` with every check green and
   no indication why — `gh pr view <N> --json mergeStateStatus` is the only
   signal. This is not something the contributor can fix from their side.

   The path in, for any outside contribution:

   ```bash
   git checkout -b fix/their-thing-merged origin/main
   git cherry-pick <their-sha>     # re-signs with your key, keeps them as Author
   # your own changes go in a separate commit on top
   gh pr create --base main
   gh pr merge <N> --squash --delete-branch
   ```

   - **Never retype a contributor's change as your own commit.** Cherry-pick it;
     that is what preserves them as `Author` through to the squash trailer.
   - Close their original PR with a comment explaining the signing constraint,
     so it does not read as a rejection.

6. **Never** run `git push origin main` directly — all code reaches `main` through merged PRs only.

## Releasing

**Do NOT run `npm version`, `git push --tags`, or `npm publish` manually.**

Releases are handled automatically by [Release Please](https://github.com/googleapis/release-please):

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
- **Release PR not updating?** — It only updates on `push` to `main`. If you closed it, push any commit to main to regenerate.
- **Publish failed with E403?** — The version was already published. This is safe to ignore; the release is already on npm.
- **`publish_only` workflow dispatch** — Emergency escape hatch to publish the current version without Release Please. Only use when the normal flow is broken.

### Release config files

- **`.release-please-manifest.json`** — tracks the current released version. Release Please updates this automatically when a release PR is merged. **Do not edit manually** unless resetting the version anchor.
- **`release-please-config.json`** — defines the release type (`node`), component name, and changelog section mapping.
- **`.github/workflows/release-please.yml`** — the workflow that runs on every push to `main`. It creates/updates the release PR and publishes to npm when merged.
