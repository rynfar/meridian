# Home Manager environment isolation — #1305

Disposition: accept with a separate maintainer platform correction; local gates pass; final-head CI remains a gate. The complete contribution is six paths: opt-in module option, real renderer check, flake registration, operator documentation, and the additive generated Nix workflow/configuration. Default `unsetEnvironment = []` preserves existing generated units. Variable names are validated before rendering; assignments, whitespace and control characters cannot become unit directives. Systemd applies selected removals after inherited, explicit and generated environment values. The option changes the systemd service environment, not proxy/credential/model behavior.

Source `f64aaadb6bb578f676b834552ea3ee20c8f3c893` by Can H. Tartanoglu <gpg@rotas.mozmail.com> is preserved as three authored cherry-picks on main `74ee5515cde58a4df03a48c0ca38abb20ccad648`. [The receipt](home-manager-isolation-1305.json) records each source/replay SHA, original AuthorDates, source/native identities, exact outputs and failed attempts.

## Adversarial finding and correction

**P1:** the source registers the systemd renderer test on every flake system. The locked systems input includes Darwin, but locked Home Manager `df4e0465717a2d34f05b8ccd967275aaf3ceaa01` disables systemd there, producing no `xdg.configFile."systemd/user/meridian.service"`. Evaluating its Darwin derivation therefore fails and breaks Darwin flake checks. Separate maintainer commit `e22822c8e2b312eabd81f52fc0bfd53bf7fda8bf` registers this check only for Linux.

Root inspected the entire six-file contribution, generated shell and immutable action pins, existing module/flake callers, option typing, default rendering, explicit directory configuration, empty/default omission and the real locked Home Manager renderer. Repeated UnsetEnvironment directives are additive, while an empty list is omitted. No other material finding remains in this bounded source review. This is root review, not a delegated independent review. Source correction remains separate from contributor authorship.

## Native before/after proof

Nix 2.35.2 ran in an isolated Linux x86_64 container, emulated on Darwin arm64, with the existing flake lock. Tracked-only baseline and candidate Git archives were mounted read-only; no owner credentials, installed services or model requests were used.

- Authored baseline `4d97f73a` / aarch64-Darwin: real native evaluation exits 1 at the missing service-file attribute.
- Corrected `e22822c8` / aarch64-Darwin: checks evaluate to `[]`, exit 0.
- Corrected Linux: real Home Manager evaluates and builds both generated units, asserting repeated removals, default omission, explicit config/login directories, disabled-service omission and invalid variable-name rejection. Build exits 0; output `/nix/store/cpais4980ya0arb12jkn5jghn6m7wah9-meridian-home-module`.

The first Linux build failed at Nix's seccomp setup under Docker/QEMU. Retrying with only container `filter-syscalls=false` passes unchanged source/lock/assertions; the first failure remains recorded. The locked Nixpkgs already rejects x86_64-Darwin, which remains an inherited platform limitation. No all-platform success is claimed. Both task-owned containers exited before their closure receipts were recorded. The first wrapper's zero exit is not acceptance: its individual failed commands retain their own exit facts.

To reproduce from native Nix, use unchanged source #1305 and the corrected delivery respectively:

```sh
nix eval --no-update-lock-file --raw .#checks.aarch64-darwin.home-module.drvPath
nix eval --no-update-lock-file --json .#checks.aarch64-darwin --apply 'checks: builtins.attrNames checks'
nix build --no-link --no-update-lock-file --json .#checks.x86_64-linux.home-module
```

The first command is the failed-before assertion; the latter two qualify the correction and generated Linux configuration. An existing native Nix installation avoids the Docker-specific syscall workaround. Full command/log hashes, immutable image digest and archive identities are in the receipt. Supplemental failed logs and exact runner are retained at `/Users/rynfar/repos/meridian-review-evidence-20261006/resumption-20261008-round2/nix1305`.

Local `npm test` (including pretest typecheck), separate typecheck and build all exit 0 on exact corrected code head `e22822c8`; tests report 5478 pass, 35 skip and zero failures. The delivery adds only reviewed evidence/handoff/E2E documentation after that head; product and test source remains identical. Final full-diff and documentation/link/identity checks pass. Final integration-head CI must include the new hosted Nix build plus all normal relevant checks before merge. These compiler/renderer gates do not establish host activation, subscription login or model inference; those flows are not changed here. Release is not authorized by this change.

Primary references: [systemd final environment removal](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml), [locked Home Manager systemd renderer](https://github.com/nix-community/home-manager/blob/df4e0465717a2d34f05b8ccd967275aaf3ceaa01/modules/systemd.nix), and [locked supported-system list](https://github.com/nix-systems/default/blob/da67096a3b9bf56a91d16901293e51ba5b49a27e/default.nix).
