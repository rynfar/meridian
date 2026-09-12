# Release validation


A release needs owner authorization; do not publish simply because a batch finished. Verify the previous tag/changelog range and the release PR's exact diff. Run the full suite, type/build, relevant real E2E and independently installed npm-pack gates. Wait for candidate CI, then merge the exact release head with `gh pr merge <N> --merge --match-head-commit <SHA>`.

Never run manual npm version, tag pushes or npm publish. Do not routinely use --admin or publish_only. If automation fails, investigate the actual failure rather than treating E403 as proof that the correct artifact shipped. After merging, verify Release Please, the GitHub release/tag and commit, npm version/latest/integrity/provenance, a fresh registry install with real affected flow, and Docker version tags/architectures. Keep publication evidence.


Record the exact candidate and merge SHAs, test/E2E versions and logs, workflow URLs, registry integrity/provenance and final publication outcome in the handoff or linked review record. A stopped agent must be able to distinguish “PR merged,” “publication running,” and “published and installed-package validated.”

### Troubleshooting releases

- **Changelog shows entire history?** — Release Please can't find the previous release tag. Check that `meridian-v<version>` tags exist for recent releases: `git tag -l 'meridian-v*' | tail -5`
- **Release PR not updating?** — Inspect the Release Please run and PR state. Changes still reach main through normal PRs; never push directly to main to trigger the bot.
- **Publish failed with E403?** — Check the actual registry version, release commit and provenance before deciding an existing publication is correct; do not blindly ignore the error.
- **`publish_only` workflow dispatch** — Emergency escape hatch to publish the current version without Release Please. Only use when the normal flow is broken.

### Release config files

- **`.release-please-manifest.json`** — tracks the current released version. Release Please updates this automatically when a release PR is merged. **Do not edit manually** unless resetting the version anchor.
- **`release-please-config.json`** — defines the release type (`node`), component name, and changelog section mapping.
- **`.github/workflows/release-please.yml`** — the workflow that runs on every push to `main`. It creates/updates the release PR and publishes to npm when merged.
