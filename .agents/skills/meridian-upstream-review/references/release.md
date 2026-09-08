# Release validation


A release needs owner authorization; do not publish simply because a batch finished. Verify the previous tag/changelog range and the release PR's exact diff. Run the full suite, type/build, relevant real E2E and independently installed npm-pack gates. Wait for candidate CI, then merge the exact release head with `gh pr merge <N> --merge --match-head-commit <SHA>`.

Never run manual npm version, tag pushes or npm publish. Do not routinely use --admin or publish_only. If automation fails, investigate the actual failure rather than treating E403 as proof that the correct artifact shipped. After merging, verify Release Please, the GitHub release/tag and commit, npm version/latest/integrity/provenance, a fresh registry install with real affected flow, and Docker version tags/architectures. Keep publication evidence.


Record the exact candidate and merge SHAs, test/E2E versions and logs, workflow URLs, registry integrity/provenance and final publication outcome in the handoff or linked review record. A stopped agent must be able to distinguish “PR merged,” “publication running,” and “published and installed-package validated.”
