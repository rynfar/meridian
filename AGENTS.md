# Meridian

Meridian bridges supported coding clients to Claude through the Agent SDK and to Antigravity through the official agy CLI.

## Working scope

Continue authorized implementation through relevant verification, corrections, and a PR. Preserve the user's checkout; use an isolated feature branch from current `origin/main`. Do not push directly to main. An instruction cleanup or typo fix does not start the contributor backlog, run live model calls, or publish a release.

- Use `ARCHITECTURE.md` for module and dependency changes, `DESIGN.md` for user-facing UI/brand changes, and `E2E.md` for affected-client live verification.
- Use [meridian-upstream-review](.agents/skills/meridian-upstream-review/SKILL.md) for contributor review/incorporation or authorized release work. Read `docs/maintenance/REVIEW_HANDOFF.md` only when continuing that work; refresh live GitHub status before relying on a dated checkpoint.
- Use [meridian-backlog](.agents/skills/meridian-backlog/SKILL.md) for an authorized PR/issue queue across Meridian and the owner's scrub repositories. Use [meridian-evidence](.agents/skills/meridian-evidence/SKILL.md) for adversarial review and proof of a fix, merge, or release.
- For commits/PRs/merges, use [contribution workflow](.agents/references/contributing.md). Normal PRs squash with `--match-head-commit`; Release Please PRs merge with `--merge`. Required final-head CI, including `test`, remains a merge gate. Never bypass checks routinely.
- External comments/messages need explicit authorization. Release authorization is separate from completing a change. Never manually run `npm version`, push tags, or `npm publish`; use the release reference in the review skill.
- Adversarially review every proposed PR and release before landing it. Record the concrete product-fit, regression, and evidence findings in its PR or review handoff; fix material findings before merge.

## Engineering boundaries

Keep `server.ts` focused on orchestration. `session/lineage.ts` is pure: no I/O or cache/server imports. Leaf modules such as `errors.ts`, `retryAfter.ts`, `models.ts`, `tools.ts` and `messages.ts` must not import `server.ts` or `session/`; dependencies flow downward without cycles.

Keep agent-specific logic in the adapter boundary. When changing existing special cases, consult the Agent-Specific Logic section of `ARCHITECTURE.md`, retain useful `NOTE:` markers, and avoid spreading them into unrelated modules. Do not use `as any`, `@ts-ignore`, `@ts-expect-error`, or empty catch blocks.

Public plugin interfaces require owner approval and an issue before modification; an existing explicit request covering the change supplies approval. Consult [API contract](.agents/references/api-contract.md) when touching exported proxy configuration/lifecycle, session/profile headers, health, messages or profile routes. Internal fixes that preserve these interfaces do not require new approval.

UI uses `DESIGN.md`, color tokens from `themeCss` in `src/telemetry/profileBar.ts`, and the shared `profileBarCss/Html/Js` header. Pages do not set their own body background. Blue `--accent` means interactive/active; violet `--accent2` means code/meta/secondary brand.

## Validation

`npm test` typechecks first (a `pretest` hook) and then runs the full suite with process-global mocks isolated; bare all-files `bun test` does neither. Targeted `bun test <file>` is useful while developing, but it does **not** typecheck — a test that references an unimported symbol passes there and throws at runtime, which is how one shipped. `npm run typecheck` checks types on their own; `npm run build` bundles and checks Node entrypoints.

Choose focused checks during iteration and fix failures caused by the change. For code changes, the final local gates are `npm test`, typecheck and build. Documentation/instruction-only changes need content, link and diff validation, not model calls or an application rebuild. Required CI still applies before merge.

Cover meaningful extracted behavior with direct pure-function tests or HTTP integration tests through the mocked SDK; tests live in `src/__tests__/`. Every accepted product behavior change and release requires affected-flow live E2E using the actual implicated model, SDK, client and platform. Use `E2E.md`; mocks, another platform/model, or an unexplained green rerun cannot establish that the reported problem is fixed. Preserve missing evidence explicitly and continue any independent work.

For critical fixes, commit a reproducible headless E2E harness when feasible, even if real credentials keep it out of CI, and retain a durable before/after evidence record beyond a temporary local path. Capture short video for visual or timing behavior when it helps review; keep secrets out of logs and media.
