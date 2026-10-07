# Effective paid-credit settings (#1073)

The subscription-only guard now requires `useG1Credits` to be a boolean in
official agy's effective `/config` result. Only `false` passes the existing
provider/credit checks. A missing, null, numeric or empty-string value is
indeterminate; its rejection does not mean paid credits were enabled.
The other three setting checks and the supported CLI-version gate are unchanged.

## Regression and compatibility evidence

Baseline: `6636c0da918ad9ee1228ce1e23f771353bf89d72`. The fixture-only regression in
`src/__tests__/antigravity-probe.test.ts` produced **22 pass / 16 fail** on the
unchanged runtime. The four missing/falsy credit variants were accepted instead
of rejected. This demonstrates a validation gap, without authenticating an
account, selecting paid mode or observing any charges.

After the correction, the probe suite passed **39/39** and the backend suite
passed **72/72** in separate Bun processes; standalone typecheck passed. Controls
cover account validation, discovery and new-generation admission, one config
attempt with no retry or model command, released admission reservations and a
fresh successful check after corrected settings. Both the old synthetic default
and the observed native null-valued provider fields remain accepted.

The official [1.2.7 release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.7)
macOS arm64 archive matched its published SHA-256:
`ce9fe3f4d6f44a2b1c83b334fc5c8f2975079959e24dd805e10eb49ab8c76a7e`.
Its extracted executable SHA-256 is
`8c01ef82307dc01455418eb2e6e82f2989a3fa8b815c4b192efaaa89a55bef8d`.

On macOS arm64 / Node 22.22.3, the read-only native probe observed:

| Effective setting | Sanitized observation |
| --- | --- |
| `customModelsConfig` | present, null |
| `modelProvider` | present, empty string |
| `useG1Credits` | present, boolean false |
| `gcp` | present, null |

The pinned executable hash was unchanged after `/config` and a subsequent
`--version`, which still returned 1.2.7. Both read-only commands exited zero with
child-close and readable-EOF observations. Raw config, stderr, account identifiers
and credential values were not retained. This proves the tested positive shape;
it does not specify every possible native account configuration or audit the
other settings' truthiness guards.

## Retained failed controls

The first owned executable self-updated after extraction. Its first config
receipt lacks an identity check across commands and is not accepted as exact
1.2.7 evidence. The subsequent live attempt was refused during initialization
as unsupported **1.3.1**, before config, discovery or generation admission.

A fresh archive extraction uses the official per-process
`AGY_CLI_DISABLE_AUTO_UPDATE=true` selector. The selector is documented in the
[official troubleshooting guide](https://www.antigravity.google/docs/cli/troubleshooting/)
and present in the original 1.2.7 public binary. Before/after executable hashes
and version checks remain required; the selector alone is not identity proof.
No global CLI installation or owner account settings were changed.

The projection harness's first synthetic control also exposed an overly early
physical stdout-close snapshot. The corrected probe requires actual child close
and both readable EOFs, records physical-close flags separately, bounds failure
draining and preserves incomplete cleanup. It makes no descendant-census claim.

## Remaining acceptance

The corrected source passed `scripts/e2e-antigravity.mjs` with actual official
agy 1.2.7 / Gemini 3.8 Flash Low / Pi 0.72.1 on macOS arm64, Node 22.22.3.
All four flows passed: native text, HTTP client-tool roundtrip, completed-history
replay and actual streaming Pi read/write with an exact client-local file copy.
Pi made three requests. The executable hash and CLI version remained unchanged;
the harness exited zero after awaited service shutdown. This is representative
macOS acceptance, without an OS descendant census or other-platform claim.

The maintained live runner now uses its own fixture API key and forwards the
matching header. Its previous HTTP 401 was the local Meridian API-key middleware,
before generation; it was not a native account-login result. External-server
runs use the supplied service key without copying it into Pi's config.

The new `scripts/e2e-antigravity-account-settings.mjs` retains only whitelisted
setting types/flags, disables self-updates and hashes the executable before and
after each command. Its native projection passed with the observed shape above.
A self-replacing synthetic executable was rejected after `--version`, before
any config command. No raw setting values or account identifiers were retained.

```sh
node scripts/e2e-antigravity-account-settings.mjs \
  /owned/official-agy-1.2.7 /owned/empty-project /owned/settings-proof.json
AGY_CLI_DISABLE_AUTO_UPDATE=true \
MERIDIAN_AGY_PATH=/owned/official-agy-1.2.7 \
E2E_PI_BIN=/owned/pi-0.72.1 node scripts/e2e-antigravity.mjs
```

[Sanitized results](1073-subscription-settings-results.json) retain the before/
after fixture, native identity and actual-client facts, including the earlier
pre-rebase local result.

## Delivery — 2026-10-07

[PR #1307](https://github.com/rynfar/meridian/pull/1307) merged at 21:50:17 UTC as
`ff260ea217072cf842f319c64d563e122f4d6964` from final tested head
`a6d15a2f970edabe0fc323bbcb8506597008f356`. Final rebased local gates passed
**5,452 / 35 skip / 0 fail**, standalone typecheck and build. Six executed
final-head CI checks passed, including
[required test](https://github.com/rynfar/meridian/actions/runs/37689253024/job/113024913360),
with the expected changelog skip. The merged tree
`2d4112bcae9c1900016b225e2f5ea07679341f6b` exactly matches the tested tree;
human credit is verified. This supersedes the earlier pending-delivery status.

#1073 remains open for its broader Linux/Windows and reliability acceptance
scope. No release is claimed.
