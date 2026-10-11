# Official client 2.1.286 classifier model-selection audit

The official client selects the auto-mode classifier separately from the main model. Neither “always the explicit main model” nor “always a fixed model” describes the shipped selector. Published cd8 E71 omitted requested wire/SDK identity verification and required every served query to match the main served pin. The intermediate proposed universal `body.model === --model` and SDK-requested-main checks were also unsupported for classifier requests; they were not present in the published cd8 harness. This is a static finding; it is not an observed native failure. The final role-aware correction is documented in [the reviewed packet](../role-model-witness-controls/FINAL_REPORT.md).

## Exact inspected artifact

Already acquired official public `@anthropic-ai/claude-code-linux-x64@2.1.286`, Linux x64 GNU. No additional package acquisition or install occurred. The copied wrapper registry metadata declares this exact optional package dependency at version 2.1.286.

- Binary `package/claude`: 241,667,256 bytes; SHA256 `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`.
- Official tarball: 108,247,300 bytes; SHA256 `4887d7125e6c5ae5bf4dd5b0c5ae04469a9e387acb9e1281636d83d8d9a683e0`.
- Archive SHA1 and SHA512 rechecked against the copied official npm metadata. Registry signatures were not independently verified.
- Metadata: https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/2.1.286
- Archive: https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.286.tgz

## Selector and actual call path

`Nae` obtains `WDe().value` as `Kn`, sets initial classifier model `Mo=Kn`, and passes the chosen model through its `dn` closure as `I1o` parameter `S`. Both stage-one `yt` and stage-two `dn` request objects set `model:S` and `querySource:"auto_mode"`. `fGt` forwards options to `WFe`; its parse retries preserve them and its beta-rejection retry changes only extraBetas. `WFe` forwards to `KB` without replacing model. `KB` applies helper-denial mapping `K_e`, then constructs the base body with provider/policy normalization `CR(Fe)` and calls `beta.messages.create(Pn, ...)`. `extraBodyParams` is spread after base model, so an exact runtime wire witness remains required even for this traced base-body formula.

`WDe` first obtains current main model `et()` and feature config `aS()`. It selects a policy-eligible `modelByMainModel` entry using exact canonical keys from `Nmt()`, then a policy-eligible global `model`. With no eligible override, if the external probe is not demoted it tries `aWr(main)`; otherwise it returns `y$e(main)=lWr(main)`.

`aWr` suppresses the served-model catalog while computing `gI`. `gI` returns no probe for canonical main Sonnet4.5, Sonnet4.6, or Haiku. For other mains, it uses an explicit eligible `ANTHROPIC_DEFAULT_SONNET_MODEL`, excluding a default previously written by the third-party probe, or the permitted provider catalog entry `Pg().sonnet5`. This is opportunistic Sonnet5 selection, not a universal main-model inheritance rule. `lWr` preserves ordinary main models but remaps Fable/Mythos through an Opus default/catalog choice, carrying eligible context extension.

The built-in `iPr` config has classifier behavior and severity thresholds but no classifier model override. Feature/config values may replace it; none were read during this audit. New per-host `bGt` state starts `externalSonnet5Probe="unprobed"`. A successful external probe confirms it; eligible unavailable errors demote it, and a bounded distinct eligible current-main fallback may run. Thus one CLI invocation can legitimately emit classifier requests for different models.

## Bounded static counterexample

The baked catalog has distinct canonical IDs `claude-sonnet-5` (key `sonnet5`) and `claude-sonnet-5-5` (key `sonnet55`). With main `claude-sonnet-5-5`, no eligible feature override, no custom Sonnet default, Sonnet5 permitted, a new/not-demoted host, and no provider/policy/extra-body override erasing the distinction, the selector can use `claude-sonnet-5` for classifier requests while main uses `claude-sonnet-5-5`. The Sonnet5-5 main is not one of `gI`’s probe exclusions. First-party and gateway IDs for these two baked entries preserve the distinction. Other providers have their own catalog identifiers.

For main Sonnet4.6/4.5 with no eligible override, the default path ordinarily inherits that main model; feature configuration may still choose another classifier model. There is no static guarantee that every classifier body model equals the main CLI argument. Actual policy, feature/entitlement, provider remapping, extra parameters, probe outcome, emitted body, adapter query selection, and SDK-served model all remain native evidence gates.

The spelling is `claude-sonnet-5-5` in this artifact, not a dotted `claude-sonnet-5.5` ID. No inference about availability or user entitlement follows from a baked catalog entry.

## Reproduction and limits

`classifier-model-selection-static.json` records the full binary identity plus exact byte offsets, bounded locating needles, slice hashes, and function/caller facts. Several short minified names are reused elsewhere in the binary; the bounded ranges and SHA256 prevent accidentally selecting an unrelated same-named function. Saved evidence does not contain bulk extracted proprietary source.

Run the read-only inspector against the already acquired binary:

```sh
python3 inspect-claude-classifier-static.py \
  /owned/official-claude-code-linux-x64-2.1.286/package/claude \
  classifier-model-selection-static.json
```

This only hashes/reads public distribution data. No official binary was executed; no model call, auth/store/global config lookup, test, build, typecheck, repository mutation, or harness edit occurred. Writing this requested separate /tmp packet is the only output mutation. Parent owns final E71 schema, implementation, and native acceptance.

