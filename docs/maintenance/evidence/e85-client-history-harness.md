# Actual-client profile history probe

`scripts/e2e-profile-history-client.mjs` escrows the E85 acceptance probe for
[#1401](https://github.com/rynfar/meridian/pull/1401). It tests an independently
installed Meridian bundle with actual OpenCode 2.0.31 or Pi 1.3.0, the real Agent
SDK and native CLI. The default upstream is a scripted loopback responder.

Use stock Node with absolute fixture paths. `E2E_MERIDIAN_ROOT` names the built
source or independently installed package root. `E2E_NATIVE_BIN` names the
qualified native CLI; set `E2E_NATIVE_VERSION` when it differs from the default
2.1.301. The probe also requires SDK 0.2.141. OpenCode additionally requires `E2E_OPENCODE_BIN`,
`E2E_OPENCODE_VERSION=2.0.31`, `E2E_PLUGIN_PATH` and `E2E_SCRUB_VERSION`; the probe
runs the package's setup command and verifies both the matching Meridian client
plugin and server scrub. For Pi, set `E2E_PI_PACKAGE` to the installed
`@earendil-works/pi-coding-agent` package directory. The Pi path uses its actual
session engine and checks that no stable session/affinity identity was added.

```sh
node scripts/e2e-profile-history-client.mjs --aliases
node scripts/e2e-profile-history-client.mjs --aliases --rewind
node scripts/e2e-profile-history-client.mjs --aliases --pi
```

Set `E2E_EVIDENCE_DIR` to a fresh, owned output directory for each invocation.
`E2E_EXPECT=baseline` requires the unchanged baseline to lose both foreign replies
on return; ordinary candidate runs require both replies to reach the model and
the actual client's final answer. The separate `--rewind` conversation stages
OpenCode's actual edit/revert API at its second user message and requires both
baseline and candidate to resume the original A native session. It must not
report `moved-on-elsewhere` for that edit.

`--aliases` uses two fixture-owned fake OAuth aliases with distinct native config
directories. Both mappings must remain present; eviction, expiry and pruning
are disabled. Their namespace, request log, provider message IDs, native stream
IDs and public SDK stored-message metadata must agree. Reading private SDK
transcript files is prohibited. Original child exit, close and both captured
pipe witnesses must join. Cleanup deadlines retain missing witnesses as failure
and never signal an exited original leader.

For a newly authorized live task, replace `--aliases` with `--live` and set
`E2E_ALLOW_LIVE_MODEL=1`, `E2E_USAGE_GUARD_FILE` and `E2E_LIVE_PROFILE_FILE`. The
access-only grant must be a mode-0600 JSON array with one `oauth-token` profile
and no refresh token. The guard must carry a timestamp less than five minutes
old, an active organization, `profileExtraUsageEnabled: false`, `refreshes: 0`
and `credentialWrites: 0`. A known-capacity record has `canInfer: true`,
`extraUsageEnabled: false` and both current usage windows below exhaustion.
When the usage display is rate-limited, an explicitly authorized bounded attempt
may instead carry `includedAttemptPermitted: true`, `includedCapacityKnown: false`
and `maximumGenerationsPerCase` from 1 to 12. The evidence keeps capacity labelled
unknown and enforces that lower request bound. Paid usage must remain freshly
disabled; the record never refreshes credentials or invents fresh usage windows. Credentials
are read before the probe isolates its environment; they are never printed.
The two aliases deliberately share that grant. This tests profile namespace
custody, not distinct subscriptions, quota exhaustion or failover eligibility.
Delete the grant after the original actors join. Never reuse a failed actual
case to obtain an unexplained green rerun.

The live boundary permits only `claude-haiku-5-5`, bounds model requests to 12,
rejects unexpected native/provider/stored models, stops on refusal or overage,
and does not refresh credentials or enable paid usage. Foreign answer nonces
come from completed model replies and are absent from the final user prompt.

[The six-case preflight receipt](e85-client-history-preflight.json) records the
exact executed script hash, heads, installed clients and assertions. It qualifies
the scripted fixture only. Actual-model E85, four-mode E41 and relevant E42
acceptance remain on the final product PR; this harness adds no product behavior.
