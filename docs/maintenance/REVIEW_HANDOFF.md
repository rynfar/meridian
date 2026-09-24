# Upstream review handoff

## Cross-repository scrub review (2026-09-24)

Live discovery found five owner-controlled scrub repositories:
`meridian-plugin-pi-scrub`, `meridian-plugin-opencode-scrub`,
`meridian-plugin-hermes-scrub`, `meridian-plugin-openclaw-scrub`, and
`hudscrub`. Refresh the owner's repository list and each queue on continuation.

- **Pi scrub:** Serge Baranov's source #7 `fa9366c3` was cherry-picked as
  `8732fd2d` with Author and AuthorDate preserved, corrected in a separate
  maintainer commit, and delivered by [#10](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/10)
  (`54e0706a`, Serge credited on the squash commit). The unchanged main failed
  two foreign-prompt exact-byte tests; the delivery passed 13 tests and real Pi
  0.72.1 → Meridian 1.76.3 → Haiku 4.5 E2E. Original #7 closed at its unchanged
  head. Release [#5](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/5)
  merged/tagged at `ae3d2ac7`; npm 0.2.1 integrity
  `sha512-luYfyF84gt8AxNKpzqbqR00Lw7F2GwQS1NdxIZigb6tjFLt2nQbxtlRuGHHiybZp1LeChJ92h2+vrcyY1SatNA==`
  has matching provenance. A fresh registry-installed Pi live run passed.
- **OpenCode scrub:** Brian Keefe's [#5](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/5)
  remains open; its minimal mode conflicts with later OMO 4.x and cwd fixes,
  leaves a metering trigger, and lacks tests. Revisit on an amended head or a
  reproducible prompt-stability case. Newest issue #10 was reproduced on npm
  0.2.1 (real OpenCode 1.18.32 → LiteLLM 1.81.10 → Meridian 1.76.3 → Opus 5.5
  reached the billing gate), fixed by [#14](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/14)
  (`c517a2c3`), and passed the same client flow, 21 tests and final-head CI.
  Release [#15](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/15)
  merged/tagged at `46383730`; npm 0.2.2 integrity
  `sha512-w522x+6UWSKoXXPdvEY6vAwe4rur8r15GpwB3UUYixSvjVYhMzJayiONxqtd2N2HzNARS+SbCisqo6ovTmCgTQ==`
  has matching provenance. A fresh registry-installed Opus flow passed; issues
  #10, #9 and #1 are closed on this evidence.
- **Hermes scrub:** Documentation [#10](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/10)
  corrected the current identifier-neutralization behavior. Adversarial release
  review found the 0.2.0 package would report plugin version 0.1.0; [#11](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/11)
  derives it from the shipped package metadata, with a version assertion and
  real Hermes 0.21.4 → Meridian 1.76.3 → Opus 5.5 validation. Release
  [#2](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/2) merged/tagged
  at `06bbe816`; final-head CI, 14 tests, build and packed install passed.
  Actual Hermes parent and delegated child prompts contained targeted tokens
  before the plugin and none after; the guidance remained. Fresh npm 0.2.0
  installed-package E2E passed (local artifact `hermes-scrub-live-LvJRNp`).
  Registry integrity is
  `sha512-SSjCvjw3QQk8vOALdIMONUrntWs4MCQjCbxtYvgkbp7dwSXzOwRJYMFXUFt/ZEW5yTnhadZVsua1/88d81H2AA==`;
  provenance resolves to `06bbe816`. Publication issue #5 is closed.
- **OpenClaw scrub and HUDScrub:** No open PRs or issues in the refreshed queue.
  Meridian's live open PRs at this checkpoint are #1113 (draft Letta delivery,
  blocked on the real cloud flow), #1105 (source Letta PR), #1050 (draft
  Antigravity research), and #792 (author explicitly requested no review).
  Its live open issues are #1094, #1073, #1068, #1011, #1009, #933, #917,
  #769, and #650. The older Meridian notes below are historical; refresh their
  status and revisit triggers before acting.

The Pi, OpenCode and Hermes live probes are now escrowed as
[`scripts/e2e-pi-scrub-live.mjs`](../../scripts/e2e-pi-scrub-live.mjs) and
[`scripts/e2e-opencode-scrub-live.mjs`](../../scripts/e2e-opencode-scrub-live.mjs),
and [`scripts/e2e-hermes-scrub-live.mjs`](../../scripts/e2e-hermes-scrub-live.mjs),
with the repeatable commands in [`E2E.md`](../../E2E.md). No community comments
were sent.

### Package metadata patch releases and Nix integration

- Adversarial review found published Pi 0.2.1 reporting plugin version 0.2.0.
  [Pi #11](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/11)
  (`a6f1b3e7`) adds a package-version assertion (failing on unchanged main),
  derives runtime metadata from the shipped package, and passed 14 tests,
  build, packed install and real Pi 0.72.1 → Meridian 1.76.3 → Haiku 4.5.
  Release [Pi #12](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/12)
  had final-head CI and candidate E2E, merged at `23c98fac`, and published
  0.2.2 through [run 35975618398](https://github.com/rynfar/meridian-plugin-pi-scrub/actions/runs/35975618398).
  Registry integrity is
  `sha512-ksw4pOQdz54DTg2YkG06KB39EIIY5u0pH8VCPh9Se/+ONIzNx2PqbRJECvZ2Ti5j63wVagAYr2kTJ+/V6uKcRA==`;
  its signed provenance digest and source commit match the registry and
  `23c98fac`. `npm audit signatures` verified the attestation and a fresh
  registry-installed Pi run passed (`pi-scrub-live-H5bdwW`).
- Published OpenCode 0.2.2 reported plugin version 0.1.0.
  [OpenCode #16](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/16)
  (`015d373d`) adds the corresponding failing-baseline assertion and package
  metadata import. It passed 22 tests, build, packed install and real OpenCode
  1.18.32 → LiteLLM 1.81.10 → Meridian 1.76.3 → Opus 5.5.
  Release [OpenCode #17](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/17)
  had final-head CI and candidate E2E, merged at `4b410c5a`, and published
  0.2.3 through [run 35975742509](https://github.com/rynfar/meridian-plugin-opencode-scrub/actions/runs/35975742509).
  Registry integrity is
  `sha512-JOlxV0VAbWcXGTC+bsi4K2d4g3vb2UG5y8s1HzKjWkeAm7kmdIYcHbPie+ror2HTaNaRKIpzGOkPqqonEgs5YA==`;
  its signed provenance digest and source commit match the registry and
  `4b410c5a`. `npm audit signatures` verified the attestation and a fresh
  registry-installed Opus 5.5 run passed (`opencode-scrub-live-aYHjqK`).
- Meridian [#1144](https://github.com/rynfar/meridian/pull/1144) advances
  `flake.lock` to Hermes 0.2.0 (`06bbe816`), Pi 0.2.2 (`23c98fac`), and
  OpenCode 0.2.3 (`4b410c5a`). Its separate Nix fix retains the source
  `package.json` at the relative path imported by all three plugins and runs
  a Node import and plugin/package version equality check inside each package
  build. Before the fix, the old Nix output reproduced
  `ERR_MODULE_NOT_FOUND`. On the corrected final pins, all three Linux arm64
  Nix plugin builds, imports and version assertions passed.
  The Pi and OpenCode headless harnesses also passed against independently
  packed final packages in the real macOS clients: `pi-scrub-live-v3rHYL`
  and `opencode-scrub-live-F7CpFW`. The Pi probe observed both identity and
  docs markers before the plugin; the SDK call had neither and retained the
  generic coding identity. The OpenCode passthrough probe observed both
  metering-trigger markers before the plugin, neither afterward, retained
  the client working directory, and the client exited successfully.
  Actual exported Nix outputs also passed Hermes 0.21.4 → Opus 5.5
  (`hermes-scrub-live-XVeNQ5`) and Pi 0.72.1 → Haiku 4.5
  (`pi-scrub-live-Qa4NtE`) through the same isolated Meridian runtime.
  The OpenCode 1.18.32 → LiteLLM 1.81.10 → Opus 5.5 Nix-output run passed
  (`opencode-scrub-live-9TiJfp`), with the passthrough markers removed and
  the client working directory preserved.

### Final integration and remaining gates

- Meridian [#1144](https://github.com/rynfar/meridian/pull/1144) passed its
  exact-head `test`, Ubuntu/macOS Nix builds, Windows smoke, Docker, desktop,
  and bun.nix verification checks, then squash-merged as `f8830dee35450898af64f26c3e37d7de32c132c2`
  at 08:54 UTC. The merge tree matches the locally validated branch. The
  original workflow-authored pin commit retains its Author and AuthorDate in
  the delivery history; the squash credits both author identities.
  Local `npm test`, standalone typecheck/build, all three final-pin Linux arm64
  plugin Nix builds, script syntax, skill validation and local links passed.
  The three actual Nix outputs passed the client/model flows recorded above.
- Release Please [run 35978034021](https://github.com/rynfar/meridian/actions/runs/35978034021)
  found no user-facing conventional commit after the `chore:` squash and made
  no release candidate. The explicit `Release-As: 1.76.4` intent in
  [#1145](https://github.com/rynfar/meridian/pull/1145) produced
  [#1146](https://github.com/rynfar/meridian/pull/1146). Adversarial review
  of that candidate caught three E2E scripts hardcoding Meridian 1.76.3 in
  their logs; the separate maintainer commit `cabbc75a` reads the installed
  version and can assert it with `E2E_EXPECT_MERIDIAN_VERSION`. A negative
  control failed before any model call. All three corrected scripts passed on
  the 1.76.4 candidate through their real clients and models (Hermes
  `hermes-scrub-live-qz94pi`, Pi `pi-scrub-live-b4d5As`, OpenCode
  `opencode-scrub-live-kKregc`). The corrected final head passed full local
  `npm test`, typecheck and build and required final-head CI `test`, both Nix
  builds, Windows, Docker and desktop checks. The release PR merged with the
  required merge method as `076922f58dbf2c58637501339b2b2526c71af687`;
  its merge tree equals the validated candidate.
- [Meridian 1.76.4](https://github.com/rynfar/meridian/releases/tag/meridian-v1.76.4)
  tags that merge commit. The registry's `latest` is 1.76.4 with integrity
  `sha512-yGzy9EU5q9F3uFeQ6kDTCA4oHX8BABbKBKrI18IonOVyfkRb9jWQsv+0LGUKIgPWme1MnFz5JUZ2Z/bRV6CJXw==`.
  Its SLSA provenance subject digest matches the registry integrity and its
  resolved Git commit matches `076922f5`; `npm audit signatures` verified the
  installed dependency signatures and attestations. A fresh registry install
  passed real HTTP → SDK Opus 5.5 fresh and resumed conversations, preserving
  the fixture marker (`meridian-release-live-kGx3Zh`). The published tarball
  differs from the local candidate pack only in three bundle files: a baked
  build-machine path in `libsql`, two Bun optimizer no-op branches, and the
  resulting chunk filename/imports. The actual published package passed the
  installed-package E2E, so validation covers that final artifact directly.
  [Release run 35981302861](https://github.com/rynfar/meridian/actions/runs/35981302861)
  published the package and signed/notarized macOS DMG and ZIP. The release's
  `BUILD-INFO.txt` identifies `076922f5`; its `SHA256SUMS.txt` records DMG
  `8a010a7f55ee2f0aab53eb2b91802931e69c6ab07f1087c95ce8e38515e276e6`
  and ZIP `8a724c4cdb2de98c10ac446536ac12ef6a2aad31aeddd10e57bf9433ed3cc404`.
  The completed release workflow also published
  `ghcr.io/rynfar/meridian:1.76.4` as OCI index
  `sha256:1d1e8c33c55ec40b38aa65a224d79073cbf8f14f98c6dd87c205f446de8a9056`
  with both `linux/amd64` and `linux/arm64` manifests and attestations.
- Meridian [#1148](https://github.com/rynfar/meridian/pull/1148) delivered the
  OpenCode 2.0.16 compatibility port as `1a5e1a2b43311527650fc834d7d777abc5620141`.
  The published 1.76.4 baseline failed the committed headless gate at setup
  before a model call; manually loading its V2 plugin reproduced the missing
  `context.catalog.transform` error. The corrected source and fresh npm-pack
  candidate each passed the 15-request OpenCode 2.0.16 → Meridian SDK → Sonnet 5
  gate on macOS. A Linux arm64 OpenCode 2.0.16 / Node 22.23.1 client passed
  the same installed-pack gate against a macOS candidate proxy. All three
  pinned beta extended live gates passed. Local `npm test`, typecheck and build
  passed, as did final-head CI `test`, Windows, desktop and Docker checks. The
  signed head `8d06fd5c` had the same tree as the squash merge.
- Release Please [#1149](https://github.com/rynfar/meridian/pull/1149) made only
  the expected 1.76.5 manifest/package/lockfile bumps and changelog entry.
  Its head `858de1fc15f82c9e2c28bca3ab0399f210f6981c` passed final-head
  `test`, Nix builds, Windows, Docker and desktop CI; the local full suite,
  standalone typecheck and build also passed. The independently installed
  1.76.5 pack passed the same 15-request real Sonnet 5 gate on macOS and with
  the Linux arm64 client. The release PR merged at
  `9170c68feeddae4bee438939b7587647f2275123`, with a tree identical to the
  tested candidate. The tag `meridian-v1.76.5` points to that commit.
  [Release run 35989239706](https://github.com/rynfar/meridian/actions/runs/35989239706)
  completed all four jobs successfully. Its signed/notarized macOS DMG and ZIP
  have release-asset SHA-256 digests
  `3ae56de7c38420da786674b31a5b632d6acecea82df4c4ada14d132eaaab7fca`
  and `f3463f0aa3fbe6b4f919df02acc39d18c50a910b0247320fd8c445ac9820b6b0`,
  matching `SHA256SUMS.txt`; `BUILD-INFO.txt` names the release commit. The
  versioned Docker index is
  `sha256:17f84fc60f3090e02f159b78b915f3932155a97cc71b456a584d21d94af40899`
  with `linux/amd64` and `linux/arm64` images and attestations. The separate
  main-branch Docker workflow also passed for `latest`.
  npm `latest` is 1.76.5 with registry integrity
  `sha512-4pDqR1ZRtyCV1NBpdf+6ddYQTs55lVUUD9ZRN7ryeGO+J1uv4rD+IdyZc7WH4BARSQTwMLbiJwrmRwIhyL7ngw==`
  and shasum `5fa0f21d50fdc8fad74ef8e88b599d73818a8663`.
  Its SLSA provenance subject digest equals that integrity and names source
  commit `9170c68f` and release run `35989239706`; `npm audit signatures`
  verified 108 signatures and 14 attestations. A fresh registry-installed
  1.76.5 package passed the 15-request real OpenCode 2.0.16 → Sonnet 5 gate
  on macOS (`meridian-opencode-v2-stable-ruagkV`). A separate fresh registry
  install in Linux arm64 / Node 22.23.1 passed the same client gate
  (`meridian-opencode-v2-stable-HQEd88`) against the published macOS proxy.
  The reporter's exact content-sensitive system block is unavailable and the
  full Linux proxy/SDK path has not been replayed; keep #1094 open for that
  narrower `billing_error` claim.
- An additional headless probe for [issue #1009](https://github.com/rynfar/meridian/issues/1009)
  confirmed the existing `--case=unhandled --stream` fixture still passes with
  the flag off and an undeclared tool. Substituting a declared tool makes the
  real SDK invoke `PreToolUse` before the tool's `content_block_stop` becomes
  observable to the harness, so that substitution does not reproduce the
  missing-hook abort window. Leave the flag off until a dedicated fault
  injection and the affected deployment's canary establish the positive path.
- A fresh owner/organization repo and queue scan found the same five managed
  scrub repositories and no new PRs or issues. Pi, Hermes, OpenClaw scrub and
  HUDScrub are clear. OpenCode contributor #5 is unchanged and deferred for
  its documented regression. Meridian #1113/#1105, #1050 and #792 remain as
  above; its nine open issues have unchanged dispositions except #1094.
  An issue update at 09:16 UTC reports that `@opencode/cli@2.0.16` is released,
  even though `@opencode-ai/plugin` still has `latest=1.18.32`. The official
  `v2.0.16` Git tag and npm CLI version were verified. On that exact binary,
  `meridian setup --v2` rejects the version, and manually loading the bundled
  V2 plugin logs `context.catalog.transform` undefined. The 2.0.16 plugin
  interface moved catalog work into separate `provider` and `model` domains.
  #1094 is now an actionable compatibility port, not a safe unpin. Preserve
  the beta gates while adapting it, and require real 2.0.16 client/package E2E
  plus the reported billing-payload path before declaring the issue resolved.
  The isolated compatibility candidate now supports the released 2.0.16 host
  while retaining the three beta APIs. The committed headless probe is
  [`scripts/e2e-opencode-v2-stable-live.mjs`](../../scripts/e2e-opencode-v2-stable-live.mjs).
  Against a fresh registry install of the published 1.76.4 baseline, that
  probe fails before a model call because setup rejects 2.0.16.
  Its real 2.0.16 → Meridian → Sonnet 5 source and independently installed
  npm-pack runs each passed 15 requests on macOS. They assert setup/loading,
  signed primary and detached title/generate requests, resumed context,
  discovered `#xhigh`, an actual read-tool result, fork isolation, and attached
  compaction. The final pack integrity was
  `sha512-sWEY3wvTqQUCsqjjT4qx2xVsrjcKLRhqvcJ64HDFh6xyzetEpAqLDnHJvZYmOMxk+ybEEcQrJL1xTkQe5NJScg==`.
  An installed-pack Linux arm64 OpenCode 2.0.16 and Node 22.23.1 run passed
  the same 15-request gate against the candidate Meridian proxy on macOS;
  this checks the reported client platform but is a split-platform run, not
  an all-Linux proxy deployment. The three pinned beta live extended gates
  passed separately on the candidate. Full `npm test`, standalone typecheck,
  and build passed. The reporter's exact content-sensitive system block is
  still unavailable, so these results do not resolve the specific
  `billing_error` replay. Leave #1094 open for that payload and a full Linux
  proxy replay; do not describe the narrower compatibility port as a complete
  billing fix.

## Follow-up review: PR #1139 (2026-09-24)

Refresh GitHub and `origin/main` before resuming this queue. The newest ready contributor
PR was reviewed first. The older Letta and draft PRs retain the dispositions below.

### Session GC lock contention #1139 → maintainer delivery #1140

- Source head `e8d1333ffbf59c93b8ddb60d9e2b3d13db99c33c` by Aaron Masover
  <amasover@gmail.com> (authored 2026-09-24 01:47:42 UTC) was cherry-picked with
  Author and AuthorDate intact as signed `340f36befbbba03df410c9342b03accae410f2eb`
  in `/tmp/meridian-pr1139-review`, branch `codex/review-1139`. The cherry-pick
  has the exact source tree. A separate signed maintainer commit
  `3b5f3ed3d10d49d18b258f5986490a6dd79f0af1` retains the existing
  `pinProvider?.() ?? pins` fallback when a GC snapshot is unavailable; the
  source-only branch threw a `TypeError` in that case, while the corrected
  branch returned a healthy `GcResult`.
- The change moves session GC reconciliation away from the lifecycle lock's
  expensive scan while retaining lock-protected state updates and pin safety.
  A synthetic 1,438-resource/810-pin case measured about 450–457 ms on the
  previous main and 6–7 ms on the candidate, with the same 810 pins. A forced
  lifecycle-lock collision in a real macOS Opus 5.5 HTTP → SDK request returned
  HTTP 503 on previous main and HTTP 200 after the fix, with the retry observed
  and zero leaked active leases. Logs:
  `/tmp/meridian-pr1139-{baseline,candidate}-bench.log`,
  `/tmp/meridian-pr1139-live-busy-{before,after}.log`, and
  `/tmp/meridian-pr1139-pin-fallback-{before,after}.log`.
- Focused lifecycle/process tests (56), typecheck, build and full `npm test`
  passed on the corrected final head. Real macOS Opus 5.5 publication E2E passed
  nonstreaming and streaming: four competing sweeps per mode deleted nothing,
  both conversations retained their fixture identifiers and source transcripts.
  The real SDK transcript pin/retire/delete gate passed; Docker boot and host
  identity gates E51/E52 passed. Real Oh My Pi 18.2.11 through Meridian on macOS
  passed transcript GC with Haiku 4.5. The Opus 5.5 Oh My Pi 18.2.11 macOS run
  encountered the same `Claude Code 2.1.141 does not support this model` error
  on unchanged main and the candidate. Native Windows 11 Oh My Pi 18.2.11 Opus
  5.5 comparison in #1139 reported six concurrent sessions taking 881 s with
  44 client-visible errors on 1.76.2 versus 86 s with zero errors on the
  branch; this is contributor evidence, not an independently repeated
  maintainer run. Logs:
  `/tmp/meridian-pr1139-final-{typecheck,build,npm-test,publication,publication-stream}.log`,
  `/tmp/meridian-pr1139-gc-sdk.log`,
  `/tmp/meridian-pr1139-gc-omp-haiku.log`, and
  `/tmp/meridian-pr1139-{e51,e52}.log`.
- Delivery [#1140](https://github.com/rynfar/meridian/pull/1140) passed all
  final-head CI including `test`, Docker, desktop and Windows smoke. After
  rechecking unchanged head `3b5f3ed3`, base `398006fe`, and green checks, it
  was squash-merged as `f30b22f9a99a73b723ced39aa1fab263a84272a8`.
  The merged tree exactly matches the validated branch; its commit credits
  Aaron as co-author. Source #1139 was rechecked at unchanged `e8d1333f`
  and closed without comment.

### Release 1.76.3 publication

- The previous tag is `meridian-v1.76.2`; the product release range contains
  #1140, plus the earlier documentation-only #1138. Release Please
  [#1141](https://github.com/rynfar/meridian/pull/1141) changes only
  `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, and
  `package.json`. It raises all root version fields to 1.76.3 and has one
  Bug Fixes entry for #1140. The bot's original `20eac8fe` head was signed
  as `8e65087996e8fd47665d928cbd39e8ff7a04f514` with the exact same
  tree and bot Author/AuthorDate; GitHub verifies the signed replacement.
- On macOS with Bun 1.3.14, Node 22.22.3, Agent SDK 0.2.141, and Claude Code
  2.1.280, frozen Bun install, full `npm test`, standalone typecheck, build,
  version consistency and diff check passed. Logs:
  `/tmp/meridian-release-1141-{npm-test,typecheck,build}.log`.
  Real Opus 5.5 publication E2E passed nonstreaming and streaming, each with
  four competing sweeps, durable mappings, preserved identifiers, and unchanged
  source transcripts. The forced lifecycle-lock collision returned HTTP 200
  with no leaked lease. Logs:
  `/tmp/meridian-release-1141-publication-opus{,-stream}.log` and
  `/tmp/meridian-release-1141-busy-opus.log`.
- A 1.76.3 tarball was packed with candidate integrity
  `sha512-OZ4zKucyQvZ3F0ReB08A4TVGVZll7vWx0uvZcfGIaei9lkHEdS9Vv+HFj8FdQ0YrVZAnv1patnbuji1i8meU8w==`.
  An independent npm install in `/tmp/meridian-release-1141-packed` reported
  CLI version 1.76.3 and passed a real Opus 5.5 fresh and resumed HTTP turn
  through its installed Node server, preserving the fixture identifier. That
  consumer resolved Agent SDK 0.2.141 and Claude Code 2.1.281. Logs:
  `/tmp/meridian-release-1141-packed-{install,live}.log`.
- All exact-head CI passed, including `test`, both Nix builds, Windows, desktop
  and Docker. After rechecking unchanged head/base, #1141 was merged with
  `--merge --match-head-commit 8e650879` as
  `df6523e953076c361c5b7ca2d5fbb50107db6190`; the merged tree exactly
  matches the validated candidate. Release Please created tag and GitHub release
  `meridian-v1.76.3` at that SHA. Publication workflow:
  [run 35959542289](https://github.com/rynfar/meridian/actions/runs/35959542289).
  All four jobs passed. The signed/notarized macOS ARM64 DMG and ZIP, checksums
  and build info are attached. The release Docker job pushed
  `ghcr.io/rynfar/meridian:1.76.3` for `linux/amd64` and `linux/arm64` at index
  digest `sha256:7a0b9e9f3155182041188f7df1bb7d1ec7e161cd0189470f77a16e6a14e0ce1c`.
  The main-branch [Docker workflow](https://github.com/rynfar/meridian/actions/runs/35959542024)
  passed and pushed `latest` for the same commit and architectures, index digest
  `sha256:e781adf9774cf8919a23a8521ea345f1f94176523e3f16a265d5a12c81635b99`.
- The npm publish job reported `+ @rynfar/meridian@1.76.3` with signed
  provenance at Sigstore index `2932371200` on 2026-09-24 05:27 UTC.
  The public registry's `latest` is 1.76.3; tarball integrity is
  `sha512-jDB06dshmgGc2XFdSnYyeBP2jOITuQ7ca25cAP/45kgy9QgzEGqGCSy7PFLFzlfZm08TTkQawQIUkM4GkqS3rQ==`
  and shasum `859c5a78414597fc42f8a3b15f738dee2f8f11bc`. The provenance
  subject's SHA-512 digest matches the registry integrity and identifies
  release commit `df6523e9` and run `35959542289`. A clean public-registry
  install in `/tmp/meridian-release-1.76.3-registry` reported CLI 1.76.3 and
  passed a real Opus 5.5 fresh and resumed HTTP turn with the fixture marker
  preserved. Its lockfile integrity matches the registry; `npm audit signatures`
  verified all 108 registry signatures and 14 attestations. Logs:
  `/tmp/meridian-release-1.76.3-registry-{install,live}.log`.
- `npm ci` on the source tree fails because the root npm lockfile still records
  Claude Code 2.1.257 while `package.json` requests `^2.1.280`, a mismatch
  inherited from #1102; the repository CI and frozen release gate use
  `bun.lock` and Bun. This did not prevent the verified public-registry install.

### Queue after publication

- Live GitHub refresh shows four open PRs: Letta source #1105 remains at
  `5f2a9a9e` and draft delivery #1113 at `52a3f914`, waiting for actual Letta
  cloud-client verification. #1050 remains draft Antigravity research; #792
  remains draft at its contributor's request. There is no newer ready PR.
- Nine issues remain open: #1094, #1073, #1068, #1011, #1009, #933, #917,
  #769, and #650. #1094's newest comment asks for a defined OpenCode v2
  compatibility goal and notes that npm's plugin `latest` still points to 1.x;
  its implementation target is not established. The prior dispositions and
  owner/client prerequisites for the other issues are recorded below. This
  release does not imply those issues are resolved.

## Follow-up review: PRs #1134 and #1133 (2026-09-23)

The previous authorized batch shipped Meridian v1.76.1. Refresh GitHub before acting on any
status here. Two newer PRs were reviewed newest first; the existing open issues and draft PRs
below retain their prior dispositions.

### Bot plugin pin #1134 → maintainer delivery #1135

- Source head `e6fb700b` (rynfar, authored 2026-09-23 10:36:41 UTC) was cherry-picked with
  Author and AuthorDate intact as signed `df695864` in `/tmp/meridian-pr1134-review`, branch
  `codex/plugin-pin-1134`. One input changed: `meridian-plugin-opencode-scrub` in `flake.lock`
  now points to `18e36c14` (published plugin v0.2.1). The source fix was previously validated
  under issue #1101 with real Meridian HTTP → SDK → Claude Max in both response modes and a
  fresh npm install; the scheduled plugin workflow `35849737110` rebuilt all plugin outputs
  with this pin.
- Local frozen install, typecheck, build, full `npm test` and diff check passed. Delivery
  [#1135](https://github.com/rynfar/meridian/pull/1135) passed final-head `test`, Nix verify
  and Ubuntu/macOS builds, desktop, Windows and container checks. The macOS Nix build and
  binary check passed before its optional cache upload took about 20 minutes. CI:
  `https://github.com/rynfar/meridian/actions/runs/35927258693` (Nix) and
  `https://github.com/rynfar/meridian/actions/runs/35927258663` (test).
- After rechecking head `df695864`, base `cce20b96`, and every check, #1135 was squash-merged
  as `2f5c0bfd64bf9aa432d11bdf27fdaa8911421b23`. The merged tree exactly matches the validated
  branch. The resulting commit credits rynfar as co-author. Original #1134 was rechecked at
  unchanged head `e6fb700b` and closed without comment.

### Contributor schema #1133 → maintainer delivery #1136

- Source head `08e8accc` (groundnuty <groundnuty@gmail.com>, authored 2026-09-23 09:51:29 UTC)
  became signed authored cherry-pick `9500fd8c`, then rebased onto merged #1135 as `8834d31f`,
  in `/tmp/meridian-pr1133-review`, branch `codex/review-1133`. Author and AuthorDate remain
  unchanged. Signed commit verification is green on GitHub. The patch advertises declared
  nested JSON Schema through the pinned Agent SDK's MCP renderer while keeping input
  validation/repair and `$` reference fallback.
- Running the contributor's three real-SDK MCP tests unchanged against `main` gave 1 pass / 2
  fail; after the cherry-pick, 3 pass. The built proxy's live Sonnet 5 nonce probe failed on
  unchanged code at both nested locations and passed on the candidate at both locations:
  `/tmp/meridian-pr1133-schema-live-before.log`, `/tmp/meridian-pr1133-schema-live-after.log`.
  A freshly installed tarball built from the PR passed the same live nonce probe
  (`/tmp/meridian-pr1133-schema-live-packed.log`); the rebased built proxy passed again
  (`/tmp/meridian-pr1133-schema-live-postrebase.log`).
- On macOS Bun 1.3.14 / Agent SDK 0.2.141 / Claude Code 2.1.280, all four live E41
  chain/parallel × stream/nonstream modes passed with Sonnet 5, plus a Pi parallel-stream
  control; logs `/tmp/meridian-pr1133-e41-*.log`. The real built-package OpenCode client gate
  passed on all pinned betas 18314/18866/19271 with Claude Haiku 4.5 and separate proxy/client
  CWD; logs `/tmp/meridian-pr1133-e42-*-core.log`. The extended beta 18314 `#xhigh` variant
  probe failed with the same `session advanced` HTTP 400 on unchanged built main and the
  candidate, after file call and continuation succeeded. Retain both failed logs
  (`/tmp/meridian-pr1133-e42-18314-extended-baseline.log`,
  `/tmp/meridian-pr1133-e42-18314.log`); do not claim that V2 variant issue is fixed.
- Local typecheck, build, and full isolated `npm test` passed (4,551 main tests plus every
  isolated segment). An earlier full run overlapped another suite and live model run and hit
  two cross-process Pi timeouts; the same 11-case file then passed in isolation, followed by
  the complete green suite. Logs: `/tmp/meridian-pr1133-test.log`,
  `/tmp/meridian-pr1133-cross-process-isolated.log`, `/tmp/meridian-pr1133-test-isolated.log`.
  No production correction was needed. After the lockfile-only rebase, 11 focused schema/input
  tests, typecheck and build passed; logs `/tmp/meridian-pr1133-postrebase-*`. Delivery
  [#1136](https://github.com/rynfar/meridian/pull/1136) on signed head `8834d31f` passed all
  final-head checks, including `test`, desktop, Windows and container. Its squash merge is
  `2922970e8c5d0657b74edddb044554239af80c63`; the merged tree exactly matches the validated
  head and credits groundnuty as co-author. Original #1133 was rechecked at unchanged head
  `08e8accc` and closed without comment.
- Open work after these two merges consists of previously reviewed draft/held PRs and issues.
  Refresh the queue before claiming it is empty.

### Release 1.76.2 publication

- Previous tag `meridian-v1.76.1` is at `cce20b96`. The product commits in the release range
  are #1135 (`2f5c0bfd`) and #1136 (`2922970e`). Release Please PR
  [#1137](https://github.com/rynfar/meridian/pull/1137) changed only
  `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, and `package.json`;
  the changelog has one Bug Fixes entry for #1136 and no duplicate chore entry. The bot's
  original candidate head `403ed493` was re-signed with the exact same tree as signed
  `d9430a7edd110c01ab08b55e578a5e55d04edf3f`, preserving bot Author and AuthorDate, to trigger
  the required PR checks.
- Local frozen install, typecheck, build, full `npm test`, release metadata consistency and
  diff checks passed on that tree. Logs `/tmp/meridian-release-1137-*.log`. The built
  candidate passed a real Sonnet 5 nested-schema tool call. Live E41 passed chain/parallel ×
  stream/nonstream with exact results, durable forks and cache continuity
  (`/tmp/meridian-release-1137-e41-*.log`). The built package passed the real beta 18314
  OpenCode client flow (`/tmp/meridian-release-1137-opencode-18314.log`).
- An independently packed 1.76.2 tarball was freshly installed; its CLI reported 1.76.2 and
  the installed proxy passed the real Sonnet nested-schema tool call
  (`/tmp/meridian-release-1137-packed-live.log`). Candidate tarball integrity is
  `sha512-SADLZ4H4QiEM602MULxohrSLx90FAUctGU0Ap2P4eFJSu9o3cCuwIsFoGsZ//GYoW3pAuZSEypgSSwHJ/yPAAw==`.
  This is candidate evidence, not registry publication.
- All final-head CI passed, including `test`, both Nix builds, desktop, Windows, and
  container. After rechecking unchanged head/base and checks, #1137 was merged with
  `--merge --match-head-commit d9430a7e` as
  `8cd3e9ee57f30df015e6a6ceea0fc544bd3842e7`. Its merged tree exactly matches the validated
  candidate. Release Please created GitHub release `meridian-v1.76.2` at that SHA on
  2026-09-23 23:10:12 UTC. The publication workflow is
  [run 35932196039](https://github.com/rynfar/meridian/actions/runs/35932196039).
- The publication workflow's Docker job pushed `ghcr.io/rynfar/meridian:1.76.2` with
  `linux/amd64` and `linux/arm64` manifests (index digest
  `sha256:9fffe485041b730d5faba464be56cf7c1383071955e798dde787bac6ab237424`). The
  separate main-branch [Docker workflow](https://github.com/rynfar/meridian/actions/runs/35932195787)
  passed and pushed `latest` for the same release commit, with both architectures and index
  digest `sha256:2be03d3f603cb5373ea09dab011287a3f2e0ddec264eeec6f66d3a602f765a83`.
  The desktop job passed and attached the signed/notarized 1.76.2 macOS ARM64 DMG and ZIP,
  checksums, and build info to the GitHub release. All four release workflow jobs passed.
- The npm publish job reported `+ @rynfar/meridian@1.76.2` and published signed provenance to
  Sigstore index `2927534032` at 2026-09-23 23:16 UTC. After npm's processing delay, registry
  `latest` became 1.76.2. Its tarball integrity is
  `sha512-FXkpUwBZUlVfwrAGjXTvNxnshhXnWNwaLQcePo+JT5XUKU9iUzfuQa3Otf7ED/VxTxROo3QSo9kigbtf+tDZAQ==`,
  shasum `bbfd12a2c349ef6142e32611b95baf5727726c15`. Registry provenance identifies
  `pkg:npm/%40rynfar/meridian@1.76.2`, the same SHA-512 digest, release commit
  `8cd3e9ee57f30df015e6a6ceea0fc544bd3842e7`, and workflow run `35932196039`.
- A clean install from the public registry in `/tmp/meridian-release-1.76.2-registry` reported
  CLI version 1.76.2. Its installed proxy passed the real Sonnet 5 nested-schema nonce flow:
  HTTP 200, one `report` call, and exact object-field and array-item values. Log:
  `/tmp/meridian-release-1.76.2-registry-live.log`. Publication is complete; no manual
  versioning, tag push or npm publish was used.

### Queue after publication

- Refreshed live GitHub status after release: four open PRs, all with previously reviewed
  dispositions. Letta source #1105 is unchanged at `5f2a9a9e`; delivery #1113 is still draft
  at `52a3f914`, waiting for actual Letta cloud-client verification. #1050 remains draft
  Antigravity research; #792 remains draft at the contributor's request. No newer ready PR
  is waiting for review.
- Nine issues remain open: #1094, #1073, #1068, #1011, #1009, #933, #917, #769, and #650.
  Their previously reviewed holds and owner/client prerequisites are recorded below. This
  queue is not empty and no unsupported closure is implied by the 1.76.2 release.

## Active review batch (2026-09-23)

The owner asked for PR review first, newest issues next, author-preserving
cherry-picks, validation before merge, and an authorized release after the
autonomous queue is as far along as it can get. Refresh live GitHub state and
`origin/main` before continuing; this section is a checkpoint, not a claim that
the queue is complete. This batch has one owner and no delegated agents.

### #1104 incorporated as #1108: Profiles page script

- Source head `3af1a952` (Nowaker) became authored cherry-pick `7040f8e6`
  (Author and AuthorDate preserved) on `fix/profile-page-script-1104`.
  Delivery [#1108](https://github.com/rynfar/meridian/pull/1108) merged to main
  as `6b25c5a1`; source #1104 was rechecked and closed without comment.
- The fix closes the missing `renderSpentNote` brace, repairs the nested quote
  escaping, and adds a five-page inline-script parse test. The new test passed
  5/5; typecheck, build, full `npm test` and final-head CI `test` passed.
  CI: `https://github.com/rynfar/meridian/actions/runs/35825319080`.
- Live shared-browser check on macOS served `/profiles` from an isolated local
  proxy: the page reached the "No profiles configured" state rather than
  staying blank. With a sample profile rendered through the page's own script,
  the Rename button opened a focused input with Save/Cancel controls; Cancel
  restored the card. This exercises the repaired inline script and markup,
  but does not claim a backend profile rename or OAuth flow was exercised.

### #1106 accepted with a maintainer comment as #1110: OpenAI tool-loop identity

- Source head `6cbdae64` (Chris Wilson), base main `6b25c5a1`. All ten source
  commits were cherry-picked with Author and AuthorDate preserved onto
  `fix/openai-tool-loop-1106`. Source-to-incorporated abbreviated SHA mapping,
  in order: `208ce890→1b0892f7`, `9be41c40→2ac19c6a`,
  `d91447bd→8a80c0b1`, `7ec5024f→5b975c0c`, `992dce3a→01d1de99`,
  `9b149295→6446ad01`, `8059e07a→d7bcfaf0`, `fa18b475→d4eb5457`,
  `b1ce70aa→6b425810`, `6cbdae64→0fcf2137`. Maintainer marker
  `f8e197a8` is separate. Delivery [#1110](https://github.com/rynfar/meridian/pull/1110)
  merged as `73d98d14` with authored commits intact; source #1106 was rechecked
  at the same head and closed without comment.
- Focused tests 70/70, typecheck and build passed. First full `npm test` run
  failed two unrelated Polytoken concurrency/multimodal cases; both passed
  together in isolation (15/15), then the second full command passed. Treat
  the initial run as unresolved suite instability under #933/#917, not a fix.
- Live E58 on macOS, Bun 1.3.14, Agent SDK 0.2.141, Claude Code 2.1.280,
  Haiku 4.5 passed after unsetting this shell's local `MERIDIAN_API_KEY` only
  for the isolated probe. Turns 3–5 resumed with 96/97/99% cached input and
  two unsettled checkpoints preferred continuation; the unkeyed control had
  no cache reads. The first attempt returned 401 at the local auth gate and
  supplied no model evidence. Live E41 with Sonnet 5 passed all four
  sequential/parallel × stream/non-stream modes, including exact results,
  durable forks and cache continuity. Local logs:
  `/tmp/meridian-1106-e58-authless.log` and `/tmp/meridian-1106-e41-*.log`.
- The first delivery CI `test` run (`35827093158`) failed two assertions that
  captured debug events through the process-global logger mock, even though
  the same tests' direct SDK resume/replay assertions passed. The logger mock
  is documented as susceptible to load-order races (#917). A separate
  maintainer test correction removes those log-capture assertions and keeps
  the direct SDK decisions as the behavioral regression gate; no production
  branch or telemetry call changed. Corrected final head `6b355328` passed
  local full tests, typecheck, build and all relevant CI jobs (CI run
  `35828305778`, Docker `35828305721`, desktop `35828305756`).

### #1105 held as draft #1113; #1100 incorporated as #1111

- #1105 source `5f2a9a9e` (Chris Wilson) was cherry-picked as ten authored
  commits on `/tmp/meridian-letta-1105`, branch `codex/letta-identity-1105`.
  On current main, the first authored cherry-pick is `b30fc617`; maintainer
  commits `15c01ba5` remove prohibited casts and guard malformed Letta bodies,
  and `52a3f914` requires the label inside a system reminder. Delivery
  [#1113](https://github.com/rynfar/meridian/pull/1113) is draft. Rebasing
  preserved both Letta and OpenAI identity documentation. Focused 69/69,
  typecheck, build, full `npm test`, and every CI check on the draft head
  passed (`35830427471`, Docker `35830427507`, desktop `35830427622`). Actual Letta Code
  0.32.18 local backend requests use `local-conv-*`, not the `conv-<uuid>`
  reminder path being fixed. A cloud backend connect returned 401; the real
  affected-client acceptance gate remains unavailable. E57's wire-shape
  probe must not be presented as Letta binary evidence. Hold merge and source
  closure until the client gate is satisfied.
- #1100 source `0823b361` (Guy Addadi) was cherry-picked to
  `/tmp/meridian-cwd-1100`, branch `codex/cwd-no-client-1100`, and rebased onto
  `73d98d14` as `72dbaab4` (author and AuthorDate intact). Maintainer test
  commit `cad81819` proves an HTTP bare Pi request keeps the proxy fallback
  out of the client CWD claim and moves a misplaced JSDoc to its function.
  Current main's `buildCwdNote` returns an empty addendum for that case;
  corrected focused 123/123 and typecheck/build pass. Live macOS/Bun 1.3.14,
  SDK 0.2.141, Claude Code 2.1.280, Haiku 4.5 E2E passed Pi client-path
  controls in both response modes and bare no-CWD Pi in both modes (real SDK
  query observer and model response). Logs `/tmp/meridian-1100-e2e-pi.log` and
  `/tmp/meridian-1100-e2e-no-cwd.log`. Full `npm test` exited 0; all four
  distinct E41 modes passed, including an explicit parallel+stream rerun after
  a shell argument grouping mistake. Logs `/tmp/meridian-1100-e41-*.log`.
  All three pinned OpenCode V2 betas (`18314`, `18866`, `19271`) passed extended
  live E42 with separate proxy CWD; logs `/tmp/meridian-1100-e42*.log`.
  Delivery [#1111](https://github.com/rynfar/meridian/pull/1111) passed all
  final-head CI jobs (`35829422423`, Docker `35829422455`, desktop
  `35829422393`), merged as `bfede92b` with Guy's authored commit intact;
  unchanged source #1100 was closed without comment.

### #1097 incorporated as #1115; #1112 incorporated as #1117

- #1097 source `73ba641a` (Guy Addadi) was cherry-picked as authored commit
  `d81be56b` onto `/tmp/meridian-systemd-1097`, branch
  `codex/systemd-1097`. Separate maintainer commits `9dbb3b82` and
  `7e0dadfd` make numeric parsing strict, reset the idle clock on completed
  model HTTP requests, clear the timer on manual close, add the E59 process
  gate and document Node/systemd use. Focused 13/13, typecheck and build pass.
  E59 passed with an inherited fd and real Haiku response on macOS Node
  22.22.3 (`/tmp/meridian-1097-macos-live.log`); Linux Node 24.20.0 passed
  fd adoption, idle exit and reactivation without a model call
  (`/tmp/meridian-1097-linux.log`). The first Linux attempt failed solely
  because the minimal container lacked `/etc/machine-id`; a generated
  container-local ID enabled the successful rerun. Full `npm test` and all
  final-head CI passed (`35830800049`, Docker `35830799848`, desktop
  `35830799897`). Delivery [#1115](https://github.com/rynfar/meridian/pull/1115)
  merged as `79e14d7f` with Guy's authored commit intact; unchanged source
  #1097 was closed without comment.
- #1112 source `b5c485a8` (Nowaker) was cherry-picked onto
  `/tmp/meridian-gc-1112`, branch `codex/session-gc-lock-1112`. On current
  main the authored commit is `7d809138`; maintainer test correction is
  `98db8278`. Focused 43/43 and typecheck/build pass. On unchanged
  main, the source's sampling-based candidate-reuse test passed despite the
  old implementation; its FIFO test failed with `late, early`, whereas the
  cherry-picked code passes. The maintainer correction replaces the sampling
  test with a direct candidate lifetime assertion. Full `npm test` exited 0
  before rebasing onto #1115. Real E2E publication lifetime passed both
  nonstream and stream on that base,
  preserving markers, sources and zero unsafe deletions; logs
  `/tmp/meridian-1112-publication*.log`. Delivery
  [#1117](https://github.com/rynfar/meridian/pull/1117) merged as `a3640f0d`
  with Nowaker's authored cherry-pick intact; unchanged source #1112 was
  closed without comment. After the
  #1115 rebase, focused 43/43, typecheck/build and both real publication E2E
  modes passed again (`/tmp/meridian-1112-publication*-rebase.log`). Full
  final-head CI passed (`35831709077`, Docker `35831709065`, desktop
  `35831709066`).

### Issue #1107: fresh replay tool names

- On unchanged main, a real HTTP regression reproduced a fresh Pi replay
  containing the bare historical names `bash` and `mcp__oc__read`; the SDK
  registers prefixed aliases. The first baseline test run unexpectedly passed
  under shared process mocks, but an instrumented rerun and a clean rerun
  both failed as expected (`/tmp/meridian-1107-before.log`).
- Branch `fix/replay-tool-names-1107` renders historical calls with the same
  aliases used for current MCP registration, including collision handling,
  and threads the renderer through text and structured fresh replay and
  resume-fallback paths. Ordinary non-passthrough flattening is unchanged.
  Focused 34/34, typecheck, build and full `npm test` passed before rebase.
  Real Opus 5.5 E60 passed nonstream and stream, returning a new `bash` call
  after twelve old calls; existing Haiku replay-history control passed both
  modes. Logs `/tmp/meridian-1107-opus-live*.log` and
  `/tmp/meridian-1107-replay-control*.log`. After rebasing onto #1117,
  focused 34/34, typecheck/build, all four live E41 modes, and both live
  Opus E60 modes passed again. E41 logs are
  `/tmp/meridian-1107-e41-*.log`; E60 logs are
  `/tmp/meridian-1107-e60-*.log`. The real E43 namespaced-tool control
  also passed in both response modes (`/tmp/meridian-1107-e43-*.log`).
  Full final-head `npm test` and all CI passed (`35832749521`, Docker
  `35832749546`, desktop `35832749543`). Delivery
  [#1120](https://github.com/rynfar/meridian/pull/1120) merged as
  `253c0fcc`; issue #1107 closed automatically.

### Issue #1101: client-side OpenCode scrub drops cwd

- The exported scrub function in companion repository
  `rynfar/meridian-plugin-opencode-scrub` removed the entire duplicate
  `<env>` block before Meridian could extract the client's working directory.
  On unchanged plugin code, three new regression assertions failed. PR
  [#13](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/13)
  retains a bare `Working directory` field without the duplicate preamble or
  other fields; all 17 tests and build passed, as did final-head CI. A real
  Meridian HTTP → SDK → Claude Max check using the built scrub package passed
  both response modes with SDK `cwd` equal to the client project, distinct
  from the proxy directory (`/tmp/meridian-1101-live.log`).
- The plugin's Release Please [#7](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/7)
  was updated to include the fix. Its duplicate merge-commit changelog entry
  was removed in a separate maintainer commit; the exact release diff has
  three distinct fixes, version `0.2.1`, and a passing build/test/pack gate.
  The release workflow `35833345705` published the tagged GitHub release and
  npm package with provenance. Registry `latest` and version are `0.2.1`,
  integrity is `sha512-DOLXcZzuH0dXmL3i+2ENIc/x7WTLC0rmOJ757z5nZGIbxmNIVOhUWgmvamWK+ivklvDUPApqy1D+Emfc9/slTQ==`.
  A fresh registry install executed the exported scrub and preserved the cwd.
  Issue #1101 is closed.

### Issue #1098: unstreamed SDK fallback delivered

- Source illustration [#1099](https://github.com/rynfar/meridian/pull/1099)
  head `7043fa93` (Magnus Schmidt Rasmussen) is cherry-picked as authored
  commit `7137eb71` onto `fix/unstreamed-fallback-1098`. The source explicitly
  asks not to merge its draft as-is; maintainer corrections and gates are
  separate. An actual SDK/CLI request with a local API fixture reproduced
  unchanged main's HTTP 200 with no `message_start`, despite Claude Code's
  successful nonstreaming retry (`/tmp/meridian-1098-e2e-before.log`). The
  cherry-picked code plus corrections passed the same fixture's text, client
  tool-call and normal-stream controls (`/tmp/meridian-1098-e2e-corrected.log`).
  New HTTP tests exercise assistant-only turns; a pure helper and direct tests
  preserve thinking blocks for clients that support them. Focused 14/14 and
  typecheck/build pass. The unchanged-main streaming control also passed;
  all 14 real-SDK local-fixture capped-turn cases passed, and live E41 passed
  all four chain/parallel × plain/stream modes. Logs:
  `/tmp/meridian-1098-capped-*.log` and `/tmp/meridian-1098-e41-*.log`.
  Full `npm test` and all final-head CI passed (`35834431194`, Docker
  `35834431188`, desktop `35834431167`). Delivery
  [#1121](https://github.com/rynfar/meridian/pull/1121) merged as `31d8560f`
  with Magnus's authored commit intact. Issue #1098 closed automatically;
  unchanged source illustration #1099 was closed without comment.

### Issue #1095: single-step abort delivered

- Source illustration [#1096](https://github.com/rynfar/meridian/pull/1096)
  head `38bc082f` (Magnus Schmidt Rasmussen) was cherry-picked with Author
  and AuthorDate intact as `a012b4f7` onto `fix/single-step-abort-1095`.
  The source explicitly
  asked not to merge as-is. A new HTTP regression makes a self-aborted SDK
  iterator complete normally. It fails on unchanged main with a client error
  and passes with a separate cause-aware correction; source wording alone
  still failed because an earlier durability guard can throw a cancellation
  error before the final-envelope guard. Baseline log:
  `/tmp/meridian-1095-before.log`.
- The real SDK/CLI E62 local fixture passed a repeated same-tool call on both
  unchanged main and the fix. It checks the surrounding delivery contract but
  does not force the normal-completion abort timing. Focused HTTP and error tests
  passed 233/233; typecheck and build passed. Live E41 passed all four
  chain/parallel by stream/non-stream modes. E34 delivered three intact
  parallel tool batches, but its separate #742 intermittent race did not occur
  in three attempts, so that race gate is inconclusive for #742. Full `npm test`
  and all final-head CI jobs passed (`35835762270`, desktop `35835762260`,
  Docker `35835762353`). Delivery
  [#1122](https://github.com/rynfar/meridian/pull/1122) merged as `71495332`
  with Magnus's authored commit intact. Issue #1095 closed automatically;
  unchanged source #1096 was closed without comment.

### PR #1119: implicit attachment suppression delivered

- Source head `8a7aec9c` (Nowaker) was cherry-picked with Author and
  AuthorDate intact. Its AI attribution lines were removed from the copied
  commit message to match project format; the implementation is unchanged.
  On `fix/implicit-attachments-1119` rebased onto #1122, the authored commit
  is `5dae08e4`.
- The credential-free real CLI probe passed native expansion, passthrough
  suppression, resume, fork, exact explicit media, and inherited opt-out.
  Its negative control failed at the expected canary assertion. Focused query
  tests passed 92/92; full `npm test`, typecheck, build, and live E53 all
  passed before rebase. E41 passed all four chain/parallel by stream modes.
  After rebase, focused query/abort tests passed 108/108 and the real CLI
  probe passed again. All final-head CI jobs passed (`35836546338`, desktop
  `35836546319`, Docker `35836546387`). Delivery
  [#1123](https://github.com/rynfar/meridian/pull/1123) merged as `25a46612`
  with Nowaker's authored commit intact; unchanged source #1119 was closed
  without comment.

### PR #1118: Pi trailing reminder checkpoint delivered

- Source commits `7f3ecf48` and `756c3037` (Mate Remias) were cherry-picked
  with Author and AuthorDate intact. Rebased onto #1123 as `885791ab` and
  `6f92793e` on `fix/pi-trailing-reminder-1118`.
- Focused passthrough tests passed 159/159 before rebase and 175/175 after
  #1095 landed. Live Pi E2E passed plain and streaming checkpoint resumes;
  a revised-history streaming image case fresh-replayed with the reminder and
  image result intact. Typecheck, build, and full `npm test` passed on #1122.
  After rebase onto #1123, focused tests passed 175/175 and live Pi streaming
  resume passed again. All final-head CI jobs passed (`35837311983`, desktop
  `35837311976`, Docker `35837312005`). Delivery
  [#1124](https://github.com/rynfar/meridian/pull/1124) merged as `bace62f9`
  with Mate's authored commits intact. Source #1118 added an empty CI-retry
  commit `893348c8` without file changes; after recheck it was closed without
  comment.

### PR #1116 and follow-up #1126: CLI-rejected client tools delivered

- Source `f501cf9d` (Mate Remias) was cherry-picked with Author and AuthorDate
  intact as `14a47c34` onto `fix/rejected-tools-1116`, rebased through #1124.
  Its copied headline was normalized to `fix:` for this repository. Separate
  maintainer commit `d1420779` adds E63, a credential-free real SDK/CLI gate
  in Linux CI.
- E63's bare `read` refusal fails on unchanged #1122 main with an SSE API
  error after `max_tokens`; it passes with #1116 as one complete `tool_use`
  handoff. The registered-name control passes before and after. Focused
  tests passed 125/125 before rebase; full `npm test`, typecheck and build
  passed on #1122. After rebase onto #1124, focused tests passed 137/137,
  both real SDK/CLI E63 cases passed, and E41 passed all four
  chain/parallel by stream modes. Final-head Linux test, Windows smoke,
  desktop and Docker checks passed (`35838259252`, `35838259244`,
  `35838259072`). Delivery [#1125](https://github.com/rynfar/meridian/pull/1125)
  merged as `ec7c9c39` with Mate's authored commit intact.
- The source added a follow-up commit after #1125 merged. Commit `8bce3b4d`
  and #1126's extra assertion `7d02c432` were cherry-picked with Author and
  AuthorDate intact as `c6b0bc54` and `0a502cc5` on
  `fix/rejected-tools-continuation-1116`. The #1120 tool-selection move made
  one cherry-pick conflict; tool restoration was placed before the fresh
  replay renderer so the replay and MCP registration see the same schema.
  A separate maintainer commit runs the real SDK/CLI refusal-to-result-turn
  fixture in Linux CI. The fixture failed on #1125 main and passed on the
  follow-up, including a fresh SDK session, omitted client tools, and the
  registered MCP name in replay. Focused integration 104/104, full
  `npm test`, typecheck, build, E63 controls, and live Pi parallel streaming
  E41 all passed. Final-head Linux, Windows, desktop and Docker checks passed
  (`35839354306`, `35839354302`, `35839354294`). Delivery
  [#1127](https://github.com/rynfar/meridian/pull/1127) merged as `438b2bf9`;
  unchanged source #1116 and follow-up #1126 were closed without comment.

### PR #1114: preserve in-flight profile turns delivered

- Source head `464c3c87` (Nowaker) is cherry-picked as `6ecfbaa7` with Author
  and AuthorDate intact on `fix/profile-switch-inflight-1114`; the copied
  headline was normalized to `fix:`. The source's HTTP fixture reproduced
  the in-flight failure on unchanged #1122 main in both response modes.
  The fix removes the global session-cache clear during profile switching;
  existing profile-scoped keys keep the mappings isolated. A separate
  maintainer test checks another profile's durable resume state. Focused
  17/17, full `npm test`, typecheck and build passed on the final branch.
  Final-head Linux, Windows, desktop and Docker checks passed
  (`35840110191`, `35840110130`, `35840110184`). Delivery
  [#1128](https://github.com/rynfar/meridian/pull/1128) merged as `69bcf6de`
  with Nowaker's authored commit intact; unchanged source #1114 was closed
  without comment.

### Issue #1089: client summary compaction replay under review

- The old suffix-overlap classifier resumed the stored SDK session after a
  client replaced a long head with a short summary. A new pure-lineage
  regression fails on unchanged main; the real SDK/CLI E64 local fixture
  confirms the summary never reached the model on #1124. The correction
  fresh-replays only a shortened head, keeps equal-length pruning on the
  existing checkpoint, and has explicit legacy opt-in
  `MERIDIAN_COMPACTION_SURVIVAL=1`. The lineage helper remains pure.
- Focused lineage/HTTP tests passed 180/180, full `npm test`, typecheck and
  build passed before the latest rebases. After #1127, focused 110/110 and
  both real SDK/CLI E64 modes passed: default delivered the summary and
  omitted the removed head; legacy resumed. E64 runs both modes in Linux CI.
  Delivery [#1129](https://github.com/rynfar/meridian/pull/1129) is open;
  final-head validation after #1128 remains. Its first final-head Linux CI
  run passed the full main test pass but failed one of 73 isolated priority
  tests: a fixed 5s quota reset expired during the test's own retry ladder,
  causing the 10-minute fallback mark. This is unrelated to compaction and
  reproduced only under that runner's timing. A separate test correction
  shortens the mock retry delay and waits until the recorded reset rather
  than sleeping 3.6s; all three affected cases and the entire 73-case
  priority file pass locally. The corrected CI rerun remains.

### Issue #1094: stable OpenCode V2 compatibility hold

- [Official OpenCode V2 installation](https://opencode.ai/v2/docs) now uses
  `@opencode/cli`; npm `latest` was 2.0.15
  when checked September 23. The isolated binary reports `opencode v2.0.15`.
  Current Meridian setup correctly rejects it and leaves the beta-only
  plugin uninstalled (`/tmp/meridian-1094-setup.log`). The plugin imports
  `@opencode-ai/plugin/promise`, while the
  [stable V2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
  requires `@opencode/plugin` and a changed setup/hook API. Unpinning the
  version gate alone would load
  an incompatible plugin. Leave #1094 open for a port and full E42-style host
  qualification; do not claim stable V2 support in this release.
- #1050 is Antigravity research with no production
  behavior. #792 explicitly asks not to be reviewed or merged yet.
- The Release Please PR remains open until the issue pass and all affected
  flow gates are complete.

## Delivered: Review and Autonomous Processing Batch (2026-09-19)

### PR #1060 (Issue #1027): OpenCode V2 beta-19271 Qualification
- Base: `d8516bea`
- Delivery PR: [#1060](https://github.com/rynfar/meridian/pull/1060), merged as `303ce0d0`.
- Problem: `@opencode-ai/cli@0.0.0-beta-19271` was published upstream, and Meridian's `SUPPORTED_OPENCODE_V2_VERSIONS` only accepted `beta-18314` and `beta-18866`.
- Fix: Qualified `0.0.0-beta-19271` in `SUPPORTED_OPENCODE_V2_VERSIONS`, updated test assertions in `scripts/e2e-opencode-v2-package.mjs` and `scripts/e2e-idle-stall-clients.mjs`, and documented OpenCode V2 host qualification policy in `docs/agents.md`.
- Validation:
  - Real offline package E42 gate: PASSED.
  - Real extended live E42 gate (`bun scripts/e2e-opencode-v2-package.mjs --live --extended --separate-proxy-cwd`): PASSED.
  - Full test suite (`npm test`) 100% pass across 76 suites.
  - CI: all 6 workflows green. Issue #1027 closed.

### PR #1061 (Contributor PR #771): Profile Login Unknown ID Auto-Creation
- Base: `303ce0d0`
- Contributor PR: [#771](https://github.com/rynfar/meridian/pull/771) by @Nowaker (`19cf472a8380e5c814fd05d6d14b091c172b1994`).
- Delivery PR: [#1061](https://github.com/rynfar/meridian/pull/1061), merged as `96a75ac5`.
- Problem: `meridian profile login <id>` exited with code 1 if `<id>` was unknown, forcing a separate `meridian profile add` invocation for the same user intent.
- Fix: Cherry-picked contributor commit preserving author and date. Extracted pure `isValidProfileId` and `planProfileLogin` decision helper in `src/proxy/profileCli.ts`. When an unknown ID is provided, warns with standard yellow warning notice and invokes `profileAdd(id, options)` to create and authenticate the profile. Path traversal attempts are rejected before touching disk.
- Validation:
  - Unit tests: `bun test src/__tests__/profile-login-plan.test.ts` (8/8 pass).
  - Production build: `bun run build` and `npm run typecheck` clean.
  - Full test suite: `npm test` 100% pass.
  - CI: all 6 workflows green. PR #771 closed.

### PR #1062 (PR #765): Plugin Flake Inputs Update
- Base: `96a75ac5`
- Contributor PR: [#765](https://github.com/rynfar/meridian/pull/765) (`ce320144ed2034c92669094bc108dcc58fb581e7`).
- Delivery PR: [#1062](https://github.com/rynfar/meridian/pull/1062), merged as `865b8331`.
- Problem: Nix `flake.lock` had outdated revisions for `meridian-plugin-hermes-scrub`, `meridian-plugin-opencode-scrub`, and `meridian-plugin-pi-scrub`.
- Fix: Cherry-picked updated flake revisions.
- Validation:
  - Nix CI workflows (`build (macos-latest)`, `build (ubuntu-latest)`, `verify`) and all main repository CI workflows passed. PR #765 closed.

## Delivered: Claude Code Headless Concurrent Turns #1043 (2026-09-18)

- Base: `75d0c507` (incorporation of contributor PR #1048 as #1055).
- Worktree: `/Users/rynfar/repos/meridian/.claude/worktrees/claude-code-headless`, branch `fix/claude-code-headless-concurrency`.
- Problem: Claude Code CLI in headless mode (`claude -p "..."`) fires a session-start side request (`tools=0`, single user message) and the primary prompt (`tools=24`, message count 2) concurrently under the same session ID in `metadata.user_id: {"session_id": "..."}`. Meridian serialized both turns via the turn lease, but when the second turn acquired the lease after the first committed, `lostRaceWhileWaiting` fired and rejected the turn with HTTP 400 "This session advanced while the request was waiting" because Claude Code has no per-flow plugin headers.
- Fix: Set `runsConcurrentTurnsPerSessionKey: true` on `claudeCodeAdapter` in `src/proxy/adapters/claudecode.ts`. This activates `declaresConcurrentFlow`, allowing the loser of the race to be safely admitted as a fresh replay while preserving serialized turn execution (`maxActiveQueries: 1`).
- Verification:
  - Unit test in `src/__tests__/claude-code-adapter.test.ts`.
  - Concurrency test in `src/__tests__/proxy-concurrency-coordination.test.ts`.
  - Real Claude Code 2.1.277 live CLI execution in headless mode (`claude -p "Reply with OK"`) confirming 0 turn conflicts and clean exit code 0.
  - Full test suite (1243 tests) and typecheck pass cleanly.

## Current bounded work: Windows GC #896 (2026-09-14)

This entry supersedes the historical "nothing is in progress" statements below
for **#896 only**. The owner requested native Windows review, then authorized
fixing the Bun/Volta failure found in that review. Disposition: accept with the
correction implemented; hold integration pending the Pi live gate and final CI.
No release, community comment, original-PR closure, or unrelated backlog work
is authorized by this task.

- Base: `1d7544b6`; source PR head: `7fe1acaf9a9ab34f7d76ee4d9360a9f69ce24eb6`.
- Worktree: `/tmp/meridian-windows-gc-fix`, branch `codex/windows-session-gc`.
- Author-preserving cherry-picks (Aaron Masover, `amasover@gmail.com`):
  `4b712fd` → `0b7b985`, `defdad3` → `8d58432`, `7fe1aca` → `acd19f4`.
  The CI conflict preserved both the existing CWD checks and the added GC job;
  the resulting contributor tree exactly matched the reviewed PR head.
- Maintainer correction resolves the actual Node executable under Bun with a
  bounded single-line probe, caches successful resolution, and launches that
  binary directly. This avoids Volta's multiline eval corruption and fences
  the actual executor PID. The new regression asserts both multiline execution
  and exact child/executor PID equality.
- Native Windows 11 26200.8037, Bun 1.3.11, Node 24.18.0, SDK 0.2.141,
  Claude Code 2.1.259. Original main reproduces backlog-full; uncorrected PR
  with normal Volta PATH fails 4/5 GC tests; corrected normal PATH passes 6/6.
  Windows typecheck and build pass. Linux `npm test` (with pretest typecheck)
  passes 3950 tests, 0 failures, 1 skip; build passes.
- Real SDK creation/pin/deletion gate passes on Windows with the corrected
  code, including `result.is_error === false`. The temporary before/after
  probe also observed main defer a real transcript and corrected GC delete it.
  Directory-less exact-ID SDK inspection is intentional: project-scoped reads
  failed to find the Windows transcript while supported exact-ID lookup found
  it. No private transcript files were inspected.
- The initial live request failures were due to Windows' inherited
  `ANTHROPIC_BASE_URL`; it was removed only in disposable test processes.
  Actual Pi 0.73.1 through the isolated proxy reaches the Pi adapter but the
  upstream returns HTTP 400, "You're out of extra usage." This is a failed
  acceptance gate, not a GC success or a demonstrated GC defect. No quota or
  billing settings were changed.
- An initial diagnostic accepted SDK subtype `success` alone. That can mask
  `is_error:true`; the committed gate now rejects it. The stricter direct-SDK
  gate passed; the Pi gate remains blocked by the explicit API refusal.
- Reproducible live gate: `scripts/e2e-windows-session-gc.mjs`, documented in
  `E2E.md`, optionally with `PI_CLI_PATH` for the actual client. Raw logs:
  `/home/trevorwalker/.local/share/meridian-reviews/pr-896/` and Windows temp
  `meridian-pr896-fix`. A separate broader Windows suite hit preexisting POSIX
  mode expectations and a Bun crash; it is not counted as a pass (see prior
  review record).

Next: consult the integration PR linked to #896 for final-head CI, rerun the
actual Pi gate when the upstream account accepts requests, then assess merge.
Do not infer permission to release. The original contributor PR remains open.

Checkpoint: 2026-09-11, after publishing Meridian 1.70.0 and then 1.71.0,
repairing the E42 gate (#1014), closing the V2 cold-start gap (#1008), landing
two of the three #980 splits (#1011, #1009), and triaging #1024 to
configuration.
Refresh
GitHub and origin/main before continuing; this is a dated checkpoint, not a
live queue.
The owner requested portable skills and agent instructions so either Claude,
Codex, or another repository agent can resume this work.

## Read first

Follow [meridian-upstream-review](../../.agents/skills/meridian-upstream-review/SKILL.md)
and [AGENTS.md](../../AGENTS.md). The last delivered item is contributor PR
#1005, incorporated as #1012 and merged as `c3dc2279`. Before that: #980 as
#1010 (`3db622fa`), #1003 as #1004 (`7028c697`), issue #820
(PRs #994 and #995), the OpenCode V1 plugin packaging fix (#988) and a
race-harness deflake (#997), plus #996 — a regression in our own #983, found
while validating #820 and fixed in #998.

The last delivered items are the **#980 splits**: abort-cause diagnostics
(#1022, `0fd59403`) and uncaptured-tool recovery (#1025, `d8516bea`, off by
default). Before them: #1008 (#1018, `52b581b6`), #1014 (#1016, `1519f8d8`) and
the probe-discipline rules in #1019 (`619bbe70`).

**Nothing is in progress.** Held by explicit owner decision: the third #980
split, `fix: recover visible empty capped streams` — see #1011. Still open for a
canary and a live gate: #1009.

**1.71.1 is published**, authorized explicitly by the owner: tag `ea5e9845`,
npm `latest`, provenance `gitCommit` equal to the tag commit, Docker on both
architectures, and the published artifact driven from the registry. It carries
the #1024 fix the reporter was waiting on.

**Unreleased on `main`:** the typecheck hook (#1035) and the session bookkeeping
incorporation (#1036). A release needs its own explicit authorization.

**1.70.0 is published.** The owner authorized it explicitly; PR #1006 was merged
as `0acf3b19` and the publication is verified below — npm, provenance by
content, Docker and a registry-install run of the real client flow. Nothing is
in progress and nothing is held. A future release still needs its own explicit
authorization — this one does not carry forward. 1.69.0's section has been
demoted to "Previous checkpoint"; do not republish either.

An earlier version of this block said PR #977 was "green on everything and
held for owner review". That was already stale when it was written: #977 merged
at 2026-09-09T03:18Z as `03fe5716` and appears in #970's changelog. The claim
was carried forward from the previous checkpoint without being rechecked, which
is the specific failure the "Read first" instruction above warns about — refresh
live GitHub state, do not trust the dated text.

Continue when the owner asks; this document does not start background work or
authorize two agents to work the same queue. A prior agent's
paused/blocked goal is not a claim that the backlog is complete.

Keep this checkpoint current after a delivered ticket or meaningful pause.
Record the item, disposition, original/delivery/base SHAs, author mapping,
worktree/branch, before/after proof, tests and E2E versions, CI URLs, merge and
closure status, limitations, and the exact next action. Put portable evidence in
the PR or linked review record; optional private local logs are not prerequisites
for discovering the workflow. Never invent test evidence if those logs are absent.

## Standing instruction, 2026-09-10: file a ticket

The owner asked that anything flagged as a real problem needing a fix becomes a
GitHub issue, not a line in a PR body or a doc: "i cant keep up with all of
this." Applied retroactively to the V2 cold-start race as #1008. Observations
that need no fix stay observations; a "known limitation" note is not a ticket.

Tickets opened under this instruction so far: #1008 (V2 cold-start race),
#1009 (deferred uncaptured-tool recovery), #1011 (the held passthrough
commits on `codex/polytoken-extras`), #1014 (the E42 gate's exit code and its
missing discovery coverage), #1027 (supported V2 betas have drifted, and #1023's
version does not exist) and #1028 (E42 can exit 1 after PASS when a straggler
hits the fixture during teardown). All six came out of validation runs, not
from reading code.

## Completed checkpoint: Meridian 1.71.0

[Meridian 1.71.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.71.0)
shipped through [release PR #1020](https://github.com/rynfar/meridian/pull/1020),
authorized explicitly by the owner. **Published and installed-package
validated.** Do not republish it.

| | |
|---|---|
| Candidate tree | `a6ae7050` (parent `d8516bea`), all four checks green after approval |
| Release/tag commit | `60722ad95983e0518d60378b5e0fdcce89b1e765` |
| npm | `1.71.0`, `latest` → `1.71.0` |
| Tarball integrity | `sha512-ugp+7bC9e0owstbxr7rnda3/8vlSc1iWRrGbXNDeS8u3B+FjtzC1juLpnyTTxnYPDOapQ8WlU25c3j4iYLBH6A==` |
| SLSA provenance | `gitCommit: 60722ad9…` equals the tag commit; workflow `release-please.yml` |
| Docker | `1.71.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release on `60722ad9` | CI, Release Please, Docker — success |

Changelog: `feat` abort-cause diagnostics (#1022) and uncaptured-tool recovery
(#1025); `fix` V2 catalog cold-start seed (#1018).

**Gates before the merge.** `npm test` 3922 pass / 1 skip / 0 fail on bun
1.3.14, typecheck, build. Live: E42 `--live --extended --separate-proxy-cwd`
against **both** pinned betas using the packed 1.71.0 consumer, plus the
`--no-discovery` and `--v1` controls; all 14 capped-turn controls with the
uncaptured-recovery flag off and four more with it on; all four E41 modes; both
`e2e-opencode-package-integrity.mjs` variants. Installed-package validation ran
twice — packed tarball and then the registry download — with
`toolRounds=3 resumed=3` on `pi`, `passthrough`, `opencode` and `polytoken`.

The candidate's CI again arrived `action_required` and had to be approved run by
run, as the 1.70.0 section warns. One approval returned
`403 This workflow run is not waiting for approval` because it had already
started — that is success, not a failure.

**A flaky gate found during this release, ticketed as #1028.** The first E42 run
against `0.0.0-beta-18314` printed `{"result":"PASS"}` with every probe green and
then exited **1**. Cause is in the log, not a guess: a straggler client request
reached the fixture during teardown, after `proxy.close()`, and the fixture's
**live POST forward is unguarded**, so the rejection set the exit code —
`ConnectionRefused`/`ECONNRESET` at `scripts/e2e-opencode-v2-package.mjs:128`.
#1016 hardened the non-POST branch for exactly this and the POST branch was
never given the same treatment. A second run exited 0 with identical
assertions. The release was not held: the artifact under test passed everything,
and the defect is in the harness. **This was not written off as "a rerun
passed"** — it is root-caused to a named code path and tracked.

## Delivered: session bookkeeping off the request path, #1030 as #1036

Contributor PR by @justprosh, incorporated as `596a0d83` with Aleksey
Proshutinskiy's authorship preserved (`ba3792b8` → `2a524584`, `8b573a3c` →
`cf1aac50`) and a `Co-authored-by` trailer on the squash. Both commits applied
cleanly to current `main` — no conflicts. Branch `codex/session-bookkeeping`,
worktree `/tmp/meridian-1030`.

**#1030 is still OPEN.** Its head was rechecked as `8b573a3c`, unchanged, so
nothing of theirs was lost. Closing it notifies the contributor, so that is left
to the owner along with a note.

**What it fixes.** A ~500 turns/hour deployment losing **13–16% of turns** to a
504 that blamed the request. Four independent bookkeeping defects: a deletion
backlog that never drained (254 attempts on one resource, then
`ownership backlog is full` for every *new* conversation); a 26 MiB store parsed
synchronously (135 ms) several times per request and once under the lifecycle
lock; unarmed leases with no TTL fencing conversations until restart (30 leaked,
28 older than 15 minutes); and pretty-printed machine-only files costing ~20–25%
of bytes and CPU under the lock. Saturation now answers 503 `overloaded_error`
naming the reason instead of a 504.

**How it was reviewed, and the one thing that mattered.** The new tests were run
against the **pre-fix** tree, which is the only way to tell evidence from
decoration:

| new tests | pre-fix |
|---|---|
| `classifyError` saturation | 3 of 4 fail (the 4th is a control) |
| read-cache identity reuse | fails |
| read-cache safety properties | pass — regression guards, not demonstrations |
| lease TTL | could not run (imports a symbol absent pre-fix) |
| **deletion verdict** | **pass** |

The headline defect's tests pass pre-fix. Their fixture's child output is short
enough that the old `output.slice(-4_000)` still contained the verdict, so they
prove the new mechanism works but not that it fixes the reported failure — only
an output larger than the tail budget separates them. `cd753c73` pins that shape
directly. **This is the fourth time this month a test passed while covering
nothing** (#1025, the plugin-less 400, #1004's missing gate, now this one);
running a PR's own tests against the pre-fix tree is the cheapest way to catch
it and should be routine.

**The read cache's premise was checked, not taken.** Identity keying by
`{path, ino, mtimeMs, size}` is exact only if every writer publishes through
`rename`. `writeStore` writes a unique temp, fsyncs, renames — new inode per
publish — and re-takes identity from the same fd it reads bytes from, closing
the stat/read race. The other two `writeFileSync` calls in that module target
lock and claim paths, never the store.

`3d2a8755` documents `MERIDIAN_SESSION_GC_LOCK_WAIT_MS`, which shipped
undocumented — the knob an operator reaches for when the new 503 says a lock is
busy. Env names verified against `src/env.ts`, not assumed.

**Validation.** `npm test` 3948 pass / 1 skip / 0 fail, build. Live E41 all four
modes plus `publication-lifetime`, `settlement-proof` and `duplicate-checkpoint`
— run twice, on the incorporated tree and again after the two maintainer
commits.

**Not verified, deliberately:** the three quantitative claims (254 attempts,
135 ms under lock, 30 leaked leases) are the reporter's measurements. The
mechanisms and their guards were verified; the load was not reproduced. A
synthetic 26 MiB store is the obvious next gate if the performance claim should
be pinned rather than argued.

## Delivered: #1024, plugin-less OpenCode concurrency, as #1031

Root cause is configuration; the fix shipped anyway because failing a user's
first turn is the wrong response to a client that cannot send the signal.

Merged as `2e118a92`, branch `codex/opencode-pluginless-concurrent-flow`,
worktree `/tmp/meridian-1024fix`. **#1024 deliberately stays open** until
@calebdw confirms on their machine.

**The decision, and why it was narrow.** The owner had no strong view, so the
options were priced against the code. The conflict guard already skips when
`declaresConcurrentFlow` is true, and `adapters/pi.ts` already sets
`runsConcurrentTurnsPerSessionKey: true` for exactly this reason — the in-code
rationale reads "an adapter can declare the same fact for its whole protocol
when the client has no per-flow signal to send". A plugin-less OpenCode request
*is* such a client. So the change reuses that mechanism and applies it only to
requests carrying no plugin signal, via a pure predicate
(`isPluginlessOpenCodeRequest`) that the existing warning already computed.

Rejected: setting `runsConcurrentTurnsPerSessionKey` on the whole OpenCode
adapter. One line shorter, but it would relax the guard for plugin-equipped
users too, where a collision is a real defect and should stay loud.

Also rejected, and previously tried and reverted — see the header of
`pluginless-opencode-warning.test.ts`: inferring which stream is the title from
request shape. "Tool-less, one message" is equally the first turn of an ordinary
chat.

**Before / after, live, reporter's models:**

| headerless, Opus primary + Haiku title | before | after |
|---|---|---|
| primary | 200 | 200 |
| title | **400** | **200** |

Plugin-equipped control unchanged at 200/200 with no warning. Serialization is
untouched (`maxActiveQueries` still 1) and the loser still runs fresh; the cost
is a cold prompt cache, which the warning text now states instead of predicting
a 400 that no longer happens.

**Coverage added, because none existed.** The full suite passed *before* the
change too — no test pinned the plugin-less 400, which is why the behaviour
could be relaxed silently. Added: predicate unit tests (UA case, both agent
modes, and negatives including `opencode2`, `crush`, `Polytoken`,
`my-opencode/1.0` as a prefix-not-substring check); an HTTP-layer test that a
plugin-less pair is admitted, still serialized, runs fresh and emits no
`session_turn_conflict`, **verified to fail on the tree without the one-line
condition**; and an HTTP-layer control that a plugin-equipped pair still takes
the 400 — that control passes with *and* without the fix, which is what proves
the scoping.

`npm test` 3927 pass / 1 skip / 0 fail, typecheck, build, all four E41 modes.

**A reply to @calebdw is drafted and NOT posted**; sending still needs owner
authorization.

## Superseded triage note: #1024 was first read as configuration only

Reported by @calebdw against Meridian 1.68.0 through the third-party
`opencode-with-claude@1.10.1`: the first message of every new session fails with
`This session advanced while the request was waiting`. OpenCode fires a Haiku
`agent=title` stream and the Opus primary turn concurrently on one OpenCode
session id.

Reproduced on the 1.71.0 candidate with the reporter's models, firing the title
one second after the primary:

| setup | primary | title |
|---|---|---|
| no Meridian agent headers (reporter's shape) | 200 | **400** `This session advanced while the request was waiting` |
| Meridian's plugin headers present | 200 | 200 |

In the passing control the log shows `source=subagent-title agent=subagent`
running concurrently with `agent=primary` (`sdkActive=1/10`) — the title is
detached exactly as designed. In the failing variant the proxy prints its own
warning, which describes this failure precisely: "OpenCode request without the
Meridian plugin's agent headers … the first turn of each session can fail with a
400 … Fix: meridian setup".

So the reporter is missing Meridian's own plugin; the third-party one does not
stamp those headers. Their observation that 1.62.1 worked is consistent: the
stricter session-advance check landed later, so the same collision was
previously silent — replaying against a cold cache instead of failing.

Note one difference from the report: in our reproduction the **title** took the
400 and the primary completed, where theirs lost the Opus stream. Which side
loses is timing-dependent; the mechanism is identical.

**A reply is drafted but NOT posted** — sending needs owner authorization. The
open product question, which is the owner's: should Meridian absorb header-less
concurrency by serialising or forking per mapped session instead of returning
400, which is what a drop-in Anthropic API would do? Today it fails the turn.

## Open: supported V2 betas have drifted, #1027

Surfaced triaging #1023 (@Ardumine), which adds `0.0.0-beta-19425` to
`SUPPORTED_OPENCODE_V2_VERSIONS`. **That version does not exist on npm** — 404;
the 5-digit beta series ends at `0.0.0-beta-19271`. A supported beta must pass
E42 against that exact binary, so #1023 cannot be accepted as written whatever
its merits. Upstream has also moved to date-based versioning
(`0.0.0-beta-202608110357`, 1107 betas total), leaving our newest supported host
`18866` roughly 400 revisions behind. #1027 asks for a policy — how many hosts,
a set or a floor — before any bump is worth validating.

## Delivered: two of three #980 splits (#1011 partly, #1009 landed off by default)

Both cherry-picked from preserved contributor commits by @jakewimmer, authorship
and AuthorDate intact, each with maintainer corrections in separate commits.

| split | original | incorporated | delivery | disposition |
|---|---|---|---|---|
| abort-cause diagnostics | `016eb53c` → `77667583` | `8f362e18` | `0fd59403` (#1022) | landed |
| uncaptured-tool recovery | `f185e76e` | `929d351f` | `d8516bea` (#1025) | landed, flag off |
| visible empty capped streams | `c5804275` | — | — | **deferred by owner** |

Both squashes carry `Co-authored-by: Jake Wimmer`. `c5804275` remains on
`codex/polytoken-extras`; do not retype it.

**Deferred by owner decision: `fix: recover visible empty capped streams`.** It
changes a documented, gate-defended guarantee and introduces a stream/non-stream
asymmetry. `E2E.md` says "empty output, thinking alone and unhandled calls must
fail" (#926); with the commit applied, live:

| case | non-stream | stream |
|---|---|---|
| `empty` capped turn | 1 cap query — fails, as documented | **2** — lifts the cap and retries |
| `thinking`-only capped turn | 1 — fails | **2** — retries |

`--case=empty --stream` and `--case=thinking --stream` both fail on
`assert.equal(capQueries.length, retry ? 2 : 1)`. Everything else was green,
including all four E41 modes and the #925 `--drop-stop` control — the
contributor's own validation was the unit suite, which never runs these gates.
The owner chose to defer rather than rewrite the contract; the full evidence and
the two ways to pick it up are in #1011's body.

**Two maintainer corrections worth remembering.**

`1cf83e46` (in #1022): the contributor's message said all five
`formatSdkTermination` call sites pass the abort snapshot. Four did. The missing
one was `sdk_termination_recovered` on the captured-tool recovery path — the
diagnostic closest to the incident the field exists for. Nothing failed, because
an omitted context field simply does not render. Fixed, with a source invariant
that fails without it, because the capped-turn fixtures never reach that site.
Observed live afterwards: `sdk_termination reason=max_turns turns=1 abort=none`.

`012103f0` (in #1025): the uncaptured-recovery feature's **central test had
never executed**. It called `parseSSE` without importing it — `tsc` reports
`TS2304`, bun throws `ReferenceError`. So the behaviour the commit exists for
had no running coverage. `bun test` does not typecheck; this is the second time
that trap appeared today, the first being my own new test file caught by CI in
#1018. With the import fixed (and four forbidden `as any` casts replaced) the
test passes.

**Why #1025 was safe to land while #1011's sibling was not.** #1025 is
`MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY`, off by default, every new path
flag-gated. All 14 capped-turn controls and all four E41 modes pass with it off;
with it **on**, `unhandled`, `empty`, `partial` and `retry` (stream) still behave
exactly as documented, so the refusal boundary holds live. The deferred commit
changed default behaviour and broke two of those same controls.

**What #1009 still needs** (it is deliberately still open): a live gate for the
positive abort-window shape — the fixture streams a complete `tool_use` block
but for an *undeclared* tool, so it exercises refusal, not recovery; reproducing
the real shape needs an abort injected between a declared tool's
`content_block_stop` and hook dispatch, which the fixture cannot do and which is
racy to time. Plus the non-streaming parity decision, documented as a
flag-scoped limitation rather than decided. Plus the canary itself.

**A hazard that nearly fired.** #1025's PR body originally read "why this does
not close #1009". GitHub's linked-issue parser ignores the negation, so merging
would have shut the ticket that tracks the remaining work — the same failure as
#997/#917 and #969/#967. The pre-creation grep caught it; `closingIssuesReferences`
was verified empty before merging. **Grep the PR body for keyword-then-number
before creating it, and check `closingIssuesReferences` before merging.**

## Delivered: OpenCode V2 cold-start catalog, #1008 as #1018

Maintainer-originated, filed by us while validating #1004. Base `00b41a6f`,
branch `codex/v2-catalog-cold-start`, worktree `/tmp/meridian-1008`, delivery
commit `eabd78dd`, merged as `52b581b6`. #1008 closed by the PR body.

**Before / after**, same new gate assertion, same host:

| tree | coldStartProbe | exit |
|---|---|---|
| pre-fix (`00b41a6f` + gate only) | `{"errors":["provider.no-route"],"efforts":[]}` | 1 |
| fixed | `{"errors":[],"efforts":[null,"xhigh"]}` | 0 |

**The fix.** Each successful discovery is cached in
`~/.config/meridian/opencode-v2-catalog.json`; the plugin reads it
*synchronously* in `setup`, before the first transform can run. The seed cannot
be a catalog read — awaiting the catalog in `setup` deadlocks the server, which
is why discovery is driven off `catalog.updated` at all.

**The finding that changed the design.** The plan was to validate a cached entry
against the provider's configured base URL so a repointed provider could never
apply another Meridian's models. That is impossible inside a transform: a draft
`Provider.Info` exposes only
`["id","name","activation","package","integrationID","headers"]`, and the whole
record contains **no URL anywhere** — observed by instrumenting the real host on
beta-18866, after the types suggested otherwise. So the guarantee is self-healing
rather than preventive:

- the seed is applied optimistically to any Meridian provider still in the catalog;
- when discovery finds no Meridian-shaped base URL the provider has been
  repointed, so the cache is deleted and the catalog rebuilt without it;
- a provider that is configured but unreachable keeps its seed, because the last
  catalog Meridian served beats models.dev's 1M Sonnet.

**Behaviour narrowed, deliberately.** "Meridian unreachable leaves the catalog
exactly as OpenCode built it" now holds only when no cache is present. Recorded
in `docs/agents.md` with how to clear the file. The `--no-discovery` control
still passes because it runs with an isolated config directory. A brand-new
install's very first request still has no cache; no plugin API allows better —
`@opencode-ai/plugin@0.0.0-beta-19271` still has a synchronous `Transform` and no
config domain.

**New gate coverage** in `e2e-opencode-v2-package.mjs`: a cold-start probe that
spawns a fresh `--standalone` process rather than reusing the warm server, and a
non-live invalidation probe that repoints the provider, requires the cache file
to be deleted and the next cold run to reject the variant. The first repointed
run is recorded but not asserted — whether it still offers the variant depends on
how far model resolution gets before discovery lands.

**Validation.** `npm test` 3890 pass / 1 skip / 0 fail on bun 1.3.14 (10 new),
typecheck, build. Exit 0 for: live `--extended --separate-proxy-cwd` on
beta-18866 and beta-18314; the same against an independently `npm pack`-installed
consumer; non-live; `--no-discovery`; and the `--v1` control on pinned
`opencode@1.18.11` with `discoveryTrace: []`. Exit 1 with one new assertion
deliberately broken. `e2e-opencode-package-integrity.mjs` passes both variants.
The merged tree was confirmed file-by-file identical to the validated tree.

**Two process notes from this ticket.**

`npm test` does **not** typecheck, and CI runs `npm run typecheck` inside the
`test` job. A new test file typechecked fine locally only because typecheck was
last run before it existed; CI caught four `TS2345` errors from a hand-rolled
`CatalogDraft` stand-in. Run `npm run typecheck` *after* adding or editing test
files, not before. The fix was to narrow the function's parameter to the
`CatalogProviderProbe` interface it actually needs, which is better typing than
the stub it replaced.

A `--v1` control failed with `ENOENT` on the pinned binary, which looked like a
regression and was not: the previous ticket's cleanup had deleted
`/tmp/opencode-v1-11`. Reinstall `opencode-ai@1.18.11` before reading anything
into a V1 failure.

## Delivered: the E42 gate's exit code and its missing discovery coverage, #1014 as #1016

Maintainer-originated, filed by us during 1.70.0 release validation under the
owner's standing ticket instruction. Base `3145fc49`, branch
`codex/e42-discovery-gate`, worktree `/tmp/meridian-1014`, delivery commit
`36362440`, merged as `1519f8d8`. #1014 closed by the PR body. No external
contributor is involved, so no author mapping applies. Test infrastructure only:
no source, plugin or configuration change.

**The defect.** `scripts/e2e-opencode-v2-package.mjs` recorded traffic through a
`Bun.serve` fixture that called `request.json()` on every request. The
`GET /v1/models` that #1004's model discovery issues has no body, so it threw.
Discovery failed closed, and the unhandled rejection set the process exit code —
the gate printed `{"result":"PASS"}` and exited **1**. So the mandatory V2 gate
had a meaningless exit code *and* the feature released in 1.70.0 had no
automated coverage. Causality established by A/B before changing anything:

| fixture | `result` | `GET - /v1/models failed` | exit |
|---|---|---|---|
| as shipped | `PASS` | 5 | **1** |
| patched to answer non-POST | `PASS` | 0 | **0** |

A second instance of the same class surfaced only once the first fix let the run
get far enough: the live forward hardcoded `method: 'POST'`, and an abort
mid-forward threw out of the handler. A one-shot client process exiting with
discovery in flight does exactly that; it appeared as `status: null`. Both are
now caught and recorded rather than thrown.

**What the gate now asserts.** A `GET` to *exactly* `/v1/models` — the original
contributor version requested `/v1/v1/models`, because the Anthropic provider
carries the API version in its base URL, and that 404 disabled discovery
silently. Then the response must carry `claude-haiku-4-5` with a 200k window and
a supported `xhigh` effort, the two values OpenCode's own models.dev entry gets
wrong. In `--live --extended` it selects `anthropic/claude-haiku-4-5#xhigh` and
requires the effort to reach the proxy; that variant is
`provider.no-route — Variant unavailable` without discovery, so a pass can only
come from the applied catalog. `--no-discovery` is the new negative control.

**A flaky assertion caught before it shipped.** The variant probe first asserted
the model emitted a literal sentinel. That was true on one run and false on the
next — same code, same host. It is now recorded but not asserted; the
deterministic facts are asserted instead (no error events, the effort observed
at the proxy, the request completing upstream). Both live hosts show
`answered` disagreeing between runs, which is exactly why.

**Validation.** `npm test` 3880 pass / 1 skip / 0 fail on bun 1.3.14, typecheck,
build. Exit codes, which are the point of this ticket:

| run | exit |
|---|---|
| `--live --extended --separate-proxy-cwd`, `0.0.0-beta-18866` | 0 |
| `--live --extended --separate-proxy-cwd`, `0.0.0-beta-18314` | 0 |
| non-live, beta-18866 | 0 |
| `--no-discovery` negative control | 0 |
| `--v1` control, pinned `opencode@1.18.11` | 0, `discoveryTrace: []` |
| one assertion deliberately broken | 1, no `PASS` printed |

Both live runs: variant selected, `effort: "xhigh"` observed at the proxy, 100%
cache reuse on ordinary continuation and process restart.
`e2e-opencode-package-integrity.mjs` passes with and without `--manifest`.
The merged tree was confirmed byte-identical to the validated tree.

**An hour lost to a bad probe, worth not repeating.** Before using the real
gate, an ad-hoc harness was built to answer "does the applied catalog actually
expose the variant?" It reported `provider.no-route` even with discovery
returning 200 and a valid catalog, which looked like a product defect in #1004.
It was not — the probe's own client/server wiring was wrong. The real gate,
which already has correct port reservation, `OPENCODE_SERVER_PASSWORD` auth and
a warm server, showed the variant working on the first try. **Reach for the
existing gate before building a probe**; if a probe contradicts a hand-verified
live result, suspect the probe.

`opencode2 models` lists model ids without variants, and `/api/provider/{id}`
and `/api/model` return empty unless the provider is fully active, so neither is
a usable catalog assertion. The tap-observed traffic is.

## Delivered: disabled subscription entitlement, contributor PR #1005 as #1012

**Item.** [PR #1005](https://github.com/rynfar/meridian/pull/1005) by
StanChmielewski — an org admin can switch Claude Code subscription access off;
the refusal named no limit and no payment method, so `classifyError` fell
through to `api_error`, `isAccountFailoverError` said no, and priority routing
kept selecting an account that could serve nothing.

**Disposition.** Accepted with one maintainer correction. Merged 2026-09-10 as
`c3dc2279` with `Co-authored-by: Stan Chmielewski <s.chmielewski@it-tower.pl>`.
Author mapping `06a44e2a` → `2b6681e5`, AuthorDate preserved; maintainer commit
`0560d4a7`. Base `3db622fa`, worktree
`/Users/rynfar/repos/meridian-wt/org-entitlement`. #1005 head rechecked as
`06a44e2a` immediately before merge, then auto-closed.

**Reproduced on main before changing anything**: `sdk result` → 500 `api_error`,
`stderr exit1` → **401 `authentication_error`**, `api 403` → 500 `api_error`,
all with `failover=false`. The 401 is the sharp edge — a bare code-1 exit reads
as an expired login, so the operator is told to run `claude login` for an
entitlement only an admin can restore.

**The maintainer correction, and the lesson.** The PR claimed to cover the
API-key/gateway shape with `API Error: 403 Your organization has disabled ...`.
That string is not what reaches `classifyError`. The CLI actually emits:

```
Claude Code returned an error result: Failed to authenticate. API Error: 403
Your organization has disabled Claude subscription access for Claude Code · ...
```

A bare `Failed to authenticate.` sits between the CLI's wrapper and the upstream
status. It ends in a period, so it is not one of the recognised colon-wrappers,
and the anchored pattern never reached the entitlement string — that path was
still `api_error` and still did not fail over. **A hand-written example of a
wire string is not the wire string.** It was found by driving a real refusal
through the failover harness, not by reading the report.

**Evidence.** Ten adversarial classification cases pass, including the negatives
`has not disabled`, a mid-line quote, `disabled MCP servers`, the authenticate
notice alone, and the notice before a different capability. Live E2E through the
#836/#829 error-telemetry harness with only the refusal fixture swapped to the
org-disabled message at HTTP 403: pinned 402 `billing_error` (streaming and not),
failover 200 from real Claude Max with the receipt, `PASS`. That harness FAILED
at the pinned assertion before the maintainer fix. Gates: `npm test` 3880 pass /
0 fail / 1 pre-existing skip, typecheck, build; CI green on all four checks.

**Limitation.** An actual org-disabled account could not be reproduced here; the
contributor's own run against one is the primary evidence for the real-world
shape, and the harness drives the refusal instead.

## Delivered: Polytoken harness adapter, contributor PR #980 as #1010

**Item.** [PR #980](https://github.com/rynfar/meridian/pull/980) by jakewimmer —
a native adapter for [Polytoken](https://polytoken.dev), an Anthropic-Messages
coding agent that owns its tool loop.

**Disposition.** Accepted in part. Merged 2026-09-10 as `3db622fa` with
`Co-authored-by: Jake Wimmer`. Base `fb06c924`, worktree
`/Users/rynfar/repos/meridian-wt/polytoken`. #980 head rechecked as `f185e76e`
before merge, then auto-closed. Author mapping, all AuthorDates preserved:
`68a0092e`→`6878e515`, `1bbf7a4b`→`64fc6e68`, `f22856f4`→`639af5e2`,
`9b7b21d4`→`dd84557e`, `0edf2c63`→`58518d61`, `76f30fa9`→`58e307a8`,
`acc0c661`→`2a878eea`. Maintainer commit `1dff13fd`.

**Three commits were split out**, all preserved with authorship on the pushed
branch `codex/polytoken-extras` — do not retype them:

- `f185e76e` uncaptured-tool recovery. The only commit that does not apply to
  current main; conflicts with #998's rework of the same early-stop region. The
  contributor states it is "default OFF until canaried" with non-streaming
  parity deferred. Tracked in **#1009**.
- `1b2ba3a9` recover visible empty capped streams, and `016eb53c` classify abort
  causes in `sdk_termination`. Both clean and green, held so each gets its own
  changelog line and its own gate; the first lands in the #983 → #996 → #998
  path. Tracked in **#1011**.

The contributor's reported "1 failed" full suite does not reproduce — that flake
was fixed by #997, now in the base.

**Maintainer correction: a gate anyone can run.** #980's E2E was a manual Docker
image swap plus a personal systemd unit and a budget gateway, driven by scripts
deliberately not committed, and it overshot its own request budget (14 against a
cap of 12). Replaced with this repository's existing mechanism: Polytoken added
to `scripts/e2e-client-detection.mjs` (honouring `E2E_POLYTOKEN_BIN`) with its
real 0.8.6 headers recorded in `client-headers.json`, so
`client-detection-fixtures` pins the adapter in CI and a client-side change is a
git diff. This is the #733 class of bug, and a PR whose detection keys on a UA
plus a native header is exactly what that fixture protects.
`x-polytoken-session` joined the redacted-value set, or every re-capture would
churn on a fresh session id.

**Evidence, live against the real client.** Polytoken 0.8.6 macos-arm64
(sha256 `71353a6d…0793e7`, verified against the published `SHA256SUMS.macos`),
installed to `/tmp/pt`, real Claude Max on `claude-haiku-4-5`, disposable
Meridian on port 3468. A `polytoken exec` client-owned read returned `LINES=4`
in **four** client round-trips, `adapter=polytoken` throughout, `lineage=new`
then `lineage=continuation` on a stable `x-polytoken-session`. The read ran on
the Polytoken side — the proxy's own workdir has no such fixture. Repeated with
`MERIDIAN_PASSTHROUGH=0`: identical, so the global setting cannot hand the loop
to the SDK. Detection controls: `PolytokenImpostor/1.0` → `opencode`, blank
header → `opencode`, valid header → `polytoken`, UA alone → `polytoken`.
Captured wire identity: `user-agent: Polytoken v0.8.6`, `x-polytoken-session`,
`accept: text/event-stream`. Gates 3871 pass / 0 fail / 1 skip, typecheck,
build; CI green.

**Behavior change to remember.** A valid `x-polytoken-session` now outranks
automatic adapter-instance match rules (#476). Explicit `x-meridian-agent` still
wins over both.

**Polytoken install, for the next run.** `https://get.polytoken.dev` shell
installer, or `https://dl.polytoken.dev/<version>/<platform>/polytoken.zip` with
`SHA256SUMS.<os>`. Config is `config.yaml` in `--config-dir`; a Meridian
provider needs `kind.type: custom_anthropic_compatible`, `protocol:
anthropic_messages`, `auth.type: static_key`, and a model entry with both
`provider` (instance name) and `provider_name` (wire id) plus a `class`.

## Delivered: OpenCode V2 model discovery, contributor PR #1003 as #1004

**Item.** [PR #1003](https://github.com/rynfar/meridian/pull/1003) by
martinmiglio — read Meridian's `/v1/models` from the V2 plugin and write the
result into OpenCode V2's model catalog.

**Disposition.** Accepted with maintainer corrections. Delivered as
[PR #1004](https://github.com/rynfar/meridian/pull/1004), squash-merged
2026-09-10T14:46Z as `7028c697` with
`Co-authored-by: Martin Miglio <marmig0404@gmail.com>`. #1003 auto-closed at the
same second; its head was still `a6657962`, rechecked immediately before merge,
so no later contributor work was discarded.

Base `a1f04df6`. Branch `codex/opencode-v2-model-discovery` (deleted on merge),
worktree `/Users/rynfar/repos/meridian-wt/v2-model-discovery`. Author mapping:
`a6657962` → `9a25b773`, Author and AuthorDate (2026-09-02) preserved.
Maintainer commits `b98de38f`, `50b16f3c`, `a63b27a2`.

**Half the PR was already on main.** #1003 also packaged the V2 plugin as a
directory package. #988 landed that first, byte-for-byte for
`plugin/meridian-v2/`, plus a generalized `scripts/package-opencode-plugins.mjs`
covering V1 too. #1003 branched from `1ea97d01` and predates it, which is why it
was `CONFLICTING`. That half was dropped as superseded during the cherry-pick.

**The discovery half did not work, in two independent ways.** Both were found
live against the pinned `opencode2 0.0.0-beta-18866`, not by reading the diff.

- V2's Anthropic provider carries the API version in its base URL, so
  `http://127.0.0.1:3466/v1` was turned into a request for `/v1/v1/models`. That
  path answers 404 and `/v1/models` answers 200, so the fetch always failed.
- The skip guard read `catalog.provider.get(id).models` and treated a hit as
  user configuration. Inside a transform that map is the assembled models.dev
  catalog, which already lists all nine models Meridian serves — so every model
  was skipped even once the URL was fixed.

**What made the second fix safe, and it is worth remembering.** V2 layers
`providers.<id>.models` on top of plugin transforms. Verified directly: a
configured `claude-opus-5` override (`name: "USER OVERRIDE"`, context 12345)
survived a transform that wrote a different name and context to the same model,
while a model the user had not configured took the transform's value. A plugin
can therefore write authoritative values without clobbering user overrides — the
opposite of what #1003 assumed.

That correction matters beyond the variants: beta-18866 advertises a 1M Sonnet,
while Meridian deliberately serves Sonnet at 200k so a long turn is not billed
as Extra Usage.

**Evidence.** Same isolated config, Meridian unreachable versus reachable:

```
unreachable (= the pre-fix result)
  claude-sonnet-5    ctx=1000000  ['none','low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['high','max']
reachable, fix applied
  claude-sonnet-5    ctx=200000   ['low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['low','medium','high','xhigh','max']
  claude-sonnet-4-5  ctx=1000000  ['high','max']   <- not served by Meridian, untouched
```

Live E2E: `opencode2 0.0.0-beta-18866` (installed to `/tmp/oc2pin`, not the
user's global `~/.local/bin/opencode2`, which had self-updated to 19242 and is
outside the supported set), Meridian from source on isolated port 3466 with an
isolated session store, isolated `OPENCODE_CONFIG_DIR` and all four `XDG_*`
dirs, real Claude Max (`max`, profile `work`). Through a logging tap in front of
the proxy, `--model 'anthropic/claude-haiku-4-5#xhigh'` produced
`POST /v1/messages?beta=true model=claude-haiku-4-5 effort="xhigh" stream=true`
→ 200, and Meridian logged `agent=primary model=haiku` with
`source=subagent-title` detached separately. Negative control with the base URL
on a dead port: catalog untouched, nothing logged as an error.

Gates at head `a63b27a2`: `npm test` 3803 pass / 0 fail / 1 pre-existing skip
(bun 1.3.14), `npm run typecheck`, `npm run build`. CI green on `test`, `smoke`,
`windows-smoke`, `build-push`; `changelog-duplication` skipped. Failed-before /
passed-after retained for both new plugin regressions.

**Known limitation, documented in `docs/agents.md` and accepted by the owner.**
Discovery cannot read the catalog until OpenCode has assembled it — awaiting
`context.catalog.provider.get()` inside `setup` deadlocks the server, confirmed
by a probe plugin that hung the process with no output. So the first request
against a freshly started server still sees the built-in entries, and naming a
Meridian-only variant there (`anthropic/claude-haiku-4-5#xhigh`) fails with
`provider.no-route`; the next request succeeds. Reproducible, not intermittent.
The TUI picker is unaffected because it renders after discovery lands.

No OpenCode release fixes this. `@opencode-ai/plugin@0.0.0-beta-19271`, the
newest published beta, still declares `Transform` with a synchronous callback
(`CatalogDraft` merely renamed to `CatalogEditor`) and still exposes no config
domain. Closing the race would need a persisted catalog cache seeded during
setup — a separate design decision, not started.

**Also fixed while validating this.** `docs/agents.md` documented a V1-shaped
provider block for the V2 section. V2 reads `providers` and `settings`;
`provider` and `options` are silently ignored, which points the client at the
real Anthropic API instead of Meridian. The base URL also needs its `/v1`
suffix. The same section listed only beta-18314 while
`SUPPORTED_OPENCODE_V2_VERSIONS` accepts 18866 as well.

**Next action.** None outstanding for this item. 1.69.0 is published and a
release for `7028c697` needs its own explicit authorization.

## Delivered: OpenCode Desktop cannot load the V1 plugin, PR #988

Maintainer-originated fix, not a contributor PR. Owner-reported: OpenCode
Desktop on macOS could not use Meridian after a normal `meridian setup`.

Base `d3bfe795`, branch `codex/ship-compiled-opencode-v1-plugin`, worktree
`/Users/rynfar/repos/meridian-wt/opencode-v1-compiled-plugin`, delivery commit
`12ae3f74`. Disposition: accept as maintainer fix. **Rebased onto `ac8bd6c2`
and revalidated before merge** (3775 pass / 1 skip / 0 fail on bun 1.3.11,
typecheck, build, tarball rebuilt); merged as `d075cc7c`. No external
contributor is involved, so no author mapping or co-author trailer applies.

Cause: `findPluginPath` returned `plugin/meridian.ts` for every install. The Bun
CLI loads TypeScript, but OpenCode Desktop (`ai.opencode.desktop` 1.18.23,
Electron 42 / Node 24) runs the OpenCode server in-process under Node and ships
no Bun binary; its native modules are Node-ABI. Node refuses type stripping
under node_modules, so an installed package wrote a path the desktop client
cannot import: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Relocating the
`.ts` does not help either — `plugin/meridian.ts` imports
`./priority-attestation` without an extension, which is `ERR_MODULE_NOT_FOUND`
under Node ESM. OpenCode's loader dynamic-imports the spec with no
transpile step.

**Correction to an earlier version of this note.** It said the loader
"resolves a file spec to `pathToFileURL(...)`" full stop. That is only true for
a FILE spec. For a directory it reads the directory's `package.json` and
imports its `main`: `resolvePathPluginTarget` returns the directory URL when a
`package.json` exists, `readPluginPackage` reads it, `resolvePackageEntrypoint`
takes `packageMain(pkg)` for kind `server`, and `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. Read out of the Desktop server bundle
(`app.asar` → `out/main/chunks/node-BOFfwe6w.js`). This matters: a probe that
imports the bare directory gets `ERR_UNSUPPORTED_DIR_IMPORT` and reports a
false failure for a plugin that actually loads. That happened here before the
loader was read.

### Verified against the desktop runtime

#988 was already green and validated live against the OpenCode 1.18.29 Bun CLI,
but carried a recorded limitation: "not yet exercised through the OpenCode
Desktop GUI". That is now closed without a click-through, and the method is
worth reusing.

**OpenCode Desktop runs its server in an Electron utility process, not a Bun
sidecar.** `app.asar` → `out/main/sidecar.js` takes a `process.parentPort`
message, `await import("./chunks/node-BOFfwe6w.js")`, then `Server.listen(...)`.
No spawned `opencode` binary, so the plugin is loaded by Electron's bundled
Node — which is the premise the PR rests on, now verified rather than assumed.

**How that server resolves a directory plugin**, read out of the same bundle:
`resolvePathPluginTarget` returns the directory URL when the directory has a
`package.json`; `readPluginPackage` reads it; `resolvePackageEntrypoint` takes
`packageMain(pkg)` for kind `server`; `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. So the shim's `"main": "./index.js"` is
precisely what makes `dist/meridian` importable — and a probe that imports the
bare directory reports a false `ERR_UNSUPPORTED_DIR_IMPORT`. Mine did, before I
read the loader. Read the loader.

Replicating that resolution against an installed tarball:

```
runtime node=22.22.3 electron=none            (plain Node)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true

runtime node=24.15.0 electron=42.3.3          (OpenCode Desktop 1.18.30's server runtime)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true
```

Rebased onto `ac8bd6c2` and revalidated: 3775 pass / 1 skip / 0 fail, typecheck
and build clean, tarball rebuilt.

Still open on that item: `isMeridianEntry`'s `endsWith("/meridian-v2")` is
POSIX-separator-only, so source-install detection on Windows is a pre-existing
gap, deliberately left out of scope.


Fix mirrors the existing V2 shape: `plugin/meridian/` shim package compiled to
`dist/meridian/`, `findPluginPath` mirroring `findV2PluginPath` (source keeps
source, installed selects compiled, fail closed), `MissingV1PluginError`,
shared `hasPluginPackageEntry`, generalized
`scripts/package-opencode-plugins.mjs`, and `node --check dist/meridian/index.js`
in postbuild. Detection still matches legacy `meridian.ts` entries so older
installs keep reporting configured.

Proof, from an independently packed and installed tarball:
old path `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, new path imports with a
function default. `meridian setup` from that installed CLI writes
`node_modules/@rynfar/meridian/dist/meridian`.

Live E2E: OpenCode 1.18.29, `claude-opus-4-6`, isolated proxy port 3466,
isolated `XDG_CONFIG_HOME` and workdir, plugin loaded from the installed
tarball. Returned the expected sentinel; proxy recorded
`agent=primary model=opus[1m]` and `agent=subagent model=haiku`, no pluginless
warning. Gates: `npm test` 3713 pass / 0 fail / 1 pre-existing skip, typecheck,
build. All PR #988 checks green at head `12ae3f74`, mergeState CLEAN.

NOT YET DONE — do not merge until this is closed: no run through the OpenCode
Desktop GUI itself. The desktop runtime constraint is proven by the Node import
reproduction, not by a click-through. The desktop app would not stay running
when launched from the agent shell (`Contents/MacOS/OpenCode` is a launcher stub
and `open -a` did not survive), and screen capture is unavailable, so this needs
the owner to launch the app and send one message while watching for
`agent=primary` in the proxy log.

Unrelated observations from the same session, not addressed here: the OpenCode
client stalls on a repeating design-MCP OAuth discovery loop against the proxy
(`/.well-known/oauth-*`, `POST /register` logged as UNHANDLED); and
`isMeridianEntry`'s `endsWith("/meridian-v2")` is POSIX-separator-only, so V2
source-install detection on Windows is a pre-existing gap.

## Delivered: issue #967 triage, delivered as PR #969

**Item.** [Issue #967](https://github.com/rynfar/meridian/issues/967) —
"Passthrough tool forwards are undeliverable for headless bg-job subagents →
compounding respawn loop", reported by filipporovelli against 1.68.0.

**Disposition.** Accepted in part, as a maintainer fix from triage. Triage found
a real and distinct Meridian defect that produces the reported symptom exactly,
and it is fixed in
[PR #969](https://github.com/rynfar/meridian/pull/969) (branch
`codex/fix-oc-prefixed-client-tools`, worktree
`/Users/rynfar/repos/meridian-wt/oc-prefixed-client-tools`). Base
`38c1db2b25de70be873f4b1b6436334566107bff`; delivery commits
`4646b932` (fix + tests), `8ec39e41` (E43 gate + E2E.md), `6823b687` (this
checkpoint) and `9447f8a7` (doubled-name hardening). No contributor commits exist for
this item, so there is no cherry-pick author mapping; the reporter is credited
in the PR body. **#967 is NOT resolved and must stay open** — see below.

**The defect that was fixed.** Client tools are registered inside Meridian's own
`oc` MCP server, so a client whose tool names already start with `mcp__oc__` —
a Claude Code CLI job with an `oc` MCP server configured, for instance —
collides with that namespace. Registration advertised
`mcp__oc__mcp__oc__read`, which SDK 0.2.141 / CLI 2.1.263 lists but never
dispatches: the PreToolUse hook never fired, nothing was captured
(`tools=0/1`), non-streaming returned HTTP 500, and streaming ended
`stop_reason: max_tokens` with an inline `error` event while leaking a tool_use
the blind reverse strip had renamed to `read`. Fixed by registering colliding
tools under a collision-free alias and reversing through an explicit map.
Ordinary tool sets alias to themselves, so model-visible names and the prompt
cache are unchanged. Only the exact `mcp__oc__` collision was affected; a
foreign `mcp__*` namespace was and remains fine.

**Two of the issue's inferences were refuted. Do not chase them again.**

- A nested SDK transcript terminating at the forward stub is the **designed
  steady state** of every passthrough tool step, on every client — not evidence
  of a stall. `PASSTHROUGH_DENY_REASON` has exactly one call site, inside
  Meridian's own PreToolUse hook, and is never sent to a client as a
  `tool_result`; Meridian then resumes the checkpoint with `forkSession`, so the
  denial branch is deliberately dead history. E41 already asserts the active
  fork holds exactly one real answer and zero denials per delivered call. The
  issue's "18 of 20 newest transcripts terminate at the forward stub" therefore
  describes Meridian's own nested sessions.
- The compounding "strict prefix-extension" replay is
  [#767](https://github.com/rynfar/meridian/issues/767)'s signature: a fresh
  replay opens a new SDK session, hence a new transcript that is a
  prefix-extension of the last.

  **This bullet originally claimed the trailing-block shape was still unfixed
  on main via `hasOnlyNewToolResults`. That was wrong.** That symbol no longer
  exists: `9d283288` (2026-09-04, shipped in 1.68.0, incorporating #872 with
  Serge Baranov's credit) replaced it with `appendedBlocksAreNew`, which
  permits non-`tool_result` blocks appended to a slot that is already a
  tool-result turn. Verified directly against main: `user[tool_result,text]`
  returns `continuation`, and a plain `user[text]` turn gaining appended text
  returns `diverged / modified-history` by deliberate design ("the user edited
  their own turn").

  **Process lesson worth more than the fact:** the error came from reading
  `src/proxy/session/lineage.ts` out of the owner's checkout, which sits on a
  divergent feature branch (`237acbf7`, not an ancestor of main), and then
  asserting it as main's state. Read source for a claim about main from a
  worktree on main, or via `git show origin/main:<path>`; `git log -S <symbol>`
  settles when a rule changed in seconds.

The respawn decision itself is above Meridian — the reporter's own job records
show `respawnFlags: []`.

**Validation.** `npm test` 3624 pass / 0 fail / 1 pre-existing skip;
`npm run typecheck` and `npm run build` clean. Failed-before/passed-after on the
same assertions: `src/__tests__/proxy-passthrough-oc-prefixed-tools.test.ts`
fails 6/8 on the parent commit (delivering `read` and `read_2` where
`mcp__oc__read` was declared) and passes 8/8 with the fix; the 2 that pass
either way are the no-regression controls. New **E43** live gate
(`scripts/e2e-passthrough-namespaced-tools.mjs`) passed all four combinations —
haiku and `claude-opus-5`, streaming and non-streaming, subject plus an ordinary
and a foreign-namespace control. **E41 all four modes** (chain/parallel ×
stream/non-stream) PASS. Post-fix live accounting shows `captured=1` and
`sdk_termination_recovered` where the same probe previously logged `tools=0/1`
with `envelope=open`. Versions: SDK 0.2.141, bundled Claude Code 2.1.259, system
CLI 2.1.263, OpenCode 1.18.29, Node v22.22.3, macOS arm64.

The Opus E43 runs were made before `9447f8a7`, which only changes names
carrying two or more leading copies of the prefix — a shape the gate does not
exercise and whose single-prefix behavior is byte-identical. E43 was re-run on
haiku in both modes after that commit and stayed green.

**Known limitations and next action.**

- Attribution of the reporter's incident to this defect is **not established**,
  and is now actively doubtful. `opencode-with-claude` 1.10.1 was unpacked from
  npm and checked rather than assumed: ~7.7 KB, one exported OpenCode `Plugin`,
  no `mcp__` strings, no MCP server registration, no `child_process`/`spawn`,
  no task/subagent bridging. It starts Meridian and resolves profiles. So it
  does not bridge subagents to bg jobs as the report assumes, and the `oc`-named
  MCP server in that environment is Meridian's own passthrough registration —
  meaning the transcripts sampled there are Meridian's nested sessions.
  Findings and a correction were posted to #967; nothing was asked of the
  reporter. Determining a contributor's environment is our job, not theirs.
- #967 stays open. Closing it needs both the attribution above and #767's
  replay driver.
- #893 (the `oc` namespace ignoring `getMcpServerName()`) stays open and is
  untouched. If it lands, `buildPassthroughToolAliases` and the
  `passthroughEarlyStop.ts` prefix mirror must follow the same value.
- A pre-existing gap deliberately left alone: `isClientForwardedToolUse` treats
  a bare `mcp__*` name as an internal SDK tool, so a foreign-namespace client
  tool would not arm the early-stop tracker if the SDK emitted its bare form.
  It does not today; the E43 foreign-namespace control passes in both modes.
**Merge and closure status (verified after the fact).** PR #969 reached green
final-head CI on `3a83560d2af620b92ec176eddead25e442c2b192` (`test`, `smoke`,
`windows-smoke`, `build-push` success; `changelog-duplication` skipped) and was
squash-merged with `--match-head-commit` on that verified head as
[`282cbb0b`](https://github.com/rynfar/meridian/commit/282cbb0bd314b935195dc40bc209acb07131dfe0).
The merged tree `b3a853a0830bc227bdbb47948672e00a4989a99d` is byte-identical to
the validated tree, the squash body is blank and the subject is the PR title, so
the `PR_TITLE` / `BLANK` settings are intact. Post-merge CI on main was green
across `test`, `smoke`, `windows-smoke`, `build-push`, `changelog-duplication`
and `release-please`, with `docker` and `publish` correctly skipped. The
delivery branch `codex/fix-oc-prefixed-client-tools` was deleted; the worktree
was retained.

**Issue #967 is OPEN and must stay open.** It was auto-closed on merge and then
reopened. Cause worth knowing before writing another PR body: that body's
limitation line paired a closing keyword with the issue number in order to deny
it, and GitHub's closing-keyword parser does not read negation — it linked that
as a closing reference. **Never put a closing keyword next to an issue number
in a PR body or commit message, even to deny it**; write "issue NNN stays open"
instead. This paragraph deliberately does not quote the offending phrase, since
a verbatim copy carries the same hazard wherever it is pasted. Verify with
`grep -niE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+'` before
merging. The bodies have been corrected.

**Two fresh data points for #917 / #933, both timeout expiries rather than
logic failures.** Collected incidentally: each appeared on a *docs-only* diff
that cannot influence it, which is what makes them clean observations.

| where | test | duration | mechanism |
|---|---|---|---|
| `windows-smoke` | `process-incarnation.test.ts:123` | 10265 ms | `WINDOWS_PROBE_TIMEOUT_MS` is 10 s. The `powershell.exe` probe in `src/proxy/session/processIncarnation.ts` exceeded it, so `captureProcessIncarnation()` **failed closed and returned `undefined`** — which is the module's documented behavior — while the test asserts the capture is always defined on win32. |
| `test` | `failover-request-id.test.ts:76` | 5002.97 ms | No explicit `it` timeout, so bun's default 5 s applied and expired. An assertion failure would not land on the default boundary to the millisecond. |

Both went green on a later run of the same tree, so they are intermittent, not
newly broken. #917 describes "concurrency tests fail fast, never the same one
twice" — a pool of tests with fixed time budgets on a contended runner produces
exactly that: whichever one is unlucky trips, so the name changes every time.

This is a **candidate mechanism for part of** #917 / #933, not a proof of all of
it, and no frequency has been measured. Two distinct sub-problems if picked up:

- The incarnation test asserts something the module may legitimately not
  provide. That is a genuine test defect and should be corrected by accepting a
  fail-closed capture, not by widening the probe timeout.
- The failover test simply lacks a CI-realistic timeout.

Resist the reflex to loosen assertions across the suite to make CI quiet; that
would mask the concurrency failures #917 is actually about. Start by measuring
which tests run closest to their budget.

**Release Please opened [PR #970](https://github.com/rynfar/meridian/pull/970)
(`chore(main): release meridian 1.68.1`) automatically.** It is NOT authorized
by this review and was not merged. A release needs the owner's explicit
authorization and the release reference in the skill.

**New lead found while landing this checkpoint: `windows-smoke` is
intermittently red for a characterizable reason.** On the checkpoint PR — a
docs-only diff that cannot influence it — `windows-smoke` failed at
`src/__tests__/process-incarnation.test.ts:123`, with
`captureProcessIncarnation()` returning `undefined` after **10265 ms**. That
duration is exactly `WINDOWS_PROBE_TIMEOUT_MS` (10 s) in
`src/proxy/session/processIncarnation.ts`, whose Windows path shells out to
`powershell.exe` via `spawnSync`. The test's own comment budgets "two cold
PowerShell probes at up to 10s each" under a 25 s test timeout.

So the module did what it is designed to do — fail closed when the host probe
is uncertain — while the test asserts the capture is *always* defined on
win32. On a cold or contended GitHub Windows runner the probe exceeds its
timeout and the assertion fails. This is a test-strictness problem, not a
proven product defect, and it is a concrete candidate mechanism for part of
#917 / #933 ("intermittent CI failures", "flaky ~1 in 3").

Scope and honesty limits: this is **one** observation, not a measured
frequency, and it does not explain the concurrency-test failures #917
describes. `windows-smoke` was green on `3a83560d` and on main's `282cbb0b`
immediately before, so it is intermittent rather than newly broken. No fix was
attempted here — that is a separate bounded item, and it should start by
reproducing the timeout rather than by loosening the assertion.

- **Next action:** the remaining issues, in this order of tractability —
  **#861** (auto-defer threshold invalidating the prompt cache mid-session:
  #975 turned auto-defer off for Codex only, the general case stands),
  **#889** (`extractClientCwd` parsing an `<env>` block a plugin may legally
  remove), **#865** (suppressing one startup log, small), then **#820** (pi
  adapter divergence, the highest user impact and the least diagnosed).
  **#895** has a contributor patch in PR #896 that cannot be validated here: a
  real Windows E2E is impossible on this macOS host, and POSIX fixtures are not
  a Windows run. **#769** and **#650** are feature/infra asks needing a product
  decision. Issues **#967** and **#767** are carried with their evidence
  recorded; neither reproduces on main from here. The 21 open `feat` PRs still
  need a product decision each.

## Investigated: #767 does not reproduce live on main

Ran the original report's own recipe against main (`a0ee33f2`) rather than
reasoning from code: real `opencode` 1.18.29 → real Meridian on an isolated
port, isolated `XDG_*`/config/session-store/project dirs, `claude-opus-5`,
genuine read/edit/write/bash tool use, one continuous session per config.

| config | plugins | turns | msgs | opus lineage | `Stale session detected` |
|---|---|---|---|---|---|
| stock | Meridian only | 12 | 49 | 24 continuation / 1 new | 0 |
| plugin stack | + oh-my-openagent, opencode-memory, opencode-worktree, opencode-history-search, openslimedit | 7 | 31 | 15 continuation / 1 new | 0 |

The lone `new` in each is that session's first turn. Zero divergence
diagnostics fired. Cache shape is inverted from the report's fresh-replay
signature — `cacheRead` climbs with the transcript while `cacheCreation` stays
in the low hundreds per turn:

```
stock         cacheCreation  31,199   cacheRead   367,589   ratio 11.8x
plugin stack  cacheCreation  95,707   cacheRead 1,630,777   ratio 17.0x
```

The plugin stack pinned ~67.6k of cache-read on turn one, close to the report's
~54.5k, which is the evidence the stack was genuinely loaded and shaping the
prompt rather than silently absent.

Consistent with `9d283288` (in 1.68.0) having addressed the mechanism:
connor-grady's captures were on 1.62.7, and four of their six were the
`user[tool_result,text]` shape that `appendedBlocksAreNew` now permits. It also
fits tetipong2542's own correction that Opus alone was 82% clean and the failure
required a plugin interaction.

**Do not read this as resolved.** Bounded by: session scale (49 and 31 messages
versus overlaps of 776–797 in the captures); agent profile (default agent, not
oh-my-openagent's "Sisyphus - ultraworker", which drives far longer reasoning);
`opencode-pty` and `opencode-quota` not installed; and one run per config, which
is not a measured rate. Evidence and these limits were posted to #767, which
stays open. Nothing was asked of the reporters — reproduction is our job.

Reproduce with: `/tmp/e767` (stock) and `/tmp/e767b` (plugin stack) harness
layout, Meridian on ports 3499 / 3498. Both are disposable; recreate from the
recipe rather than trusting leftover dirs.

## Delivered: the Codex contributor cluster (#962-#966), all by @justprosh

Five contributor PRs, each cherry-picked with Author/AuthorDate preserved, each
with a separate maintainer commit where live validation demanded one, and each
carrying an explicit `Co-authored-by` trailer in the squash body.

| original | integration | on main | disposition |
|---|---|---|---|
| #962 tier refusal ending in prose | #974 | `94e88cf0` | merged, original closed |
| #963 Codex auto-defer | #975 | `dabd969b` | merged, original closed |
| #964 namespace/custom tools | #976 | `907a00ee` | merged, original closed |
| #965 thread session identity | #977 | — | OPEN, held for owner review |
| #966 mid-conversation developer message | #978 | `4a031b97` | merged, original closed |

**Credit mechanics matter here and are easy to get wrong.** Repository settings
are `PR_TITLE` / `BLANK`, so a plain squash **drops the cherry-picked author
entirely**. Every merge above passed
`--body "Co-authored-by: Aleksey Proshutinskiy <alexey.prosh@fluence.one>"`.
Verify that trailer on the resulting commit; do not assume it appears.

The inverse error also happened once and was caught: a maintainer gate commit
created immediately after a multi-commit cherry-pick **inherited the
contributor's author line**. Falsely crediting a contributor for maintainer test
code is the same class of fault as dropping their credit. Check
`git log --format='%an'` over the series before pushing.

**Two contributor branches track a `node_modules` symlink** pointing at
`/Users/aleksei/dev/meridian/node_modules` (#963 `b9bca255`, #964 `432bead6`).
Both authors' own follow-up commits remove it, so their heads are clean, but
cherry-picking *through* the middle commit replaces a local install with a
dangling link. It happened once here. Only final commits were incorporated where
possible, and main is unaffected.

**Live validation added five gates**, all real proxy plus real SDK: E44
tier-refusal failover, E45 Codex auto-defer, E46 Codex namespace/MCP round-trip,
E47 Codex thread identity (on the #977 branch, not yet on main), E48 Responses
developer-note cache.

**Where live E2E changed the outcome rather than confirming it.** Twice:

- The #962 change was correct for the banner as quoted but insufficient for the
  deployment it was reported from. A gateway profile never delivers the banner
  bare — the SDK splices `API Error: 400` in front, and that numeric status
  defeated the line anchor for every suffix, including the two that already
  worked. `classifyError` returned 429 for the bare string while a live request
  still 500'd. A separate maintainer commit allows exactly three digits.
- A real Codex capture showed the #964 report was understated: the dropped
  namespaces include Codex's own `multi_agent_v1`, so sub-agents were
  unavailable, not only user MCP servers.

**Two of my own gates initially proved nothing and were corrected before
landing.** Recorded because the failure mode is seductive — a check that passes
both before and after looks like evidence. E45's digest-turn count passes either
way at probe scale, so it is reported rather than asserted. E48's first version
asserted cache hit percentage, which barely moves in a 6.5k probe even when the
prefix is re-written; the invariant is the ratio of re-written tokens, 7.8x
pre-fix against 1.2x after. Always confirm a new gate fails against pre-fix
code.

**Verifying contributor claims by capture rather than by reading.** codex-cli
0.153.4 was driven against a recording endpoint under an isolated `CODEX_HOME`
with a real stdio MCP server. That settled the tool shapes
(`{"function":10,"namespace":2,"web_search":1}`), the metadata schema, and the
critical safety property behind #965: for a user-driven thread `thread_id`
equals `prompt_cache_key`, so keying on the thread cannot re-anchor an existing
session. Reproduce with the recipe in E2E.md E46 and E47.

**PR #977 is held, not blocked.** Green on everything: 3665 tests, E47's nine
checks, E41 all four modes, and E46 still 8/8 alongside it. Two honest gaps: a
genuine `thread_source: subagent` request could not be produced locally
(`codex exec` offers `multi_agent_v1.spawn_agent` but does not spawn, so it needs
Codex Desktop), and two of E47's nine checks are guards rather than
discriminators. Its conflict resolution against #976 also merits a second
reader: both conflicting regions were purely additive and both blocks were kept.

## Delivered: issue sweep

Ten issues addressed, each proven live before merge. Eight are now closed, two
(#917 and #933) left open deliberately.

| issue | PR | on main | note |
|---|---|---|---|
| #886 lineage mismatch diagnostic | #981 | `c3ea178b` | closed |
| #874 `max_tokens` not enforced | #982 + #984 | `15529b12`, `14fc9395` | closed, opt-in |
| #893 `mcp__oc__` on every adapter | #983 | `99fc2d7a` | closed |
| #917 / #933 CI flakiness | #986 | `d3bfe795` | left OPEN |
| #906 `/health` lies | #985 | `264cfc3a` | closed |
| #905 container `hostId` | #987 | `b5f73aed` | closed |
| #861 auto-defer flip mid-session | #991 | `68c0eca6` | closed |
| #889 degraded fingerprint invisible | #992 | `824bbbfa` | closed |
| #865 startup banner under MERIDIAN_QUIET | #993 | `0e773b56` | closed |
| #842 + #847 first-turn 400 | none | none | closed on evidence, no code change |

**#842 and #847 were retired on evidence rather than code.** Five fresh
real-OpenCode sessions on current main: 0 client-side 400s, 0 proxy
`session_turn_conflict`, and a maximum `sessionWait` of **7 ms** against the
6360 ms the report measured. The title agent now runs as `agent=subagent` with
its own key, so the collision those reports describe cannot occur — the #845
agent-scoping work already handled them. Limit stated on both: haiku for primary
and small; an Opus primary could not be dispatched under the isolated config.

**Three new Docker-based gates**, which this repo had none of before. E51 (boot
identity) and E52 (host identity) reproduce failures that are properties of the
HOST and unreachable from a single process; both skip cleanly without Docker and
cost no tokens. `oven/bun:1-slim` ships with no `/etc/machine-id`, which is
issue #906's environment verbatim.

**Where proving it changed the answer rather than confirming it.** Three times:

- Issue #874: the SDK exposes no output cap at all, and the CLI's
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` **throws** instead of truncating. Wiring it
  naively converts a satisfiable request into a hard error. It works only
  because the API really stops generating first — probed at a cap of 64, the
  turn produced real text and *then* threw.
- Issue #874 again: enforcing it broke the E44 gate at `max_tokens: 128`,
  because the cap counts thinking plus text. An A/B against pre-change source
  confirmed the regression was mine, which is why it shipped **off by default**.
- Issue #906: the first revision refused to start on the first failed probe.
  That is right for Linux, where identity is read from files, but darwin and
  win32 derive it from a subprocess with a 10s budget — and a 10265 ms expiry
  was recorded on Windows CI during this very run. Refusing on a transient
  timeout would turn a slow host into a dead one, so startup retries three times
  first.

**Issues #917 and #933 stay open on purpose.** Two sightings were diagnosed and
corrected — both time-budget expiries, and `failover-request-id` measured at
**4.05 s against bun's 5 s default**. A scan of every I/O test without an
explicit timeout found no other single test near the boundary. But neither is a
concurrency test, and #917 is specifically about concurrency tests failing fast
and never the same one twice. **Do not widen timeouts across the suite** to
quiet CI: that would mask exactly what #917 is about.

**Gate quality discipline, because it bit repeatedly.** Four gates written this
session initially asserted something that passed both before and after the
change, which reads as evidence and is not:

- E45's digest-turn count (now reported, not asserted).
- E48's cache **hit percentage** — barely moves in a 6.5k probe; the invariant
  is the **ratio of re-written tokens**, 7.8x pre-change against 1.2x after.
- E49's default-off check used an absolute token threshold; now relative to the
  capped run.
- E44 asserted the model echoed a receipt verbatim and was flaky at ~1 in 3.
  Instrumented: the model complied once in five runs while the fallback answered
  every time. It now asserts the fallback produced text.

**Always confirm a new gate fails against pre-change source.** Every gate above
has its measured before/after recorded in E2E.md.

## Delivered: issue #820, both halves

**Item.** [Issue #820](https://github.com/rynfar/meridian/issues/820) — "pi
adapter: 99.8% of long conversations diverge to `lineage=new` with no
diagnostic", reported by @odfalik, with independent reproductions from
@RobertoNegro and a second adapter's case from @StanChmielewski, plus a
structural analysis of the missing diagnostics from @connor-grady.

**Disposition.** Accepted, delivered as two maintainer PRs. No contributor
commits existed, so there is no cherry-pick author mapping; all four are
credited in the PR bodies and three carry `Co-authored-by` trailers on the
diagnostic commit (their extension code ships in the docs, and the
request-line design is @connor-grady's proposal).

| PR | on main | what |
|---|---|---|
| [#994](https://github.com/rynfar/meridian/pull/994) | `ac8bd6c2` | every divergence names itself; the bypass advice; docs; gate E54 |
| [#995](https://github.com/rynfar/meridian/pull/995) | `7375351` | the gateway-fronted Claude Code exemption; gate E55 |

#994 was based on `0e773b56`; #995 was rebased forward twice as main moved and
merged from `d075cc7c`. Worktrees
`/Users/rynfar/repos/meridian-wt/lineage-divergence-reasons` and
`/Users/rynfar/repos/meridian-wt/passthrough-cc-session`; the before-code
baseline is `/Users/rynfar/repos/meridian-wt/divergence-reason-baseline`
(detached at `0e773b56` — do not delete, it is the failed-before evidence).

**#994 — the diagnostic half.** The request line now carries `diverged=<reason>`
on every divergence, and `independent-request` names which of its four rules
fired. `isIndependentSession` is *derived* from the new pure
`independentRequestCause` rather than computed beside it, so the printed label
cannot drift from the decision it explains. `classifyLineage` also names
`unverifiable`, `replayed-request` and `unrelated-history`; `not-found` stays on
the request line only, because it is the first turn of every conversation. The
headerless tool-result bypass warns once per process, matching the
degraded-fingerprint precedent.

`diverged=` is a separate field rather than a wider `lineage=` value on purpose:
`e2e-passthrough-turns.mjs` and field log analysis match
`lineage=<value> session=` as one unit, and a test pins that adjacency.

**#995 — the gateway half.** The tool-loop exemption follows the *client* now,
not the adapter: `adapterBase === "claude-code" || isClaudeCodeClient(c)`, where
`isClaudeCodeClient` reads `x-claude-code-session-id`. Behind LiteLLM the
passthrough heuristic claims the request first, so Claude Code lost the
exemption, and LiteLLM does not forward `x-litellm-session-id` upstream on the
`anthropic/` provider route, so it had no key either.

**The live gate changed this fix — read this before revisiting it.** The obvious
change was to read `x-claude-code-session-id` as a session key in
`passthroughAdapter.getSessionId`. That was built first, and the header is
genuine: verified against Claude Code 2.1.266 that it is the CLI session UUID,
pinned exactly by `--session-id`. Driving the **real CLI** showed it makes
auxiliary requests under the same session id, so two unrelated first messages
land under one key — `unrelated-history`, then `HTTP 400 This session advanced
while the request was waiting`. That converts a silent inefficiency into a hard
client failure. Two of E55's ten checks exist solely to guard that approach.
Suggestion 2 from the report (routing on the header in `detect.ts`) was declined:
it would swap tool handling, MCP naming and prompt shape for every existing
LiteLLM user and move their cache prefix.

**Evidence.** `npm test` 3765 pass / 1 skip / 0 fail for #994 and 3775 / 1 / 0
for #995, both on bun 1.3.11 to match CI; typecheck and build clean; E41 all
four modes on both; E54 and E55 pass. Failed-before runs are recorded in each PR
body with the exact assertion output.

**Gates added.** E54 `e2e-lineage-divergence-reason.mjs` — a real headerless pi
tool loop against the same loop with `x-session-affinity`, asserting that no
divergence is silent and that the remedy the log names works. It reproduces the
report's cache signature at probe scale: `cache_read` pinned at 5789 while the
conversation grows against 6562 → 6811 → 6919 when keyed, and a per-round
cache-write ratio of 6.5x-7.2x across three runs. E55
`e2e-passthrough-claude-code-session.mjs` — the **real Claude Code CLI** as the
client against a passthrough Meridian, skipping cleanly when `claude` is absent.

**Two things E54 taught that are not in the report.** A headerless passthrough
loop recovers through the durable checkpoint *exactly once*: the checkpoint
upgrade rewrites the lineage result but leaves the request independent, so the
end-of-turn store is skipped and the checkpoint never advances past the first
tool call. That explains the reporter's 10 continuations against 6,019 `new` at
1000+ messages. And the bypass cannot be safely relaxed to "resume when lineage
verification passes": several identical concurrent loops match at the prefix,
which is the collision the guard exists to prevent.

**Found while validating, and it was ours: [#996](https://github.com/rynfar/meridian/issues/996).**
The passthrough adapter never resumed a client-driven tool round even with a
session key it does read. Filed as an unexplained asymmetry, then diagnosed as
a regression from #983 and fixed — see its own section below. #820 is closed on
its own asks.

**Local environment note for whoever runs the suite next.** CI uses bun 1.3.11
(`oven-sh/setup-bun@v2`). Two test files are bun-version-sensitive and will
report false failures on other versions: `dependency-uri-resolution.test.ts`
fails 4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both
pass on 1.3.11 and on unmodified main. Match CI's version before attributing a
failure to a change.

## Delivered: #996, a regression from our own #983

**Item.** [#996](https://github.com/rynfar/meridian/issues/996), filed during
the #820 validation: the `passthrough` adapter never resumed a client-driven
tool round, even with the session key it reads. `pi` and `opencode` resumed the
identical shape.

**Disposition.** Accepted as a maintainer fix. Delivered in
[PR #998](https://github.com/rynfar/meridian/pull/998), merged `0538a98b`, worktree
`/Users/rynfar/repos/meridian-wt/early-stop-namespace`, base `7375351`. The
before-code baseline is `/Users/rynfar/repos/meridian-wt/pre-983-baseline`
(detached at `15529b12` — do not delete, it is the bisect evidence).

**Cause, and it is ours.** #983 gave each adapter its own passthrough
client-tool namespace, so the LiteLLM adapter registers client tools as
`mcp__litellm__*`. The early-stop tracker freezes the resume checkpoint and
arms by matching those names, but `noteAssistantMessage` called
`noteAssistantContent` **without a prefix parameter**, so it only ever matched
the default `mcp__oc__`. `server.ts` threads `clientToolPrefix` into the two
`isClientForwardedToolUse` sites and could not thread it here. On the
passthrough adapter nothing entered `expected`: no checkpoint UUID, no stored
`passthroughToolCallIds`, so `advancesDurableCheckpoint` could never fire.

`isClientForwardedToolUse` is strict about foreign `mcp__*` names by design,
which is what made the missed call site silent. #983's own test file pins the
hazard — `it("would reject that same tool under the default prefix")` — so the
assertion existed and a call site that trips it was still missed.

**Bisect, `pi` as the control:**

```
15529b12 (pre-#983)   pi 3/3 continuation   passthrough 3/3 continuation
96dc5605 (main)       pi 3/3 continuation   passthrough 0/3
with the fix          pi 3/3 continuation   passthrough 3/3 continuation
```

**Gate E56** drives an identical keyed tool loop on `pi`, `passthrough` and
`opencode`. Its load-bearing assertion is that all three **agree** on the
tool-round shape. That is the transferable lesson: a single-adapter gate passed
throughout this entire regression, because each adapter looks self-consistent
on its own. Anything that makes behaviour per-adapter needs a cross-adapter
gate, not a deeper one.

Six unit tests in `early-stop-namespace.test.ts` pin the threading; three of
them fail on `main`.

## Delivered: race-harness deflake (#997), and what #917/#933 still need

PR #995's `test` check failed on
`does not refuse the user's turn that queued behind an in-flight title turn`.
Causality was established before anything was changed: for a request carrying
`x-opencode-session` the new term in `isClientDrivenLoop` cannot alter the
decision, and **the same test had already failed on main** at `264cfc3a`
([run 34315620193](https://github.com/rynfar/meridian/actions/runs/34315620193)),
hours before that branch existed.

**The shape, now named.** Poll to a short wall-clock deadline, then assert on
what the poll observed. The title-lease harness gave the user's turn 100 ms to
traverse the route handler and then asserted a boolean, so a loaded runner
fails with `Expected: true, Received: false` and says nothing about timing. It
occurs three times, all fixed in #997:

| file | was | now |
|---|---|---|
| `opencode-title-agent-collision` | 100 ms poll | a signal from the SDK mock |
| `proxy-stream-deny-hold` | 1.5 s, then `toContain` | 5 s, timeout names itself |
| `concurrency-hardening` | 3 s, then `toEqual` | 5 s, timeout names itself |

Two controls were added and **verified by inverting them**, because raising a
ceiling from 100 ms to 10 s could otherwise make the assertion unfalsifiable: a
non-title prompt in the title lease scope (contends, must report `false`), and a
second title turn on one session (must not reach the SDK call while the first is
held).

**#917 and #933 stay open, deliberately.** The same CI run also failed
`Session tool cache > updates cached tools when client sends a new set`, which
has no timing bound at all — three sequential requests and an assertion that the
third inherits the cached tool set — so this diagnosis does not cover it, and it
did not reproduce locally. Run 34315145910 failed
`Extra usage required fallback > does not use exponential backoff`, also
unexplained. **Leave #917 and #933 open; #997 does not settle them.**

## Previous checkpoint: Meridian 1.70.0

[Meridian 1.70.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.70.0)
shipped through [release PR #1006](https://github.com/rynfar/meridian/pull/1006),
authorized explicitly by the owner. **Published and installed-package
validated** — not merely merged. Do not republish it.

| | |
|---|---|
| Candidate tree | `c925dbba` (parent `c3dc2279`), all four checks green |
| Release PR head | `c925dbba`, merged with `--merge --match-head-commit` |
| Release/tag commit | `0acf3b1906f7b16a9bf507925bf1998b9931cd2f` |
| npm | `1.70.0`, `latest` → `1.70.0` |
| Tarball integrity | `sha512-/EqHIcKAv7TvlScooHmGxePSmrOpXehtY8fh433NBBoNh+UKjNtyIfKPxIOo0X+n/zoCf5iGrYUwO3TH5gxQHA==` (shasum `184f4eb5…866f`) |
| SLSA provenance | `gitCommit: 0acf3b19…`, workflow `.github/workflows/release-please.yml`, subject `pkg:npm/@rynfar/meridian@1.70.0` |
| Docker | `1.70.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release workflows on `0acf3b19` | CI, Release Please, Docker, Sync bun.nix — all success |

Provenance was verified by **content, not presence**: the attestation's
`resolvedDependencies.digest.gitCommit` equals the tag commit.

Changelog, one entry per PR: `feat` Polytoken harness adapter (#1010) and
OpenCode V2 model discovery (#1004); `fix(errors)` disabled subscription
entitlement classified as billing (#1012).

**The candidate's own CI had to be approved to run at all.** Release Please
branches arrive as bot pull requests whose workflows sit at `action_required`.
For 1.69.0 nobody approved them and all four expired as `failure`; that release
merged on the strength of CI on `main` instead. This time the four runs on
`c925dbba` were approved and all four came back green before the merge. **Do
this every release** — `gh api -X POST repos/rynfar/meridian/actions/runs/<id>/approve`
for each run on the release head — otherwise the candidate tree is never
actually built.

**Gates run before the merge, all green.** `npm test` 3880 pass / 1 skip / 0
fail on bun 1.3.14; typecheck; build; `e2e-client-detection.mjs` with three real
clients and no fixture drift (opencode 1.18.29, crush 0.87.0, Polytoken 0.8.6);
`e2e-error-telemetry.mjs` PASS on all four cases with live Claude Max failover;
`e2e-opencode-package-integrity.mjs` with and without `--manifest`; **E42
`--live --extended --separate-proxy-cwd` against both pinned betas**
(`0.0.0-beta-18314` and `0.0.0-beta-18866`), each self-verifying its own version,
each run against the **packed 1.70.0 consumer** rather than the source tree, both
reporting 100% cache reuse on ordinary continuation and on process restart.

Note on `npm ci` in this repo: it fails. `bun2nix`'s postinstall runs with its
own package directory as cwd and cannot find `bun.lock`, so dependencies never
install and `tsc` is absent. Use `bun install --frozen-lockfile`.

**Installed-package validation** drove the published artifact, not the source
tree: a clean `npm install @rynfar/meridian@1.70.0`, the installed CLI started
as a real `node` subprocess, `/health` reporting `1.70.0` with
`build.source=npm`, and a keyed client-driven tool loop on every adapter that
keys its own sessions:

```
  PASS  pi           toolRounds=3 resumed=3
  PASS  passthrough  toolRounds=3 resumed=3
  PASS  opencode     toolRounds=3 resumed=3
  PASS  polytoken    toolRounds=3 resumed=3
```

`polytoken resumed=3` is the new line this release: #1010's adapter resumes its
own keyed tool rounds in the shipped artifact, not only in the source gate. The
same loop was run first against the locally packed tarball and then against the
registry download, with identical results.

**An environment trap that will cost the next agent an hour.** On this machine
the `personal` profile's OAuth has expired. A run with an isolated
`MERIDIAN_CONFIG_DIR` defaults to that profile and every request fails with
`Failed to authenticate: OAuth session expired and could not be refreshed`,
which looks exactly like a release regression. It is not: seed the disposable
config from `~/.config/meridian` and send `x-meridian-profile: work`. For the
same reason `/health` reports `status: degraded` / `Could not verify auth
status` — **confirmed pre-existing by installing published 1.69.0 and getting
the byte-identical response**. Run that control before believing a health
regression.

**Known limitation, ticketed as
[#1014](https://github.com/rynfar/meridian/issues/1014).** The E42 gate
now always exits 1, even on a fully passing run, and it cannot exercise #1004's
model discovery at all. Its recording fixture calls `request.json()`
unconditionally, so the body-less `GET /v1/models` that discovery issues throws
`SyntaxError: Unexpected end of JSON input`; in live mode the same handler also
forwards with a hardcoded `method: 'POST'`. Causality was established by A/B on
an otherwise identical tree:

| fixture | `result` | `GET - /v1/models failed` | exit |
|---|---|---|---|
| as shipped | `PASS` | 5 | **1** |
| patched to answer non-POST | `PASS` | 0 | **0** |

This is test infrastructure only — 1.70.0 ships the feature unaffected, and
discovery against a real Meridian was verified by hand during #1004. But the
gate's exit code is now meaningless, and the feature has no automated live
coverage. The probe patch was reverted; the candidate tree was confirmed
pristine at `c925dbba` before the merge.

## Earlier checkpoint: Meridian 1.69.0

[Meridian 1.69.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.69.0)
shipped through [release PR #970](https://github.com/rynfar/meridian/pull/970),
authorized explicitly by the owner. **Published and installed-package
validated** — not merely merged. Do not republish it.

| | |
|---|---|
| Candidate tree | `04f65101` ([CI success](https://github.com/rynfar/meridian/actions/runs/34394242824)) |
| Release PR head | `e52f453c`, merged with `--merge --match-head-commit` |
| Release/tag commit | `3d38f6987632cd798b092c4d1dd83231f8ea3280` |
| npm | `1.69.0`, `latest` → `1.69.0` |
| Tarball integrity | `sha512-4ZN4BR9lFMRqFjzWdldT2+Z4weaDJVZWLGov6nW0xJBvVU3yn+jFywGMzPAnsPvljvOhpbCvacja79/Ca82iKg==` |
| SLSA provenance | `gitCommit: 3d38f698…`, workflow `.github/workflows/release-please.yml`, subject `pkg:npm/@rynfar/meridian@1.69.0` |
| Docker | `1.69.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release workflows on `3d38f698` | CI, Release Please, Docker, Sync bun.nix — all success |

Provenance was verified by **content, not presence**: the attestation's
`resolvedDependencies.digest.gitCommit` equals the tag commit. An attestation
that merely exists says nothing about what was built.

**Gates run before the merge, all green.** `npm test` 3793 pass / 1 skip / 0
fail on bun 1.3.11; typecheck; build; E41 all four modes; E54; E55 three runs;
E56; **E42 live+extended against both pinned betas** (`0.0.0-beta-18314` and
`0.0.0-beta-18866`, each verifying its own version in-output because the beta
CLI can self-update); `e2e-opencode-package-integrity.mjs` with and without
`--manifest`.

E42 was required here for a non-obvious reason worth remembering: this release
looks V1-only, but #988 generalized `package-meridian-v2-plugin.mjs` into
`package-opencode-plugins.mjs`, which also emits the **V2** manifest. The
pinned betas had to be reinstalled because the gate's isolated installs live
under `/tmp`.

**Installed-package validation** drove the published tarball, not the source
tree: a clean `npm install @rynfar/meridian@1.69.0`, the installed CLI started
as a real subprocess, `/health` reporting `1.69.0`, and the keyed tool loop run
on all three adapters:

```
  PASS  pi           toolRounds=3 resumed=3
  PASS  passthrough  toolRounds=3 resumed=3
  PASS  opencode     toolRounds=3 resumed=3
```

`passthrough resumed=3` is the load-bearing line: it proves #998's fix is in
the shipped artifact. #983 introduced that regression during this same cycle,
so no released version ever carried it — which is why both entries appear in
one changelog.

**One gate had to be corrected mid-validation.** E55 was asserting pre-#998
behaviour and failed on correct behaviour; fixed in #1001 before the release
merge. The process miss: #998 changed the passthrough tool loop and only the
new gate (E56) was re-run, not the existing gates on the same path. Re-run
every gate that touches a changed path, not just the one written for it.

## Earlier checkpoint: Meridian 1.68.0

[Meridian 1.68.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.68.0)
shipped through [release PR #937](https://github.com/rynfar/meridian/pull/937).
Its release/main commit at this checkpoint was
`58f8a70402fce471712cd4650f721afcb80f05d7`, tree
`427fbc82761e163d6fbf9621a8fb2e88ac260081`. Do not republish it.

- [Release Please, npm and semver Docker publication](https://github.com/rynfar/meridian/actions/runs/33998609223): successful.
- [Post-merge CI](https://github.com/rynfar/meridian/actions/runs/33998609125),
  [Docker latest](https://github.com/rynfar/meridian/actions/runs/33998609160) and
  [Nix builds/cache uploads](https://github.com/rynfar/meridian/actions/runs/33998609115): successful, including the formerly pending cache uploads (rechecked September 8).
- Recorded release validation: 3601 tests passed, one existing skip, no failures;
  typecheck/build; all four real E41 modes; installed-package OpenCode V1 and
  extended V2 flows; structured output and package-integrity gates; published
  package live V2; verified registry signatures and SLSA provenance matching the
  release commit. This is historical evidence for that candidate, not a substitute
  for tests on future changes.
- Frozen install used SDK0.2.141/Claude Code2.1.259; fresh npm package gates used
  SDK0.2.141/Claude Code2.1.261. Actual clients: V1 1.18.11 and V2 beta18866
  (extended live, separate working directories), plus beta18314 scripted package
  compatibility. Do not describe the beta18314 release check as extended live.

Last completed implementation: [#961](https://github.com/rynfar/meridian/pull/961),
merged `1ae1810dc2a24250c4a3f4d21546b03e56b9b388`, incorporating original #836 and
resolving #829. Original `57e3091c` retained as
`abd410192cfcb706c7649ce3e0f65f5fa73e6008` with Trevor Walker's author/date;
maintainer corrections `25b895a6ccb9e1182257bd3089d7b055d4085132`. The final tree
`19ecf09794f9545b93f5119af35255ab9fecd99d` matched the merge. Actual SDK billing
refusal/failover and account/model telemetry were verified in both response modes.
Original #836 and issue #829 are closed.

Immediately preceding it, [#960](https://github.com/rynfar/meridian/pull/960)
incorporated #868 and merged `6365ae0ed5445fbf6ea5c89055919570a7c76406`.
Actual V1/beta18866 idle retry bounds and recovery, beta18314 compatibility,
four E41 modes and full tests passed. Original #868 is closed.

Earlier delivered integration PRs in this review run: #938, #939, #940, #941,
#944, #945, #948, #949, #950, #952, #953, #954, #955, #956, #957, #958 and #959.
Inspect their final diffs and linked original PRs before redoing overlapping
work. In particular, #953 did **not** establish that #917/#933 were fixed.
The already-merged structured-output implementation #930 was validated and
released; original #898 was closed as superseded.

## Next item to triage on resumption

Live at this checkpoint: refresh the counts; do not act on any written here.
#820 and #996 are both fully addressed and were closed once #998 merged, so the
live issue list should be shorter than this table.

#1014 (#1016), #1008 (#1018), #1011's two landable commits (#1022) and #1009's
commit (#1025) are all **delivered**; their sections are above. #1011 and #1009
both stay open with narrowed scope recorded in their own bodies. The contributor
backlog below is now the whole remaining queue. They are
ours, fully diagnosed, and each carries a reproduction and acceptance criteria —
so they are cheaper to pick up than any contributor report below.

| ticket | state at this checkpoint |
|---|---|
| #1009 uncaptured-tool recovery | **landed off by default** (#1025). Open for a live abort-window gate, the non-streaming parity decision, and the canary |
| #1011 the last held passthrough commit | two of three landed (#1022); `c5804275` deferred by owner — it changes a gate-defended contract and adds a stream/non-stream asymmetry. Evidence in the ticket body |

| issue | state at this checkpoint |
|---|---|
| #996 passthrough never resumes a tool round | filed, bisected to our own #983, fixed in [#998](https://github.com/rynfar/meridian/pull/998), `0538a98b` |
| #917 / #933 CI flakiness | one mechanism removed in #997; two failures still unexplained. Do NOT close on #997 |
| #967 headless bg-job respawn loop | Meridian half fixed in #969; the rest needs the reporter's tool list |
| #895 Windows session GC | contributor PR #896 exists and **cannot be validated here** — no Windows host, and POSIX path fixtures are not a Windows run |
| #820 pi/gateway lineage | both halves delivered (#994, #995); remainder is #996 |
| #767 Opus resume divergence | investigated, does not reproduce live on main; evidence recorded above |
| #769 OpenClaw scrub plugin | feature proposal, needs a product decision |
| #650 plugin-input bumps | infrastructure proposal, needs a product decision |

Contributor backlog still untouched: #896 (Windows session GC, cannot be
validated here), #849, and roughly 21 `feat` proposals, mostly from one
contributor, each needing a product decision before technical review.

**#917/#933 is the strongest remaining contributor-reported item**, and it needs a
different approach from the one that has been tried. #997 removed one confirmed
mechanism; the two remaining failures
(`Session tool cache > updates cached tools when client sends a new set`, and
`Extra usage required fallback > does not use exponential backoff`) have no
timing bound and did not reproduce locally. Neither is a concurrency test in
the sense #917's title claims, which is itself worth noting: the issue's own
framing may be wrong. Consider capturing a failing CI run's full ordering
rather than reasoning from the assertion text.

**A caution from #996, which was our own regression.** Anything that makes
behaviour per-adapter needs a **cross-adapter** gate. A single-adapter gate
passed through that entire regression because each adapter looked
self-consistent on its own, and the defect was only visible as an asymmetry.

Roughly 21 of the open PRs are `feat` proposals, mostly from one contributor.
The owner asked to skip those during the issue sweep; each still needs a
per-PR product decision about whether the behavior is wanted before any
technical review is worth doing.

Pick one bounded item. Each is a report or proposal, **not a verified root
cause, a proven regression, or an approved implementation**. Reproduce with
bounded attempts and isolated fixtures, establish which component owns the
behavior, and validate the affected model/client versions — a passing Haiku run
neither disproves nor resolves an Opus report. Do not read private SDK
transcript files referenced in an issue; use supported APIs and controlled
reproduction.

### A closing keyword closed an issue this checkpoint was told to keep open

PR #997's body contained a sentence of the form "It does not `resolve` `#917`",
written specifically to say the issue stays open. GitHub's linked-issue parser
matches the keyword-then-number pattern and ignores the negation, so merging
merging #997 shut #917. #933 survived only because the second number in the
same sentence had no keyword in front of it. #917 has been reopened, the phrasing is
edited out of #997's body, and the issue carries a comment explaining that its
status did not change.

This is the second occurrence of the same hazard in this backlog — #969 shut #967 with a
"Does not `close` `#967`" line. The guard exists and was not applied at the
right moment: it had been run against issue comments and not against PR bodies.

**Before creating or merging any PR whose body discusses an issue it does not
fix**, grep the body for
`(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#[0-9]+`
and require zero hits. Prefer "issue NNN stays open"; never place the keyword
adjacent to a number, even inside a quotation documenting the hazard.

### Two environment facts that will otherwise cost an hour

**Match CI's bun version before attributing a test failure to a change.** CI
uses bun 1.3.11 (`oven-sh/setup-bun@v2`). Two files are bun-version-sensitive
and report false failures elsewhere: `dependency-uri-resolution.test.ts` fails
4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both pass
on 1.3.11 and on unmodified main.

**Commit as the repository's configured identity.** `main` has
`required_signatures` enabled. A commit authored under an email that is not on
the GitHub account verifies as `no_user`, and the merge is refused with "the
base branch policy prohibits the merge" with no mention of signatures. Use the
repo's `user.email`; do not substitute one from the environment.

## Checkpoint: 2026-09-18 (Autonomous Review Session)

### Completed items in this review session

1. **Issue #1027 (`Supported OpenCode V2 betas are ~400 revisions behind`)**:
   - Delivered in PR #1060 (`303ce0d0`).
   - Extended pinned OpenCode V2 beta range through `0.0.0-beta-18866`.
   - Closed Issue #1027.

2. **Contributor PR #771 (`feat(profile): create the profile when profile login names an unknown one`) by @Nowaker**:
   - Delivered in PR #1061 (`96a75ac5`).
   - Auto-creates profile on login if named profile does not exist.
   - Closed PR #771 as incorporated.

3. **Contributor PR #765 (`chore: update plugin flake inputs`) by @Nowaker**:
   - Delivered in PR #1062 (`865b8331`).
   - Updated Nix flake inputs for plugins and flake-parts.
   - Closed PR #765 as incorporated.

4. **Contributor PR #772 (`feat(dev): MERIDIAN_CREDENTIALS_READONLY, for a second instance on shared credentials`) by @Nowaker**:
   - Delivered in PR #1064 (`b7b820e9`).
   - Adds `MERIDIAN_CREDENTIALS_READONLY=1` support preventing secondary instances from modifying shared credential stores.
   - Closed PR #772 as incorporated.

5. **Contributor PR #773 (`feat(cli): print the dashboard when the port is already serving Meridian`) by @Nowaker**:
   - Delivered in PR #1065 (`a80a15e2`).
   - Adds pre-flight port probing: when port is already running Meridian, displays terminal dashboard and exits 0 instead of failing `EADDRINUSE`.
   - Added `meridian status` command.
   - Closed PR #773 as incorporated.

6. **Contributor PR #774 (`fix(config): make MERIDIAN_CONFIG_DIR relocate the directory, not one file in it`) by @Nowaker**:
   - Delivered in PR #1066 (`c07cefd4`).
   - Relocates all Meridian configuration files (`profiles.json`, `profiles/<id>`, `adapter-instances.json`, `sdk-features.json`, `model-pricing.json`, `telemetry.db`) under `MERIDIAN_CONFIG_DIR`.
   - Keys 5s disk caches by resolved path.
   - Stabilized `desktop-manager.test.ts` shutdown race under recovery.
   - Closed PR #774 as incorporated.

7. **Contributor PR #818 (`fix(profiles): loggedIn is not true if the profile has no token`) by @Nowaker**:
   - Delivered in PR #1069 (`1cfd9805`).
   - Fixes `readCredentialFile` and `discoverProfiles` to verify that a profile's credential file contains a valid, non-empty access token before marking `loggedIn: true`.
   - Surfaces "Sign-in required" on cards and tray if a credential file exists without a valid token.
   - Desktop parity in `apps/desktop/src/renderer.ts` and `apps/desktop/src/trayRenderer.ts`.
   - Closed PR #818 as incorporated.

8. **Contributor PR #795 & #804 (`fix(profiles): remember the account's plan at headless login` & `fix(profiles): backfill the plan on token refresh`) by @Nowaker**:
   - Delivered in PR #1070 (`85f87f74`).
   - Persists account plan fields (`subscriptionType`, `rateLimitTier`) returned by Anthropic OAuth during headless profile login.
   - Backfills missing plan fields during background OAuth token refresh into `profiles.json`.
   - Adds unit tests in `src/__tests__/profile-login-plan-fields.test.ts` and `src/__tests__/token-refresh-plan-backfill.test.ts`.
   - Closed PR #795 and #804 as incorporated.

9. **Contributor PR #824 (`feat(usage): keep the last good usage reading when rate-limited, and mark cached facts`) by @Nowaker**:
   - Delivered in PR #1071 (`46c10563`).
   - Retains the last successful quota and usage reading when upstream rate limits (`429`) occur, preventing quota displays from flipping to blank/missing.
   - Tags cached facts with provenance (`cached: true`) in web telemetry and desktop UI.
   - Closed PR #824 as incorporated.

10. **Contributor PR #819 (`feat(health): /livez and /readyz liveness and readiness probes`) by @Nowaker**:
    - Delivered in PR #1072 (`0d3d30c2`).
    - Implemented `/livez` (lightweight process health) and `/readyz` (full subsystem readiness) probe routes for Kubernetes and supervisor environments.
    - Verified route auth auditing and added unit tests in `src/__tests__/health-probes.test.ts`.
    - Closed PR #819 as incorporated.

11. **Contributor PR #826 (`feat(routing): say when an account is refusing, and route around it`) by @Nowaker**:
    - Delivered in PR #1075 (`a5596f25`).
    - Proactive allowance refusal routing: detects 5h vs 7d quota bucket exhaustion and preemptively routes around spent profiles to prevent avoidable upstream 429s.
    - Exposes refusal rationale in `/quota` and UI cards.
    - Closed PR #826 as incorporated.

12. **Contributor PR #833 (`feat(telemetry): show the route chain, refusal load, and telemetry retention`) by @Nowaker**:
    - Delivered in PR #1076 (`cfe13038`).
    - Telemetry route attribution: exposes the full failover hop chain, per-profile served/refused tallies, and refusal metrics across web and desktop.
    - Closed PR #833 as incorporated.

13. **Contributor PR #776 & #777 (`feat(dashboard): dim spent accounts and offer a sort that sinks them` & `feat(profiles): also dim spent accounts on /profiles`) by @Nowaker**:
    - Delivered in PR #1077 (`f1bb2d5f`).
    - Visual dimming/fading of spent accounts and view sorting tabs (`Configured`, `Most used`, `Least used`) on both web dashboard and desktop manager.
    - Closed PR #776 and #777 as incorporated.

14. **Contributor PR #775 (`feat(profiles): reorder the profile pool by drag or keyboard, on both pages`) by @Nowaker**:
    - Delivered in PR #1078 (`2268eef0`).
    - Drag-and-drop and keyboard reordering (`Alt+Up` / `Alt+Down`) for profile failover priority in the pool, synced with desktop ordering.
    - Closed PR #775 as incorporated.

15. **Contributor PR #841 (`feat(profiles): rename a profile from the CLI and web UI`) by @Nowaker**:
    - Delivered in PR #1079 (`fe9c69d1`).
    - Profile renaming CLI (`meridian profile rename <old> <new>`) and Web UI modal. Automatically manages legacy alias redirects and updates desktop state.
    - Closed PR #841 as incorporated.

16. **Contributor PR #778, #779, #849 (`feat(settings): overhaul settings layout with routing first, harness tabs, and telemetry storage`) by @Nowaker**:
    - Delivered in PR #1080 (`1ff2c678`).
    - Settings reorganization into dedicated tabs (Routing, Telemetry retention, Harnesses/Adapters), plus sqlite telemetry retention tuning.
    - Closed PR #778, #779, and #849 as incorporated.

17. **Contributor PR #803 (`feat(profiles): say what plan an account is on, and how much usage it buys`) by @Nowaker**:
    - Delivered in PR #1081 (`ce68af8f`).
    - Visual plan badges and dynamic multiplier chips (`1x`, `5x`, `20x`) based on tier allowance across web dashboard, desktop manager, and tray renderer.
    - Closed PR #803 as incorporated.

18. **Contributor PR #822 (`feat(profiles): show the organization an account belongs to, and its details on hover`) by @Nowaker**:
    - Delivered in PR #1082 (`7651b3ea`).
    - Discovers Anthropic organization name and surfaces it with hover detail in web cards, desktop manager, and tray tooltips.
    - Closed PR #822 as incorporated.

19. **Contributor PR #805 (`feat(auth): log every property Anthropic returns during authentication`) by @Nowaker**:
    - Delivered in PR #1083 (`944e7971`).
    - Safe property logging during Anthropic authentication exchange with safe string key allowlisting.
    - Closed PR #805 as incorporated.

20. **Contributor PR #780 (`chore(opencode): pre-approve Meridian's own directories, refuse its credentials`) by @Nowaker**:
    - Delivered in PR #1084 (`a93da86c`).
    - OpenCode pre-approved project permissions in `.opencode/opencode.json`, explicitly denying access to credential storage while granting proxy cache/config.
    - Closed PR #780 as incorporated.

21. **Contributor PR #782 & #806 (`feat(profiles): follow mode with active profile and roster adoption`) by @Nowaker**:
    - Delivered in PR #1085 (`dacc1b1b`).
    - `MERIDIAN_FOLLOW_ACTIVE` engine allowing follower instances to mirror a primary instance's active profile and adopt shareable file-backed profiles.
    - Desktop Parity: Desktop header notice surfaces followed status and stale alerts; active card and tray reflect follow state; local switching is gracefully disabled with explanatory tooltips.
    - Closed PR #782 and #806 as incorporated.

22. **Release 1.73.0 (PR #1053) & Test Isolation (PR #1087)**:
    - Delivered and published in Release Please workflow run `35468508440`.
    - Candidate head SHA: `58a563b4845ffc771cd5eb4e787fc2feb7a4509f`.
    - Merged with exact match to `main`: `0cfda823e418a5560e33c33f63f831ed92973bbf`.
    - Scope included PR #1087 (`8eac9254`) isolating Claude SDK mock in follow-active tests to eliminate global mock leakage across test files.
    - All 4 release workflow jobs passed:
      - `release-please` (tag `meridian-v1.73.0`, release `meridian: v1.73.0`)
      - `desktop / mac` (signed/notarized DMGs and ZIPs attached to release)
      - `docker` (multi-arch images pushed to GHCR `ghcr.io/rynfar/meridian:1.73.0`, `:1.73`, `:latest`)
      - `publish` (`npm publish --provenance --access public` via OIDC trusted publishing, Sigstore index `2893429092`, integrity `sha512-vJPtgC6wv72nBdkre3vCUtZG3Nnz8rAGavdVKzk2KZOZeuoYSh9pQbMULdKm07Qy8EM10PpXdu5pscauiBsDyw==`)
    - Installed-package validation: verified `npm view @rynfar/meridian version` -> `1.73.0`, executed clean install in isolated temporary directory and verified `npx @rynfar/meridian --version` -> `1.73.0`.

### Current Backlog Status & Open Issue Triage

- **Antigravity Integration (PR #1074, PR #1050, Issue #1073)**:
  - Excluded from this review workflow; handled by a dedicated agent per owner directive.

- **Contributor PR #792 (`feat(profiles): complete a profile login from the web UI`) by @Nowaker**:
  - Status: DRAFT. Contributor requested in PR description: `# DRAFT - please do not review or merge yet`. Deferred until author marks ready.

- **Issue #1068 (`feat: define an opt-in contract for request-scoped context in passthrough sessions`)**:
  - RFC / Design inquiry from Pydantic AI Harness maintainers regarding client request-scoped context (planning reminders, context-limit warnings) that are sent with one request and removed on subsequent requests, triggering `modified-history` fresh replays.
  - Action / Status: Needs architectural guidance from repository owner before any patch. Options proposed by reporter: (1) advisory-context envelope eligible for lineage normalization, (2) separate request-context field, or (3) documented append-only requirement.

- **Issue #1024 (`OpenCode title + primary turn collide on one SDK session`)**:
  - Root cause resolved in PR #1031 (`2e118a92`) by admitting plugin-less OpenCode concurrent turns and degrading gracefully instead of returning 400.
  - Status: Resolved in codebase; kept open pending confirmation from reporter (@calebdw).

- **Issue #1011 (`Land the two passthrough commits held back from #980`)**:
  - Commit 2 (`feat(proxy): classify abort causes`) landed in PR #1022 (`0fd59403`).
  - Commit 1 (`fix: recover visible empty capped streams`, `c5804275`) deferred by owner decision because it introduced stream/non-stream asymmetry and altered gate-defended guarantees in `E2E.md`.

- **Issue #1009 (`Uncaptured-tool recovery for capped passthrough turns`)**:
  - Implementation landed behind opt-in flag `MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY=1` in PR #1025 (`d8516bea`).
  - Status: Stays open pending canary validation on affected deployment and a positive fault-injection live gate.

- **Issues #933 & #917 (`npm test is flaky on CI` / `Intermittent CI failures: concurrency tests fail fast`)**:
  - Transcripts backlog saturation fixed in #935; test timeouts widened to 30s in #990; global Claude SDK mock pollution fixed in PR #1087.
  - Status: Tracked. Singleton concurrency test races under high runner CPU load and potential ordering dependencies remain under observation.

- **Issue #769 (`Official OpenClaw scrub plugin (meridian-plugin-openclaw-scrub)`)**:
  - Official plugin repository built at `https://github.com/rynfar/meridian-plugin-openclaw-scrub` and listed via PR #799.
  - Status: Tracking upstream OpenClaw changes and moving fingerprint targets with community contributors.

- **Issue #767 (`OpenCode + Opus: turns diverge as modified-history with overlap messageCount - 1`)**:
  - Investigated and mitigated in 1.61.0 (#784) and #872. Tested on current `main` across 80+ Opus requests with 0 divergences.
  - Status: Main verified clean; awaiting reporter closure or reproduction with new mismatch diagnostic.

- **Issue #650 (`Wire event-driven plugin-input bumps`)**:
  - Repository dispatch receiver merged in #653; notification workflows merged in plugin repos.
  - Status: Waiting for owner to mint fine-grained PAT and set `MERIDIAN_DISPATCH_TOKEN` secret across plugin repos.

## Restart safely

Fetch origin/main and refresh the selected PR/issue, its exact head and related
merged work. Preserve the user's current checkout; use a new isolated worktree
from current main. Existing worktrees may be completed deliveries or deliberate
before-code baselines. Do not reset or delete them on the assumption they are
abandoned. Verify current tool/client versions and use the current E2E.md.

Then work one bounded item through the skill: decide whether we want the behavior,
reproduce, retain contributor authorship, correct separately, run real affected-flow
E2E plus npm test/typecheck/build, inspect exact-head CI and finish only within the
owner's authorized scope. If the required model/platform/environment or product
decision is missing, record the precise blocker and leave that item incomplete.