## Pinned locations (end offsets exclusive)

| Fact | Start | End | Slice SHA256 |
| --- | ---: | ---: | --- |
| baked-sonnet5-catalog | 197586449 | 197587372 | `4c9be7b376d88a3db1cc975f5da4253f611b8996e6a4841a33be51446182a2c2` |
| baked-sonnet55-catalog | 197587372 | 197588371 | `49e9a3e8e28c7e40dafd8c353e3ba5decd891f29075b50b241463f527a44f085` |
| catalog-key-map | 197603469 | 197604017 | `b928fbbe05131a7e42845f34c0783cb7b9d2b082980e82273669016b63c348d7` |
| catalog-key-generation | 197604375 | 197604619 | `1d5db3909d8aeade535aacd6630a63d3e658bd33e3a0415e02ed59bc067990c4` |
| catalog-inverse | 197605557 | 197605630 | `6c913c01ad9aef1375b4566ba665b95962c2599d26ef47cf572935f225d3d338` |
| provider-catalog | 199072722 | 199072911 | `62e0ebea7750a78b14e9ba769eba79afebcdef14a9bfec6a5802a9207596853c` |
| provider-catalog-overrides | 199073861 | 199074485 | `d17fc01e73440847786b659670f5044ffab5fdc894ae7bb485dce58304a565e8` |
| main-model-explicit | 199395142 | 199395361 | `4975245297da2339c0a8dce5f6567c964fbc12f7fb263217bc082c2c356d81f6` |
| main-model-resolve | 199396168 | 199396242 | `1b7bb28b63b2e3341df07f33377bfa66462c29edafc90e2dff4affc12b4f8dc5` |
| main-alias-resolution | 199425388 | 199425932 | `5f3bbbdfd569b6f6445bf259d19e5dc975dd636b782be9a0a815a576537ef3f2` |
| canonical-main-keys | 199421233 | 199421375 | `7d8196e6ac9d56c7ceb7eeb846b45de8fa87fa3091c072b14391c45c925073db` |
| helper-catalog-suppression | 199370820 | 199370932 | `a48d56376c052d623f5e80315a86c3dcee5744aa4721a144d62644f9d1de3c0f` |
| helper-model-denial | 199394471 | 199394583 | `f386d752042f021173eac4b2034e60cce5c64ee551ce53b30989d23d7ec7f91a` |
| classifier-default-models | 199398690 | 199399487 | `fb71024d3bf0dac2774db64af527e6b4df1045cc458db2676cbd8a55fadb715b` |
| provider-wire-remap | 199427705 | 199428211 | `a54deea902d9e2eeb9c62f14c86c45896844793bab3078a95ab35df2e94c1f7b` |
| builtin-auto-config | 203345333 | 203345892 | `b82ecddaabf982c7dfb808081dc591b7054f3fa77ffd8076cb302d687989149e` |
| classifier-probe-state | 206706469 | 206706776 | `1023c660842b427353699388f8a291f46ab7615b62b9a175f921d77d1bfb5945` |
| classifier-stage-one | 206741184 | 206741811 | `64ca25bf50f302320c91d2bdc088345583b9a9013036ec73d662d7de7f7d86aa` |
| classifier-stage-one-request | 206741887 | 206742194 | `5fc8bdbdb4a0c9f018bc29fbb8ef93a03dd958ced6f2a238e8a3db117769b85c` |
| classifier-stage-two | 206743976 | 206744717 | `038a75746e76e45350fdcba9075b02b78efa31b4cb6bb20d248638ba65925975` |
| classifier-extras | 206749391 | 206749541 | `719397eaac2a6efaf9ae02d38e8d5ffa41161fe61ca203f9442d7baa84011d1b` |
| classifier-sidequery-forwarder | 206749541 | 206750202 | `a53ca08b95fcebc00a9c8fb31081770efa5afa03f170999e9f76a00d09e34d1b` |
| classifier-selected-model-caller | 206754712 | 206755481 | `3c0b99de06b282e2a86ac66c3f89ecd4491bf93a38ad99e710e575b93c9921df` |
| classifier-probe-demotion | 206756018 | 206757787 | `b1af54c85299bcad2f917e1031df09aae7be623a54838c27ca637b7cec3bda5c` |
| classifier-model-selector | 206757972 | 206759282 | `d9cce703bacc4132340a6ad1a0bbc20f7bb15bde9ea54f941b20c6e7e9190f74` |
| side-query-wire-body | 205756897 | 205759197 | `e0b82364c43dfc432f06f61d11dcc6fd4038438ff2cd31bd3833598b6333ca09` |
| side-query-native-create | 205759197 | 205759801 | `530617692f8a7650dc8966a7d4ab559d4adad6aa3672c9b151641ed6d7b01d3a` |
| classifier-retry-forwarder | 206750937 | 206751620 | `bd18d22f7c44b06347fa035b75c6bc6155b9ddd3dc9c7bd0e0eddf5e63568f70` |
| classifier-beta-only-retry-options | 206750202 | 206750386 | `f96634a26d685ad80726b01a70d7defaeecc40b24149962f6964aa965d0a7b58` |
