# Changelog

## [1.68.0](https://github.com/rynfar/meridian/compare/meridian-v1.67.0...meridian-v1.68.0) (2026-09-05)


### Features

* **openai:** support structured output via response_format ([#930](https://github.com/rynfar/meridian/issues/930)) ([db9546c](https://github.com/rynfar/meridian/commit/db9546c908d4fa86cf2af0577da5c9703a9374f7))


### Bug Fixes

* classify CLI model incompatibility without false client errors ([3ce6a57](https://github.com/rynfar/meridian/commit/3ce6a57d6e2b3508342a216c7bba8e8af5158b6e))
* finish Claude Code reminder validation ([82164d2](https://github.com/rynfar/meridian/commit/82164d22ad8ad6fc9e76a7110eadfb61f55117cf))
* isolate concurrent Pi replays and committed tool caches ([04d1c93](https://github.com/rynfar/meridian/commit/04d1c93bf757b31c7cf48600812270005ce5bacf))
* preserve account attribution and SDK billing failover ([#961](https://github.com/rynfar/meridian/issues/961)) ([1ae1810](https://github.com/rynfar/meridian/commit/1ae1810dc2a24250c4a3f4d21546b03e56b9b388)), closes [#829](https://github.com/rynfar/meridian/issues/829)
* preserve client context across proxy workdirs ([#959](https://github.com/rynfar/meridian/issues/959)) ([288cc10](https://github.com/rynfar/meridian/commit/288cc105c8adecac12f340cbd33eb4ea14a58748))
* preserve fresh-request admission after passive retirement ([235c4ac](https://github.com/rynfar/meridian/commit/235c4ac23eb4089a7ce344004c15a4ab436a0102))
* preserve replay tool history and protect transcript publication ([6e2d24c](https://github.com/rynfar/meridian/commit/6e2d24ce47af8d595ca6eb854d029fadd896d199))
* preserve safe appended context and deliver resume deltas atomically ([9d28328](https://github.com/rynfar/meridian/commit/9d2832885686b20f9a09326d2ff22afddf12a06c))
* recover capped passthrough turns without hiding empty answers ([9d22324](https://github.com/rynfar/meridian/commit/9d223244000e97100488785770d84405f1bda598))
* repair passthrough arguments without weakening tool schemas ([4c67144](https://github.com/rynfar/meridian/commit/4c671447a5b19e731b62e2cf5fefd33520850982))
* replay revised passthrough turns with faithful checkpoints ([879f2be](https://github.com/rynfar/meridian/commit/879f2be97a3e62246d3e761899948d258d1ee863))
* replay undo histories that exceed the rollback boundary ([#939](https://github.com/rynfar/meridian/issues/939)) ([4135922](https://github.com/rynfar/meridian/commit/41359222c5270dfec5dda74deacdbecebed1b70b))
* resume Claude Code reminders without losing history ([fb8f3a3](https://github.com/rynfar/meridian/commit/fb8f3a39c709196a7538075085e9606604e067d9))
* separate lineage hash domains and preserve result semantics ([5ba7c2b](https://github.com/rynfar/meridian/commit/5ba7c2b2bb7f3f7dc0adec3938ae7cb8ff618b79))
* stop repeated idle stalls across client retry policies ([#960](https://github.com/rynfar/meridian/issues/960)) ([6365ae0](https://github.com/rynfar/meridian/commit/6365ae0ed5445fbf6ea5c89055919570a7c76406))
* support validated OpenCode beta plugin packages ([#958](https://github.com/rynfar/meridian/issues/958)) ([cc179fa](https://github.com/rynfar/meridian/commit/cc179faf96df1adcae5d9ef0493c72c198867229))
* update vulnerable URI and HTTP dependencies ([cc4f761](https://github.com/rynfar/meridian/commit/cc4f76178d6d1af63788fc9937aeaef386147173))

## [1.67.0](https://github.com/rynfar/meridian/compare/meridian-v1.66.0...meridian-v1.67.0) (2026-09-04)


### Features

* **models:** add Claude Fable 5.1 ([#928](https://github.com/rynfar/meridian/issues/928)) ([6c85fcd](https://github.com/rynfar/meridian/commit/6c85fcd5de695b2d670146b8d3458000b7f8eedb))


### Bug Fixes

* **errors:** classify an oversized prompt as a 400, not a retryable 500 ([#919](https://github.com/rynfar/meridian/issues/919)) ([1ea97d0](https://github.com/rynfar/meridian/commit/1ea97d0122fdd106e9c1bf5c771efdb6d8a30f01))
* **errors:** classify the credits-era per-tier limit refusal ([#929](https://github.com/rynfar/meridian/issues/929)) ([85d18d9](https://github.com/rynfar/meridian/commit/85d18d9c78d017f1ffe9e06efc75e19e5dd8982c))
* **nix:** repair nix build, broken on Darwin since 1.62.7 ([#916](https://github.com/rynfar/meridian/issues/916)) ([3ff4c0a](https://github.com/rynfar/meridian/commit/3ff4c0a583c780ec7109a2567325e5be7e02be2e))

## [1.66.0](https://github.com/rynfar/meridian/compare/meridian-v1.65.2...meridian-v1.66.0) (2026-08-31)


### Features

* cancel RLM subagent trees when the parent request aborts ([ad55c22](https://github.com/rynfar/meridian/commit/ad55c22b5e79ac963dec6a695eb05e9d56178c83)), closes [#902](https://github.com/rynfar/meridian/issues/902)
* emit Retry-After and scope [1m] rate-limit benching per session ([49e04d1](https://github.com/rynfar/meridian/commit/49e04d131a6b168986cef53b99780ef624a092ff))


### Bug Fixes

* **openai:** profile-aware model catalog, SSE keepalives, cached-token usage ([#914](https://github.com/rynfar/meridian/issues/914)) ([a167bc1](https://github.com/rynfar/meridian/commit/a167bc1992b883787e33ae37b28fa9ecae8fe0f0))

## [1.65.2](https://github.com/rynfar/meridian/compare/meridian-v1.65.1...meridian-v1.65.2) (2026-08-31)


### Bug Fixes

* **errors:** classify org spend-limit refusals as rate limits ([#908](https://github.com/rynfar/meridian/issues/908)) ([0fc79a7](https://github.com/rynfar/meridian/commit/0fc79a733539693d35773718315c55dc486b1361))

## [1.65.1](https://github.com/rynfar/meridian/compare/meridian-v1.65.0...meridian-v1.65.1) (2026-08-31)


### Bug Fixes

* **docker:** initialize machine identity in runtime image ([#903](https://github.com/rynfar/meridian/issues/903)) ([3f18494](https://github.com/rynfar/meridian/commit/3f18494db4267ff6cafe285529645b33c924b9a4))

## [1.65.0](https://github.com/rynfar/meridian/compare/meridian-v1.64.0...meridian-v1.65.0) (2026-08-29)


### Features

* **routing:** add durable next-user-turn priority failback ([#897](https://github.com/rynfar/meridian/issues/897)) ([2e51fdb](https://github.com/rynfar/meridian/commit/2e51fdb8e17eed5ff0e26ed0f926de449fe8106e))


### Bug Fixes

* **errors:** classify exhausted usage credits ([#890](https://github.com/rynfar/meridian/issues/890)) ([099741d](https://github.com/rynfar/meridian/commit/099741dd7a341daa767b08e20649456c51675b62))

## [1.64.0](https://github.com/rynfar/meridian/compare/meridian-v1.63.0...meridian-v1.64.0) (2026-08-27)


### Features

* add OpenCode V2 beta compatibility ([#880](https://github.com/rynfar/meridian/issues/880)) ([40a69c7](https://github.com/rynfar/meridian/commit/40a69c7ede68bc69a589575b599c520cb8dfa212))

## [1.63.0](https://github.com/rynfar/meridian/compare/meridian-v1.62.7...meridian-v1.63.0) (2026-08-27)


### Features

* report build provenance and available updates on /health ([#866](https://github.com/rynfar/meridian/issues/866)) ([992f81c](https://github.com/rynfar/meridian/commit/992f81cfed4b17894f09068718705fbd5a937000))


### Bug Fixes

* **passthrough:** make durable resume crash safe ([#879](https://github.com/rynfar/meridian/issues/879)) ([2ccc48a](https://github.com/rynfar/meridian/commit/2ccc48a5d75514b490420b2c6a735a5983107f7e)), closes [#877](https://github.com/rynfar/meridian/issues/877) [#827](https://github.com/rynfar/meridian/issues/827) [#828](https://github.com/rynfar/meridian/issues/828)

## [1.62.7](https://github.com/rynfar/meridian/compare/meridian-v1.62.6...meridian-v1.62.7) (2026-08-20)


### Bug Fixes

* bench [1m] per profile after a rate limit instead of flapping back ([#863](https://github.com/rynfar/meridian/issues/863)) ([0daa380](https://github.com/rynfar/meridian/commit/0daa3803fdca90488c2ae2fa4e0b0a0625d882fe))
* bound the per-session passthrough tool caches ([#864](https://github.com/rynfar/meridian/issues/864)) ([96bda14](https://github.com/rynfar/meridian/commit/96bda147294971349a5378b53635f618d347ec19))
* preserve the passthrough checkpoint when the SDK stops at its turn cap ([#853](https://github.com/rynfar/meridian/issues/853)) ([e599aaf](https://github.com/rynfar/meridian/commit/e599aafc348047e29dbf88dd87c5d504e9ccab4a))


### Performance

* stop billing the passthrough digest turn by capping maxTurns at 1 ([#860](https://github.com/rynfar/meridian/issues/860)) ([2c5b577](https://github.com/rynfar/meridian/commit/2c5b5776bdfe5e68530f9bb1f747393559d75967))

## [1.62.6](https://github.com/rynfar/meridian/compare/meridian-v1.62.5...meridian-v1.62.6) (2026-08-19)


### Bug Fixes

* give OpenCode's internal agents their own session key ([#848](https://github.com/rynfar/meridian/issues/848)) ([7ce5345](https://github.com/rynfar/meridian/commit/7ce5345912b61307e3f734b4ee7538cb327597eb))

## [1.62.5](https://github.com/rynfar/meridian/compare/meridian-v1.62.4...meridian-v1.62.5) (2026-08-17)


### Bug Fixes

* route native subagents to base model tiers ([#839](https://github.com/rynfar/meridian/issues/839)) ([91aeaf5](https://github.com/rynfar/meridian/commit/91aeaf56d6d220a4cd01fc0bfebe5dfd486e7b90))

## [1.62.4](https://github.com/rynfar/meridian/compare/meridian-v1.62.3...meridian-v1.62.4) (2026-08-17)


### Bug Fixes

* preserve passthrough session cache lineage ([#837](https://github.com/rynfar/meridian/issues/837)) ([a8a3d11](https://github.com/rynfar/meridian/commit/a8a3d11c50868a157cd1997a3b0f3b7d913fb0cc))

## [1.62.3](https://github.com/rynfar/meridian/compare/meridian-v1.62.2...meridian-v1.62.3) (2026-08-17)


### Bug Fixes

* **concurrency:** follow env changes for the shared SDK semaphore budget ([e40ff28](https://github.com/rynfar/meridian/commit/e40ff2853732b2853bfc28bbf85064fda0f9959f))

## [1.62.2](https://github.com/rynfar/meridian/compare/meridian-v1.62.1...meridian-v1.62.2) (2026-08-17)


### Bug Fixes

* advertise 1M context on Team and Enterprise plans ([#830](https://github.com/rynfar/meridian/issues/830)) ([4103b6f](https://github.com/rynfar/meridian/commit/4103b6f98e0680609a5276d993558ac110a90c44))
* coordinate SDK/session concurrency and add graceful shutdown ([#825](https://github.com/rynfar/meridian/issues/825)) ([83b2f5c](https://github.com/rynfar/meridian/commit/83b2f5c8f5b087eb9bd43bc2cb04a768435057cf))
* **routing:** bench a weekly-capped profile until the weekly reset ([#815](https://github.com/rynfar/meridian/issues/815)) ([db72d9a](https://github.com/rynfar/meridian/commit/db72d9a5ca70567242eab1aaa1ab6579d96933e6))

## [1.62.1](https://github.com/rynfar/meridian/compare/meridian-v1.62.0...meridian-v1.62.1) (2026-08-15)


### Bug Fixes

* **concurrency:** stop internal dispatch hops from taking a second queue slot ([#813](https://github.com/rynfar/meridian/issues/813)) ([32ccab8](https://github.com/rynfar/meridian/commit/32ccab8a33ab2535cad529a1cf430187cb87caf2))
* **passthrough:** stop announcing a truncated turn as a clean finish ([#801](https://github.com/rynfar/meridian/issues/801)) ([7c83f2b](https://github.com/rynfar/meridian/commit/7c83f2b10ff5c8dc4ed62ca96f12c1985570329d))
* **plugins:** derive the known-adapter list from the registry ([#814](https://github.com/rynfar/meridian/issues/814)) ([226232d](https://github.com/rynfar/meridian/commit/226232d573b060c5a19f6eac38286e7f0bdd6137))
* **session:** retry a refused resume before abandoning the session ([#811](https://github.com/rynfar/meridian/issues/811)) ([cb6fe0c](https://github.com/rynfar/meridian/commit/cb6fe0c6bff5188ab7e089d8bd481a62d0f719c0))

## [1.62.0](https://github.com/rynfar/meridian/compare/meridian-v1.61.0...meridian-v1.62.0) (2026-08-15)


### Features

* **adapters:** add Prime Agent adapter ([#808](https://github.com/rynfar/meridian/issues/808)) ([377a79b](https://github.com/rynfar/meridian/commit/377a79bd305fccf57ce15a2d0c84893b3c8115c9))


### Bug Fixes

* **replay:** restore tool-call attribution for pi, bash, and code tools ([#802](https://github.com/rynfar/meridian/issues/802)) ([87e60f8](https://github.com/rynfar/meridian/commit/87e60f8d475dbc3a7b8fb90430c684f36cc03c77))
* **routing:** fail over when an account's subscription is refused ([#800](https://github.com/rynfar/meridian/issues/800)) ([1635f3e](https://github.com/rynfar/meridian/commit/1635f3e742eccfeb1a8f6e45f77d4e543f1469e3))
* **session:** say which message broke the lineage, not just how many matched ([#797](https://github.com/rynfar/meridian/issues/797)) ([87f78f8](https://github.com/rynfar/meridian/commit/87f78f8c4e1989c5afacbe532f3fc1aaaf7e888b))

## [1.61.0](https://github.com/rynfar/meridian/compare/meridian-v1.60.0...meridian-v1.61.0) (2026-08-11)


### Features

* Hermes Agent integration example plugin + docs ([#762](https://github.com/rynfar/meridian/issues/762)) ([8b789e4](https://github.com/rynfar/meridian/commit/8b789e4e491c31ec79737cb18dd9c79666496f20))


### Bug Fixes

* **errors:** recognize the CLI's other limit wordings ([#788](https://github.com/rynfar/meridian/issues/788)) ([697a618](https://github.com/rynfar/meridian/commit/697a61881dc85bffc237be57f0d2cd5c08ac5a98))
* keep Jcode chat sessions cache-affine ([#784](https://github.com/rynfar/meridian/issues/784)) ([3bdc7d0](https://github.com/rynfar/meridian/commit/3bdc7d0f973610246771b683b9960ab44a662641))
* **passthrough:** never leave a passthrough continuation unanswered ([#793](https://github.com/rynfar/meridian/issues/793)) ([2852159](https://github.com/rynfar/meridian/commit/28521591060c368a0fc1ce48f7ecd90da675a5f3))
* **quota:** back off OAuth usage rate limits ([#785](https://github.com/rynfar/meridian/issues/785)) ([128d87d](https://github.com/rynfar/meridian/commit/128d87df0502ffca947a85b114d022638e7db764))
* **quota:** distinguish a rate-limited usage fetch from a missing token ([#786](https://github.com/rynfar/meridian/issues/786)) ([d82da9f](https://github.com/rynfar/meridian/commit/d82da9fbf9ec008278f3b257d33496f8df0ca679))
* **usage:** report why a usage fetch failed instead of calling every failure no_token ([#789](https://github.com/rynfar/meridian/issues/789)) ([7c8d2b4](https://github.com/rynfar/meridian/commit/7c8d2b414edf46b670f99f08c341b4c2b889e580))

## [1.60.0](https://github.com/rynfar/meridian/compare/meridian-v1.59.0...meridian-v1.60.0) (2026-08-04)

> ### ⚠️ Behaviour change: claude.ai connectors are now off by default
>
> If your claude.ai account has connectors attached (Drive, Gmail, Calendar),
> they previously loaded for any adapter **not** in passthrough mode. As of
> 1.60.0 they require an explicit opt-in at `/settings` → **claude.ai
> Connectors**.
>
> **Affected:** `cherry`, `droid`, and any deployment running
> `MERIDIAN_PASSTHROUGH=0`.
> **Not affected:** `opencode` and other passthrough-default adapters —
> connectors were already disabled for them.
>
> Nothing errors when this bites. The model simply no longer has the tool and
> answers as though the data were unavailable, so a lost capability is easy to
> misread as the model being unhelpful. See
> [claude.ai connectors](https://github.com/rynfar/meridian/blob/main/docs/configuration.md#claudeai-connectors).

### Features

* gate claude.ai connectors behind an opt-in flag ([#759](https://github.com/rynfar/meridian/issues/759)) ([370c286](https://github.com/rynfar/meridian/commit/370c286cbfbaa2e31dafa2a8222bd344944a4766))


### Bug Fixes

* don't treat transport metadata as a system instruction ([#758](https://github.com/rynfar/meridian/issues/758)) ([59931d0](https://github.com/rynfar/meridian/commit/59931d0e09e2c1f51a33064bfa433cc2db785583))

## [1.59.0](https://github.com/rynfar/meridian/compare/meridian-v1.58.3...meridian-v1.59.0) (2026-08-04)


### Features

* add webFetchPreflight toggle, scoped to the adapter it affects ([#752](https://github.com/rynfar/meridian/issues/752)) ([e2aa19f](https://github.com/rynfar/meridian/commit/e2aa19ff77f7695dffaf959e4fc7da3da1b73a9b)), closes [#748](https://github.com/rynfar/meridian/issues/748)
* quiet the subprocess's non-essential outbound traffic ([#757](https://github.com/rynfar/meridian/issues/757)) ([63a5301](https://github.com/rynfar/meridian/commit/63a530151da0909dba061ff6d6c61c13b53e2d90))

## [1.58.3](https://github.com/rynfar/meridian/compare/meridian-v1.58.2...meridian-v1.58.3) (2026-08-03)


### Bug Fixes

* **cwd:** use the client's directory as the SDK cwd when it exists locally ([#746](https://github.com/rynfar/meridian/issues/746)) ([f16e2a6](https://github.com/rynfar/meridian/commit/f16e2a6846be834cdddceb1756713ccc27f91d35)), closes [#744](https://github.com/rynfar/meridian/issues/744)
* **passthrough:** defer early stop while a tool_use block is still streaming ([#745](https://github.com/rynfar/meridian/issues/745)) ([46e55dc](https://github.com/rynfar/meridian/commit/46e55dce5234e858710459c94462c4add371f87d)), closes [#742](https://github.com/rynfar/meridian/issues/742)
* **pi:** read the session identity OMP carries in metadata.user_id ([#747](https://github.com/rynfar/meridian/issues/747)) ([e41019b](https://github.com/rynfar/meridian/commit/e41019bd4c5a16625cd5d2105529c68915395f57)), closes [#734](https://github.com/rynfar/meridian/issues/734)
* register claude-code transforms so tool calls pass through ([#743](https://github.com/rynfar/meridian/issues/743)) ([94ba52f](https://github.com/rynfar/meridian/commit/94ba52fb388728b7f36250ece0391e00a7316493))
* **sanitize:** stop a self-closing tag swallowing text up to the next paired tag ([#736](https://github.com/rynfar/meridian/issues/736)) ([0f20bfd](https://github.com/rynfar/meridian/commit/0f20bfdfc0075546fd9933250b46cb525acb4f1a)), closes [#722](https://github.com/rynfar/meridian/issues/722)
* **sanitize:** strip Meridian's own markers from assistant content on replay ([#738](https://github.com/rynfar/meridian/issues/738)) ([f19cf48](https://github.com/rynfar/meridian/commit/f19cf4834e9252cc27e0487dbce9dbc0a8ad754c)), closes [#724](https://github.com/rynfar/meridian/issues/724)

## [1.58.2](https://github.com/rynfar/meridian/compare/meridian-v1.58.1...meridian-v1.58.2) (2026-07-30)


### Bug Fixes

* **adapters:** stop x-session-affinity misrouting Crush to the OpenCode adapter ([#733](https://github.com/rynfar/meridian/issues/733)) ([1878ef8](https://github.com/rynfar/meridian/commit/1878ef86aedac17b88b6d342b4dffa1cc112e2cd))
* **errors:** target the extended-context hint at the tier that failed ([#730](https://github.com/rynfar/meridian/issues/730)) ([a453f66](https://github.com/rynfar/meridian/commit/a453f669aabfb260c6f666fcc9975dd0be653b26)), closes [#716](https://github.com/rynfar/meridian/issues/716)
* **routing:** normalize SDK reset timestamps to epoch milliseconds ([#727](https://github.com/rynfar/meridian/issues/727)) ([0660815](https://github.com/rynfar/meridian/commit/06608151e99cb9198cb14fadca359e7b9835d63c)), closes [#708](https://github.com/rynfar/meridian/issues/708)
* **routing:** skip OAuth usage refinement for non-claude-max profiles ([#729](https://github.com/rynfar/meridian/issues/729)) ([8610d20](https://github.com/rynfar/meridian/commit/8610d20865d18749e9a8ddec9ef03fa047100004)), closes [#699](https://github.com/rynfar/meridian/issues/699)
* **session:** ignore thinking blocks in the lineage hash ([#731](https://github.com/rynfar/meridian/issues/731)) ([5c419bd](https://github.com/rynfar/meridian/commit/5c419bd19c20187f865dec9c26105f7a52d1f32d)), closes [#710](https://github.com/rynfar/meridian/issues/710)

## [1.58.1](https://github.com/rynfar/meridian/compare/meridian-v1.58.0...meridian-v1.58.1) (2026-07-29)


### Bug Fixes

* **query:** correct the preset's false gitStatus provenance claim ([#726](https://github.com/rynfar/meridian/issues/726)) ([8ce601b](https://github.com/rynfar/meridian/commit/8ce601babef481a4d168367cb14cb6586f3d4824)), closes [#694](https://github.com/rynfar/meridian/issues/694)
* **sanitize:** make &lt;thinking&gt; stripping opt-in ([#721](https://github.com/rynfar/meridian/issues/721)) ([15f6eb5](https://github.com/rynfar/meridian/commit/15f6eb5c10689d28e136be8e947b86decd3797ff))

## [1.58.0](https://github.com/rynfar/meridian/compare/meridian-v1.57.1...meridian-v1.58.0) (2026-07-29)


### Features

* **health:** report how long the login has left ([007882b](https://github.com/rynfar/meridian/commit/007882b96a962f78e7d55db0f9e75636c3cf39a8))
* **health:** report how long the login has left ([22d0c81](https://github.com/rynfar/meridian/commit/22d0c818c988778298670e21ddc26a8a3a4d324d))
* **models:** add per-tier 1M context overrides for fable and opus ([#714](https://github.com/rynfar/meridian/issues/714)) ([2c92b37](https://github.com/rynfar/meridian/commit/2c92b379fbc09f9afc3c9118f062425b30e67179))


### Bug Fixes

* **session:** reject compaction that resumes past the last message ([392e3c8](https://github.com/rynfar/meridian/commit/392e3c872756b219f12c0161cb191d3868fb94b8))
* **session:** reject compaction that resumes past the last message ([8c30899](https://github.com/rynfar/meridian/commit/8c3089956f852eb15ca7ceca37f5c9af164173b4))


### Performance

* **health:** cache the refresh-token expiry read ([b33f2be](https://github.com/rynfar/meridian/commit/b33f2beb3491bee1c6f91af6aac6a96b4484d6e2))

## [1.57.1](https://github.com/rynfar/meridian/compare/meridian-v1.57.0...meridian-v1.57.1) (2026-07-28)


### Bug Fixes

* give keyless conversations priority-pool affinity ([#704](https://github.com/rynfar/meridian/issues/704)) ([fcec079](https://github.com/rynfar/meridian/commit/fcec079e2f519de7dd65f553941835a765cf3aac))
* make postinstall script Windows-portable ([ac8244b](https://github.com/rynfar/meridian/commit/ac8244bdf642618070917511363cd659bdc2a6f0))
* make postinstall script Windows-portable ([379e0c9](https://github.com/rynfar/meridian/commit/379e0c9d118c063452715f805a0d65e8c641b3e5))
* replay stale session histories safely + lineage safety harness ([#705](https://github.com/rynfar/meridian/issues/705)) ([9aa8aff](https://github.com/rynfar/meridian/commit/9aa8affb07ce5c4e051a496efc5379eb9be0b456))
* **responses:** harden typeless-item handling against malformed input ([3c94acd](https://github.com/rynfar/meridian/commit/3c94acd40a6b82e4d68010da4ee892e2b145184b))
* **responses:** treat input items without a type as messages ([013f85d](https://github.com/rynfar/meridian/commit/013f85d48a30a5b396601eba24c9dc87a04739ca))
* **responses:** treat input items without a type as messages ([c8a37d0](https://github.com/rynfar/meridian/commit/c8a37d01437679bc66e433801fcd5d7785b57782))
* scope rate-limit store per profile so priority cooldowns use the right account's reset ([#697](https://github.com/rynfar/meridian/issues/697)) ([1cd557c](https://github.com/rynfar/meridian/commit/1cd557c442025cf7ac003c0c79f05d0797dd47a6))
* **session:** bound modified-continuation resume so stale lineage replays fresh ([6b61e66](https://github.com/rynfar/meridian/commit/6b61e66ac2bce14364b435d5d9bc80e9bcaf88f5))
* **session:** bound modified-continuation resume so stale lineage replays fresh ([141eab5](https://github.com/rynfar/meridian/commit/141eab58009dbedb9a41ae904d61eec9e960c5d0)), closes [#689](https://github.com/rynfar/meridian/issues/689)
* **settings:** isolate tests from the developer's real settings file ([#703](https://github.com/rynfar/meridian/issues/703)) ([2a30a8c](https://github.com/rynfar/meridian/commit/2a30a8c3d6b1eb4b854c85785d2c46d1d73b9bd4))
* surface claude-code postinstall output instead of silencing it ([301cc5c](https://github.com/rynfar/meridian/commit/301cc5ca91dec9efd95049a7b830cd950f6f0289))

## [1.57.0](https://github.com/rynfar/meridian/compare/meridian-v1.56.1...meridian-v1.57.0) (2026-07-24)


### Features

* add Claude Opus 5 to the model list, make it the canonical opus ([f0c885c](https://github.com/rynfar/meridian/commit/f0c885c53ec027eafb8f70bf5d68889971f464c7))
* add Claude Opus 5 to the model list, make it the canonical opus ([87cfcda](https://github.com/rynfar/meridian/commit/87cfcdadf24c0e64ef08e2ee81fc5d8debc2bfea))
* image input and incomplete status for Responses API (/v1/responses) ([37fb773](https://github.com/rynfar/meridian/commit/37fb773744196d72d0c153f0cf693461572617ce))
* support image input and incomplete status in Responses API ([92745e0](https://github.com/rynfar/meridian/commit/92745e0cee278bfc70f5bc698e2aa5d50fdae85d))

## [1.56.1](https://github.com/rynfar/meridian/compare/meridian-v1.56.0...meridian-v1.56.1) (2026-07-23)


### Bug Fixes

* **ui:** restore the visual pace bar on account cards ([#681](https://github.com/rynfar/meridian/issues/681)) ([e7117de](https://github.com/rynfar/meridian/commit/e7117de55263d156f8c4f36c1ca182fb0b552ab4))

## [1.56.0](https://github.com/rynfar/meridian/compare/meridian-v1.55.1...meridian-v1.56.0) (2026-07-23)


### Features

* attribute active-profile switches in logs ([#679](https://github.com/rynfar/meridian/issues/679)) ([77c01e4](https://github.com/rynfar/meridian/commit/77c01e4bea047a53f1301dbd4f0b1d4cbe5d5626))
* priority profile routing — ordered account pool with per-request failover (opt-in) ([#680](https://github.com/rynfar/meridian/issues/680)) ([5fb735b](https://github.com/rynfar/meridian/commit/5fb735b05f3963a46edae7183d11142ade44842e))
* **ui:** per-account weekly pace on home; remove the telemetry Usage tab ([#678](https://github.com/rynfar/meridian/issues/678)) ([526ecbd](https://github.com/rynfar/meridian/commit/526ecbdd4fc0562e8f7a7fb3bb6df3c60361590b))


### Bug Fixes

* serve bounded-stale OAuth usage on transient fetch failures ([#677](https://github.com/rynfar/meridian/issues/677)) ([ca1cc56](https://github.com/rynfar/meridian/commit/ca1cc56363098b37ab6c9cf1e1937de1042f78df))
* **ui:** error color belongs to the errors detail, not the request total ([#674](https://github.com/rynfar/meridian/issues/674)) ([1642955](https://github.com/rynfar/meridian/commit/16429551bdb68ae00ee922ebe8baf0adc2c9cefa))

## [1.55.1](https://github.com/rynfar/meridian/compare/meridian-v1.55.0...meridian-v1.55.1) (2026-07-23)


### Bug Fixes

* never rename a subagent_type that is already a registered agent ([#672](https://github.com/rynfar/meridian/issues/672)) ([c72f91f](https://github.com/rynfar/meridian/commit/c72f91f723c50b0bd7a90e1351f72558f3b3a6a2)), closes [#671](https://github.com/rynfar/meridian/issues/671)

## [1.55.0](https://github.com/rynfar/meridian/compare/meridian-v1.54.0...meridian-v1.55.0) (2026-07-21)


### Features

* **codex:** resume SDK sessions across turns via prompt_cache_key ([#655](https://github.com/rynfar/meridian/issues/655)) ([#665](https://github.com/rynfar/meridian/issues/665)) ([84cbdc5](https://github.com/rynfar/meridian/commit/84cbdc5e06bbff2bf588b5d0075378590d560337))
* install plugins in Docker via MERIDIAN_PLUGINS ([dd6e8d3](https://github.com/rynfar/meridian/commit/dd6e8d39753abf9abddae7f48d5f306bf0829cff))
* install plugins in Docker via MERIDIAN_PLUGINS ([#668](https://github.com/rynfar/meridian/issues/668) + fix-ups) ([9dcb3d3](https://github.com/rynfar/meridian/commit/9dcb3d337114f9dd803e994cdb4827fd74fe5e0c))


### Bug Fixes

* **docker:** anchor the plugin install root, harden failure paths ([9ce7dd9](https://github.com/rynfar/meridian/commit/9ce7dd9ba56d67e458f1e6d1af97d9e1d7af7717))
* explicit session keys override the fork/subagent independence guard ([#669](https://github.com/rynfar/meridian/issues/669)) ([b46e08e](https://github.com/rynfar/meridian/commit/b46e08ed5358c6738e73362fd483524b6b1ef7b7))

## [1.54.0](https://github.com/rynfar/meridian/compare/meridian-v1.53.0...meridian-v1.54.0) (2026-07-19)


### Features

* Claude Design MCP proxy (/v1/design/*) with dedicated OAuth flow ([e1547c3](https://github.com/rynfar/meridian/commit/e1547c3625b486bfcd1864c848babc3098719f28))
* Claude Design MCP proxy (/v1/design/*) with dedicated OAuth flow ([#543](https://github.com/rynfar/meridian/issues/543)) ([1963c94](https://github.com/rynfar/meridian/commit/1963c94669eaa7821d7f449b195b638c653dfd67))


### Bug Fixes

* **mcp:** stop shell-interpolating grep tool input, treat exit 1 as no matches ([05513c4](https://github.com/rynfar/meridian/commit/05513c451725ce75865dfeae4f1dc1b756e17119))

## [1.53.0](https://github.com/rynfar/meridian/compare/meridian-v1.52.0...meridian-v1.53.0) (2026-07-19)


### Features

* **nix:** package plugins as a meridianPlugins set ([#635](https://github.com/rynfar/meridian/issues/635) by [@connor-grady](https://github.com/connor-grady)) ([f8a6077](https://github.com/rynfar/meridian/commit/f8a60770f45aae577a3957de2b07c8a4fab1d58f))
* **nix:** package plugins as legacyPackages.meridianPlugins ([e961d33](https://github.com/rynfar/meridian/commit/e961d3398ade055f81ff588ec3bd92ead5d76522))
* OpenAI Responses API (/v1/responses) for Codex CLI ([#475](https://github.com/rynfar/meridian/issues/475)) ([#654](https://github.com/rynfar/meridian/issues/654)) ([01baa0f](https://github.com/rynfar/meridian/commit/01baa0f4d83738fa5c302149d0e05780f2d47f2b))


### Bug Fixes

* **ci:** plugin-input bumps go through a PR, not a direct push to main ([27faabb](https://github.com/rynfar/meridian/commit/27faabb36664c967897a612d88078dfd42535e41))
* **nix:** make the wrapper's claude-code path a default, not an override ([ea30016](https://github.com/rynfar/meridian/commit/ea30016a3fe0c8ac9548b92feb896720214f645d))
* **plugin:** rebuild agent-mode map on config reload ([#659](https://github.com/rynfar/meridian/issues/659)) ([32b5ae6](https://github.com/rynfar/meridian/commit/32b5ae63cb707f2ed0d6cf788a5ee2bacf9c8ffa))
* **plugin:** resolve agent mode for string agents (OpenCode &gt;= 1.17) ([#657](https://github.com/rynfar/meridian/issues/657)) ([967a8af](https://github.com/rynfar/meridian/commit/967a8af6efe9857c34b83267a1c79d98a36ee470))

## [1.52.0](https://github.com/rynfar/meridian/compare/meridian-v1.51.0...meridian-v1.52.0) (2026-07-17)


### Features

* add Sonnet 5 to the model list, make it the canonical sonnet ([#631](https://github.com/rynfar/meridian/issues/631)) ([#644](https://github.com/rynfar/meridian/issues/644)) ([b1cde57](https://github.com/rynfar/meridian/commit/b1cde574e78b39de7118f356d302da974c99e7ae))
* **cli:** read MERIDIAN_PLUGIN_DIR and MERIDIAN_PLUGIN_CONFIG env vars ([59743bd](https://github.com/rynfar/meridian/commit/59743bdf586ede60e08642df1e505f2bf157fcbf))
* env-configurable plugin loading + home-manager plugin settings ([#623](https://github.com/rynfar/meridian/issues/623) by [@connor-grady](https://github.com/connor-grady)) ([b40bfba](https://github.com/rynfar/meridian/commit/b40bfba577b8a5a777f30e1b5f33cde554e05e1b))
* **nix:** add pluginConfig and pluginDir home-manager settings ([5cb1821](https://github.com/rynfar/meridian/commit/5cb18211634acd32d1efef38c24d1813791966e1))


### Bug Fixes

* decouple SDK settings from settingSources so memory:false works with claudeMd off ([#634](https://github.com/rynfar/meridian/issues/634)) ([#645](https://github.com/rynfar/meridian/issues/645)) ([379bd6b](https://github.com/rynfar/meridian/commit/379bd6bfa62f96ce1a6f02416aa15f6de421fbd8))
* frame fresh-session replays in a context-only envelope ([#619](https://github.com/rynfar/meridian/issues/619)) ([#646](https://github.com/rynfar/meridian/issues/646)) ([ce1f954](https://github.com/rynfar/meridian/commit/ce1f9543a94222c08fbfc548c2889f737ebf6b94))
* hold non-stream denies until turn end — parallel calls survive both modes ([#592](https://github.com/rynfar/meridian/issues/592)) ([#647](https://github.com/rynfar/meridian/issues/647)) ([0d50467](https://github.com/rynfar/meridian/commit/0d50467e4c05e9b127b0f6ba8883f3d01625b2b9))
* **nix:** only export MERIDIAN_PLUGIN_CONFIG when plugins are configured ([f241032](https://github.com/rynfar/meridian/commit/f241032fa25929b899ac4d1819302bbd5c297062))
* retry busy-session resume refusals instead of failing deterministically ([#630](https://github.com/rynfar/meridian/issues/630)) ([#643](https://github.com/rynfar/meridian/issues/643)) ([81b589c](https://github.com/rynfar/meridian/commit/81b589c654d7f640e308a079ab45aececf7ae884))

## [1.51.0](https://github.com/rynfar/meridian/compare/meridian-v1.50.0...meridian-v1.51.0) (2026-07-17)


### Features

* **telemetry:** cost estimation cards with configurable model pricing ([afd3eda](https://github.com/rynfar/meridian/commit/afd3eda8a00c575c96e8cca1e7c47302edcacab7))
* **telemetry:** per-profile usage indicators on the landing page ([#637](https://github.com/rynfar/meridian/issues/637)) ([4642813](https://github.com/rynfar/meridian/commit/4642813a2920e8d7dc193cb62382ee7c755abb55))
* **telemetry:** redesign the landing page around per-account value ([#639](https://github.com/rynfar/meridian/issues/639)) ([7c39072](https://github.com/rynfar/meridian/commit/7c3907274edf630a67d066e20f50a2e04b612a19))
* **telemetry:** usage-value batch — cost estimation ([#629](https://github.com/rynfar/meridian/issues/629)) + model-scoped quotas ([#624](https://github.com/rynfar/meridian/issues/624)) ([c04898b](https://github.com/rynfar/meridian/commit/c04898b279cbf23316fd8f40f19356a4705b0789))
* **ui:** design system, site header, switchable account cards + full README audit ([#640](https://github.com/rynfar/meridian/issues/640)) ([70f526a](https://github.com/rynfar/meridian/commit/70f526a3fe753b9a9fb6c95bb136550da3db060e))


### Bug Fixes

* expose model-scoped usage limits ([546d86c](https://github.com/rynfar/meridian/commit/546d86cb09c4f90a946cf2decdd7a8e416578c0a))
* **telemetry:** harden the cost-estimation batch ([6571bf1](https://github.com/rynfar/meridian/commit/6571bf1b1f43c6bcc4ba42015adf5abdfaf5a506))

## [1.50.0](https://github.com/rynfar/meridian/compare/meridian-v1.49.1...meridian-v1.50.0) (2026-07-16)


### Features

* **telemetry:** envelope-integrity tripwires for wire-contract violations ([#632](https://github.com/rynfar/meridian/issues/632)) ([4f8db58](https://github.com/rynfar/meridian/commit/4f8db589e1be65e0c83476e6c9926bebbf84c135))


### Bug Fixes

* **passthrough:** hold denies until generation completes ([#552](https://github.com/rynfar/meridian/issues/552) streaming red reads) ([#625](https://github.com/rynfar/meridian/issues/625)) ([df48e3b](https://github.com/rynfar/meridian/commit/df48e3b9f0a374ee4e30665ee10add17da77e98e))
* **passthrough:** suppress the SDK subprocess's scratchpad advertisement ([#627](https://github.com/rynfar/meridian/issues/627)) ([#628](https://github.com/rynfar/meridian/issues/628)) ([18d6b24](https://github.com/rynfar/meridian/commit/18d6b24da8c12a649df852027427d679fcc89fcb))

## [1.49.1](https://github.com/rynfar/meridian/compare/meridian-v1.49.0...meridian-v1.49.1) (2026-07-14)


### Bug Fixes

* **passthrough:** capture parallel same-tool calls instead of dropping them ([#620](https://github.com/rynfar/meridian/issues/620)) ([f732658](https://github.com/rynfar/meridian/commit/f7326582a3ecf5c79ca9cdcc509bd39c3d88b406))
* **passthrough:** strip hook-dropped tool calls from the client response ([#622](https://github.com/rynfar/meridian/issues/622)) ([141bee0](https://github.com/rynfar/meridian/commit/141bee01270d07e09667aea0c3b7a0770b849aff))

## [1.49.0](https://github.com/rynfar/meridian/compare/meridian-v1.48.1...meridian-v1.49.0) (2026-07-13)


### Features

* **adapters:** named adapter instances with per-instance config ([#616](https://github.com/rynfar/meridian/issues/616)) ([fcc1d3e](https://github.com/rynfar/meridian/commit/fcc1d3ebb54d12f64c880956e4e3ee1692cc730e)), closes [#476](https://github.com/rynfar/meridian/issues/476)
* **profiles:** sticky session-to-profile routing via rendezvous hashing ([#615](https://github.com/rynfar/meridian/issues/615)) ([873a53b](https://github.com/rynfar/meridian/commit/873a53b5d96cff5db9ed7bded3971fc71417ba57)), closes [#383](https://github.com/rynfar/meridian/issues/383)


### Bug Fixes

* **nix:** patch vendored ELF binaries so claude.exe runs on NixOS ([#612](https://github.com/rynfar/meridian/issues/612)) ([ef899f4](https://github.com/rynfar/meridian/commit/ef899f44461f50166e81b2b4bb73c9d17949c931))
* **replay:** stop rendering Human:/Assistant: transcript lines in prompts ([#618](https://github.com/rynfar/meridian/issues/618)) ([1e1228c](https://github.com/rynfar/meridian/commit/1e1228c46f55129a89b1fc3a32a152ae12d143e9))

## [1.48.1](https://github.com/rynfar/meridian/compare/meridian-v1.48.0...meridian-v1.48.1) (2026-07-13)


### Bug Fixes

* **replay:** preserve edit content and agency in fresh-replay history ([#610](https://github.com/rynfar/meridian/issues/610)) ([33760c4](https://github.com/rynfar/meridian/commit/33760c4c054d4b8acbadffdc8e04a400cc71ea65))

## [1.48.0](https://github.com/rynfar/meridian/compare/meridian-v1.47.0...meridian-v1.48.0) (2026-07-13)


### Features

* **adapters:** add Cherry Studio adapter with built-in web search ([#481](https://github.com/rynfar/meridian/issues/481)) ([#608](https://github.com/rynfar/meridian/issues/608)) ([32667c8](https://github.com/rynfar/meridian/commit/32667c804fecadc7d811e27f672454591735e920))


### Bug Fixes

* **ci:** read Docker release version from package.json ([#605](https://github.com/rynfar/meridian/issues/605)) ([3fa2d71](https://github.com/rynfar/meridian/commit/3fa2d716cea26ec9fc66cfcf266865374be95f9f))
* **tools:** fail fast on native Anthropic server tools (web_search/web_fetch) ([#607](https://github.com/rynfar/meridian/issues/607)) ([920a318](https://github.com/rynfar/meridian/commit/920a318b76bd73fecb74eaad7eeb7f44bc20bf59))


### Performance

* **passthrough:** eliminate the billed digest turn after tool capture ([#609](https://github.com/rynfar/meridian/issues/609)) ([741f645](https://github.com/rynfar/meridian/commit/741f6456ce55ff458e4b9c58afa62a6a50220c02))

## [1.47.0](https://github.com/rynfar/meridian/compare/meridian-v1.46.0...meridian-v1.47.0) (2026-07-13)


### Features

* **dashboard:** add Usage tab with session, weekly, and weekly-pace ([#604](https://github.com/rynfar/meridian/issues/604)) ([e0853af](https://github.com/rynfar/meridian/commit/e0853af63cc5a5cd82bc85ba93ef98e362808497))


### Bug Fixes

* **ci:** derive Docker semver from tag_name, not the empty version output ([#601](https://github.com/rynfar/meridian/issues/601)) ([144a7ce](https://github.com/rynfar/meridian/commit/144a7ce4623fb9ff838039d875b749aa72f0eb86))

## [1.46.0](https://github.com/rynfar/meridian/compare/meridian-v1.45.4...meridian-v1.46.0) (2026-07-13)


### Features

* **models:** route Claude Mythos 5 (claude-mythos-*) through the fable tier ([a42a5cf](https://github.com/rynfar/meridian/commit/a42a5cfcc672e01bbb4e28d7f6042ce4d3f4e156))
* **models:** route Claude Mythos 5 (claude-mythos-*) through the fable tier ([c218527](https://github.com/rynfar/meridian/commit/c218527e4a91e4b65a3cfc12e813f1f51ffcd205))


### Bug Fixes

* give deferred passthrough sessions a turn for ToolSearch discovery ([#598](https://github.com/rynfar/meridian/issues/598)) ([b1e4681](https://github.com/rynfar/meridian/commit/b1e4681adbab4c93e875bb655fba7991a7881c9a))

## [1.45.4](https://github.com/rynfar/meridian/compare/meridian-v1.45.3...meridian-v1.45.4) (2026-07-12)


### Bug Fixes

* attribute replayed tool results to the calls that produced them ([#590](https://github.com/rynfar/meridian/issues/590)) ([99a2ab1](https://github.com/rynfar/meridian/commit/99a2ab1a8172535eb5bbbd32492248801919a3b0))
* close dangling content blocks before recovery frames (red aborted tool calls) ([#591](https://github.com/rynfar/meridian/issues/591)) ([d0a5bf3](https://github.com/rynfar/meridian/commit/d0a5bf324ea4ccc0f2edebd9a477cc4681ab9d14))
* consolidate mid-history multimodal onto the final user turn ([#588](https://github.com/rynfar/meridian/issues/588)) ([fdea2be](https://github.com/rynfar/meridian/commit/fdea2be1be7d9d157f94778b02779d5220cfc73b))
* resume Claude Code sessions after tool results ([dba529c](https://github.com/rynfar/meridian/commit/dba529cd464eb773714d572ef34c27c9ac994f31))
* resume Claude Code sessions after tool results ([468dd08](https://github.com/rynfar/meridian/commit/468dd0842f7474928855881293559af830536f89))

## [1.45.3](https://github.com/rynfar/meridian/compare/meridian-v1.45.2...meridian-v1.45.3) (2026-07-10)


### Bug Fixes

* apply opencode transforms to the openai adapter ([#587](https://github.com/rynfar/meridian/issues/587)) ([465cd2d](https://github.com/rynfar/meridian/commit/465cd2d32e285581e0823e68b8793683a1013950))
* clamp token-refresh timer delay to the 32-bit max (Node 26 overflow loop) ([#583](https://github.com/rynfar/meridian/issues/583)) ([7ea7c6f](https://github.com/rynfar/meridian/commit/7ea7c6feacda44bc6029033807100e2e9394a47c))
* populate capabilities on /v1/models so clients allow image input ([#585](https://github.com/rynfar/meridian/issues/585)) ([31b6042](https://github.com/rynfar/meridian/commit/31b604271666d9a8f39dc211563c1919f1519c6b))
* require a meaningful baseline before flagging a context spike ([#586](https://github.com/rynfar/meridian/issues/586)) ([b469aeb](https://github.com/rynfar/meridian/commit/b469aeb88f5758918ad3c581d81de961690dc7df))
* stop bash redirect heuristic emitting non-path false positives ([#581](https://github.com/rynfar/meridian/issues/581)) ([b3706b6](https://github.com/rynfar/meridian/commit/b3706b6cb921c73132b420a2b2a2a801e8995d40))
* strip SDK-only context_management from forwarded stream events ([#584](https://github.com/rynfar/meridian/issues/584)) ([76086ca](https://github.com/rynfar/meridian/commit/76086ca4d94b7df26605d5eebad08e9050e42e84))

## [1.45.2](https://github.com/rynfar/meridian/compare/meridian-v1.45.1...meridian-v1.45.2) (2026-07-10)


### Bug Fixes

* forward token usage on OpenAI-format streaming responses ([6c9f04a](https://github.com/rynfar/meridian/commit/6c9f04acbe221a554bb32e8e64ebe3eeb3831f58))
* **passthrough:** truthful deny reasons for dropped tool calls ([#580](https://github.com/rynfar/meridian/issues/580)) ([661276d](https://github.com/rynfar/meridian/commit/661276d75d8181f5a7da9e2588c28c8058b011db)), closes [#552](https://github.com/rynfar/meridian/issues/552)

## [1.45.1](https://github.com/rynfar/meridian/compare/meridian-v1.45.0...meridian-v1.45.1) (2026-07-10)


### Bug Fixes

* forward explicit sonnet/haiku model requests via ANTHROPIC_DEFAULT_*_MODEL overrides ([0b6215a](https://github.com/rynfar/meridian/commit/0b6215a2500e20bebbd6616c418082d1f14543d1))
* forward sonnet/haiku model requests via ANTHROPIC_DEFAULT_*_MODEL overrides ([49d2798](https://github.com/rynfar/meridian/commit/49d2798a0ca803db1c9772cfd1bed31cf61acb26))
* **passthrough:** abort nested SDK session once single-step capture completes ([#575](https://github.com/rynfar/meridian/issues/575)) ([b6e9cfe](https://github.com/rynfar/meridian/commit/b6e9cfe0e70af7292f9fa78855ed24ee4573cedb)), closes [#570](https://github.com/rynfar/meridian/issues/570)
* **passthrough:** correct single-step semantics for client-driven tool loops ([#571](https://github.com/rynfar/meridian/issues/571)) ([35b6b92](https://github.com/rynfar/meridian/commit/35b6b927b348b7ac952b9cf19590565ecf866bb3))
* **passthrough:** exempt SDK-internal StructuredOutput tool from deny hook ([#577](https://github.com/rynfar/meridian/issues/577)) ([8edba2e](https://github.com/rynfar/meridian/commit/8edba2e72f30110e548487a18dc8f1b1b096d3c5)), closes [#576](https://github.com/rynfar/meridian/issues/576)
* propagate client request cancellation ([#574](https://github.com/rynfar/meridian/issues/574)) ([06c4dca](https://github.com/rynfar/meridian/commit/06c4dcac02a462822d1d9a4f8908d004601825e1))
* remove MultiEdit from BLOCKED_BUILTIN_TOOLS ([8d14403](https://github.com/rynfar/meridian/commit/8d144034ae9c05362113a4ddd715f610ce9a36dc))
* remove MultiEdit from BLOCKED_BUILTIN_TOOLS ([f3ea852](https://github.com/rynfar/meridian/commit/f3ea852e9d7429f3ec7fb112f3d7c42169296dfa))
* support native structured output ([#573](https://github.com/rynfar/meridian/issues/573)) ([8773ac2](https://github.com/rynfar/meridian/commit/8773ac2b413e8cfdef2f10fbcd8314c0a2437420))

## [1.45.0](https://github.com/rynfar/meridian/compare/meridian-v1.44.1...meridian-v1.45.0) (2026-07-01)


### Features

* add MERIDIAN_1M_CONTEXT_SUPPORT toggle to disable 1M auto-selection ([#555](https://github.com/rynfar/meridian/issues/555)) ([82bb517](https://github.com/rynfar/meridian/commit/82bb5179fee3979439af00a75c92a75a80ce7d87))
* **models:** add Claude Fable 5 (claude-fable-5) support ([#561](https://github.com/rynfar/meridian/issues/561)) ([8d48272](https://github.com/rynfar/meridian/commit/8d482726f7aa0c470a09754d690fff6cc55201c1))


### Bug Fixes

* **thinking:** drop effort when the thinking beta is stripped ([#559](https://github.com/rynfar/meridian/issues/559)) ([e2eb805](https://github.com/rynfar/meridian/commit/e2eb80520ca9caff82be921a6fc409444cbbac24))
* **thinking:** honor explicit "disabled" setting over client requests ([#562](https://github.com/rynfar/meridian/issues/562)) ([45e08a9](https://github.com/rynfar/meridian/commit/45e08a919cb442bde2aff57547bc14b3a421a466))

## [1.44.1](https://github.com/rynfar/meridian/compare/meridian-v1.44.0...meridian-v1.44.1) (2026-06-25)


### Bug Fixes

* implement passthrough for the pi adapter ([#544](https://github.com/rynfar/meridian/issues/544)) ([dc1bf2f](https://github.com/rynfar/meridian/commit/dc1bf2f2384c39fef98d63b051119b457149032f))

## [1.44.0](https://github.com/rynfar/meridian/compare/meridian-v1.43.0...meridian-v1.44.0) (2026-06-16)


### Features

* **effort:** accept reasoning_effort end-to-end (OpenAI translation + validation) ([#536](https://github.com/rynfar/meridian/issues/536)) ([bf38f2b](https://github.com/rynfar/meridian/commit/bf38f2bfdf6e2005b0367b337272151b8f531110))
* **profiles:** add headless OAuth code flow ([#504](https://github.com/rynfar/meridian/issues/504)) ([28f6a01](https://github.com/rynfar/meridian/commit/28f6a01c153de03cf7c3737a26daf9ab38f1cb65))


### Bug Fixes

* **docker:** match meridian-v* release tags for image builds ([#507](https://github.com/rynfar/meridian/issues/507)) ([186b268](https://github.com/rynfar/meridian/commit/186b2684a66711389af1fd6bdab92969f0ed1b29))
* **logging:** gate [PROXY] operational stderr behind config.silent ([#537](https://github.com/rynfar/meridian/issues/537)) ([e69a8db](https://github.com/rynfar/meridian/commit/e69a8db71c04c8e3b0ab8249835619df413d5d85))
* **openai:** don't inject claude_code preset on /v1/chat/completions ([#533](https://github.com/rynfar/meridian/issues/533)) ([1e8ddd3](https://github.com/rynfar/meridian/commit/1e8ddd3e59ea7e2ac54b837f4ed3e71cabe250e0))
* **profiles:** refresh selected profile credentials ([#500](https://github.com/rynfar/meridian/issues/500)) ([c389ac1](https://github.com/rynfar/meridian/commit/c389ac1f679e475f8c7e7036bf7f74a6a874d12e))
* **server:** install uncaughtException/unhandledRejection handlers for library consumers ([#505](https://github.com/rynfar/meridian/issues/505)) ([8b77143](https://github.com/rynfar/meridian/commit/8b77143f8f0762d92da2c5a4adec23ee4415c11d))
* **setup:** never overwrite opencode.json; merge non-destructively (closes [#519](https://github.com/rynfar/meridian/issues/519)) ([#538](https://github.com/rynfar/meridian/issues/538)) ([8c5ad3e](https://github.com/rynfar/meridian/commit/8c5ad3e057c08e732cd8078f575455d6d0600cfb))
* **tokenRefresh:** silence scheduled refresh log ([#518](https://github.com/rynfar/meridian/issues/518)) ([da722a3](https://github.com/rynfar/meridian/commit/da722a397ff5b39e946bf5012b924323fb199c1e))
* Windows build + partial-overlap export dedup ([#510](https://github.com/rynfar/meridian/issues/510)) ([619a582](https://github.com/rynfar/meridian/commit/619a582db221fd425f16afb0fd5536e58a302a36))

## [1.43.0](https://github.com/rynfar/meridian/compare/meridian-v1.42.1...meridian-v1.43.0) (2026-05-29)


### Features

* support Claude Opus 4.8 ([#521](https://github.com/rynfar/meridian/issues/521)) ([236781d](https://github.com/rynfar/meridian/commit/236781de81aa1a303e9e766c5c1a69207db3571f))


### Bug Fixes

* **proxy:** support explicit opus 4.6 and 4.7 pins ([#497](https://github.com/rynfar/meridian/issues/497)) ([597a304](https://github.com/rynfar/meridian/commit/597a3042cbb7435297cab9960c3dccade3e6bd6f))

## [1.42.1](https://github.com/rynfar/meridian/compare/meridian-v1.42.0...meridian-v1.42.1) (2026-05-06)


### Bug Fixes

* **auth-status:** route claude auth status/login through resolver, not PATH ([#478](https://github.com/rynfar/meridian/issues/478)) ([#492](https://github.com/rynfar/meridian/issues/492)) ([5ca8212](https://github.com/rynfar/meridian/commit/5ca82120d3e5114dcc8fce926ee156d9a3380ca0))
* **passthrough:** strip SDK tool catalog and CLAUDE.md from upstream payload ([#490](https://github.com/rynfar/meridian/issues/490)) ([b279fee](https://github.com/rynfar/meridian/commit/b279feed06c8ba035256370c0ccefc712522130d))

## [1.42.0](https://github.com/rynfar/meridian/compare/meridian-v1.41.1...meridian-v1.42.0) (2026-05-06)


### Features

* **diagnostics:** surface resolved Claude executable + source in /health and startup log ([#485](https://github.com/rynfar/meridian/issues/485)) ([c875cb4](https://github.com/rynfar/meridian/commit/c875cb49008641e252f968e8cb4e27a360dd369b))
* register OAuth token as profile (closes [#446](https://github.com/rynfar/meridian/issues/446)) ([e2c9b81](https://github.com/rynfar/meridian/commit/e2c9b8181d62fcacc9ec740a606af66e719aa781))
* **tokenRefresh:** background scheduler keeps refresh chain warm ([becf7f7](https://github.com/rynfar/meridian/commit/becf7f7cebc8fa8dafc631fc4e15e48b2f2af5e9))
* **tokenRefresh:** make scheduler activity visible in default logs ([59270c2](https://github.com/rynfar/meridian/commit/59270c21a4c2fcd878a88c2b2a59ecef98d24b89))
* **tokenRefresh:** proactive ensureFreshToken before SDK call ([0b82dfc](https://github.com/rynfar/meridian/commit/0b82dfca47e93aef34bff3d24c6ff313bfe69bb4))


### Bug Fixes

* **errors:** broaden isExpiredTokenError to catch generic 401s ([91e1bb3](https://github.com/rynfar/meridian/commit/91e1bb3964ea369a514ed0aa9f6ae76b6c9ffd95))
* **plugins:** convert Windows paths to file:// URLs for ESM import ([554d70c](https://github.com/rynfar/meridian/commit/554d70cf1ab0359137816a590d7aa5d5608a8812))
* **plugins:** gate pathToFileURL on win32 + add loader to windows-smoke CI ([150a456](https://github.com/rynfar/meridian/commit/150a4568a33753af1f1aabe6918bbcf6ceaa16ed))
* **profiles:** clean oauth-token isolation dir on profile remove ([39dd273](https://github.com/rynfar/meridian/commit/39dd2730b3ea6a4bbb0a8d486e0e9df4aa176aef))
* **profiles:** isolate oauth-token profile from host ~/.claude ([d400c55](https://github.com/rynfar/meridian/commit/d400c5525aaeee7834e0db6bfddfd48b82d6343a))
* **proxy:** fall back to process.cwd() when SDK cwd doesn't exist ([#381](https://github.com/rynfar/meridian/issues/381)) ([#473](https://github.com/rynfar/meridian/issues/473)) ([232f727](https://github.com/rynfar/meridian/commit/232f727d5dfb3d28fc5c7bfeabb4344292fb9878))
* **proxy:** forward auth headers on /v1/chat/completions internal hop ([#470](https://github.com/rynfar/meridian/issues/470)) ([6567639](https://github.com/rynfar/meridian/commit/65676394198cb1fc47b9b30704a872ee1cc57031)), closes [#415](https://github.com/rynfar/meridian/issues/415)
* **query:** preserve CLAUDE_CONFIG_DIR for oauth-token profiles under sharedMemory ([274dbf1](https://github.com/rynfar/meridian/commit/274dbf18653882e6761ee1fa6676827274c16e3c))
* **security:** require auth on /settings/api/* and /settings (closes [#477](https://github.com/rynfar/meridian/issues/477)) ([#486](https://github.com/rynfar/meridian/issues/486)) ([5db6341](https://github.com/rynfar/meridian/commit/5db63417ef0e14e63c57f079ce92432f527d9a26))
* **tokenRefresh:** generation-track scheduler to kill orphan chains ([aac7c9a](https://github.com/rynfar/meridian/commit/aac7c9a0122410b3fa83487f38a8f4810cb6ab86))

## [1.41.1](https://github.com/rynfar/meridian/compare/meridian-v1.41.0...meridian-v1.41.1) (2026-05-01)


### Bug Fixes

* **droid:** respect MERIDIAN_PASSTHROUGH env (closes [#440](https://github.com/rynfar/meridian/issues/440)) ([#461](https://github.com/rynfar/meridian/issues/461)) ([40b1ba8](https://github.com/rynfar/meridian/commit/40b1ba8b4c33854eba8c593325001d402491e5e4))
* **env:** strip CLAUDE_CODE_USE_POWERSHELL_TOOL from SDK env (closes [#441](https://github.com/rynfar/meridian/issues/441)) ([#468](https://github.com/rynfar/meridian/issues/468)) ([c113970](https://github.com/rynfar/meridian/commit/c113970c9a6d4406c3cf87bcff2204a4c6423836))
* **features:** respect codeSystemPrompt=false on passthrough (closes [#408](https://github.com/rynfar/meridian/issues/408)) ([#469](https://github.com/rynfar/meridian/issues/469)) ([2d0130c](https://github.com/rynfar/meridian/commit/2d0130c349ec1598b067c75adc35309bbc16fec5))
* **proxy:** reject empty messages array, defensive array allocation (closes [#450](https://github.com/rynfar/meridian/issues/450)) ([#466](https://github.com/rynfar/meridian/issues/466)) ([611e03c](https://github.com/rynfar/meridian/commit/611e03c4914bb6ae71f8cf7bca9adfd1f041f165))
* **proxy:** use SDK result.usage for non-stream output_tokens (closes [#449](https://github.com/rynfar/meridian/issues/449)) ([#465](https://github.com/rynfar/meridian/issues/465)) ([7a89322](https://github.com/rynfar/meridian/commit/7a893228e0ecf0e83f1aeac1758728e47b898fe8))
* **query:** strip CLAUDE_CONFIG_DIR for sharedMemory instead of setting (closes [#453](https://github.com/rynfar/meridian/issues/453)) ([#467](https://github.com/rynfar/meridian/issues/467)) ([95f61b0](https://github.com/rynfar/meridian/commit/95f61b031456304210853c41480a739ab357349e))
* **resolver:** Windows + broken-postinstall fallbacks (closes [#417](https://github.com/rynfar/meridian/issues/417), mitigates [#445](https://github.com/rynfar/meridian/issues/445)) ([#463](https://github.com/rynfar/meridian/issues/463)) ([8e088b0](https://github.com/rynfar/meridian/commit/8e088b07ad895898f3115bbf39584fbff286eeeb))
* **tokenRefresh:** write compact JSON for credentials (closes [#452](https://github.com/rynfar/meridian/issues/452)) ([#464](https://github.com/rynfar/meridian/issues/464)) ([22c9c41](https://github.com/rynfar/meridian/commit/22c9c41a3cde4f286f8a69f60d9099a5ae9ec65f))

## [1.41.0](https://github.com/rynfar/meridian/compare/meridian-v1.40.0...meridian-v1.41.0) (2026-05-01)


### Features

* **agentDefs:** fall back to input_schema enum for Task subagent extraction ([ae98e0a](https://github.com/rynfar/meridian/commit/ae98e0a01738d7b8f8f93b0ebe5f8c9d4e50179c))
* **agentDefs:** input_schema enum fallback for non-OpenCode Task tools (closes [#447](https://github.com/rynfar/meridian/issues/447)) ([189a3eb](https://github.com/rynfar/meridian/commit/189a3eb67329a278c35f3f4b616c00462f40c7da))
* **proxy:** continuous OAuth usage % via Anthropic's private /api/oauth/usage endpoint ([#439](https://github.com/rynfar/meridian/issues/439)) ([8442e11](https://github.com/rynfar/meridian/commit/8442e117a306f1d3d327dd56114ac4f37a088431))
* **proxy:** SDK termination diagnostics + max_turns recovery ([#454](https://github.com/rynfar/meridian/issues/454)) ([9dcd3f8](https://github.com/rynfar/meridian/commit/9dcd3f88cef6aadcdd7cf478cb2507f0e664efa5))
* **proxy:** tool calls + thinking in OpenAI translator (closes [#451](https://github.com/rynfar/meridian/issues/451)) ([a684343](https://github.com/rynfar/meridian/commit/a684343aa91ce2338fe078488e1de1655e79ef66))


### Bug Fixes

* **agentDefs:** clone definitions when registering case variants and aliases ([1b8633c](https://github.com/rynfar/meridian/commit/1b8633c3666ed05155df121ba18c7ef57788df9d))
* **agentDefs:** clone definitions when registering case variants and aliases (closes [#448](https://github.com/rynfar/meridian/issues/448)) ([8f236c4](https://github.com/rynfar/meridian/commit/8f236c43eeb91e53cf350052d86d3d1dc598e38a))
* **build:** add postbuild script to fix Bun bundler export artifacts ([31e31c3](https://github.com/rynfar/meridian/commit/31e31c3654c2d72017920c7eb56c825be12bdeaa))
* **build:** postbuild script for Bun bundler export artifacts (closes [#442](https://github.com/rynfar/meridian/issues/442)) ([6bc3735](https://github.com/rynfar/meridian/commit/6bc3735bf45e376ee5c16095bc16d20fda8ac22a))
* **docker:** install claude-code native binary in runtime stage ([81424ce](https://github.com/rynfar/meridian/commit/81424ce3d205922166899224f69ca38bfd4451b5))
* **docker:** install claude-code native binary in runtime stage (closes [#438](https://github.com/rynfar/meridian/issues/438)) ([485b5da](https://github.com/rynfar/meridian/commit/485b5daee68e1d6c5ad4b2506ce2be60be09aff3))
* **tools:** block additional Claude Code SDK built-in tools ([cefd828](https://github.com/rynfar/meridian/commit/cefd828295fe1f2036fcf93a4b27de9871d17e41))

## [1.40.0](https://github.com/rynfar/meridian/compare/meridian-v1.39.1...meridian-v1.40.0) (2026-04-26)


### Features

* **proxy:** expose Claude Max subscription quota via /v1/usage/quota ([#436](https://github.com/rynfar/meridian/issues/436)) ([6849537](https://github.com/rynfar/meridian/commit/68495376bcb24c946870d0dc6c91cc9ad25ae747))

## [1.39.1](https://github.com/rynfar/meridian/compare/meridian-v1.39.0...meridian-v1.39.1) (2026-04-26)


### Bug Fixes

* **detect:** MERIDIAN_DEFAULT_AGENT wins over claude-cli/* UA tiebreaker ([#433](https://github.com/rynfar/meridian/issues/433)) ([aa69984](https://github.com/rynfar/meridian/commit/aa69984b029a7b50ae906f40d44fa31b2391751f))

## [1.39.0](https://github.com/rynfar/meridian/compare/meridian-v1.38.0...meridian-v1.39.0) (2026-04-26)


### Features

* advisor tool support via SDK advisorModel option ([#413](https://github.com/rynfar/meridian/issues/413)) ([c179753](https://github.com/rynfar/meridian/commit/c179753f14d083eb06a436c58f605d8215552de9))
* Claude Code adapter with split SDK / client working directory ([a08b541](https://github.com/rynfar/meridian/commit/a08b541c482821f12e3004229debb23943a9f345))
* default agent types and fallback routing ([3a660e9](https://github.com/rynfar/meridian/commit/3a660e93089057301b04365b5d35a441b860155d))


### Bug Fixes

* align haiku model id with sonnet/opus short form ([#414](https://github.com/rynfar/meridian/issues/414)) ([47292f5](https://github.com/rynfar/meridian/commit/47292f589186abf22196193801787a5e7cb5f523))
* **models:** list claude-opus-4-7 in /v1/models ([#429](https://github.com/rynfar/meridian/issues/429)) ([b72bab8](https://github.com/rynfar/meridian/commit/b72bab87cf4f4b0e8e019a29eff1d168bfd5c7b0))
* **models:** pin SDK model aliases via ANTHROPIC_DEFAULT_*_MODEL env ([601ccd3](https://github.com/rynfar/meridian/commit/601ccd31b1a02d92e92b5897dbec2259198428b7))
* normalize context-usage to last iteration ([67a559f](https://github.com/rynfar/meridian/commit/67a559fd8ba39463398ed22f18c133d5bd82196b))
* normalize context-usage to last iteration ([0170adc](https://github.com/rynfar/meridian/commit/0170adcdfed101d94cbac4d8ed0e051f373bab07))
* normalize subagent_type in passthrough streaming and non-streaming ([41170e4](https://github.com/rynfar/meridian/commit/41170e4699c64660e7aa522da7b97d7c9ff6f386))
* normalize tool parameter names in passthrough mode ([1b92899](https://github.com/rynfar/meridian/commit/1b92899c54e3885bda76b5644b76f38650a891a2))
* **pi:** implement extractClientWorkingDirectory for defense in depth ([#428](https://github.com/rynfar/meridian/issues/428)) ([90fd26f](https://github.com/rynfar/meridian/commit/90fd26f22f8fbd37c24a34f6766606fab58a4808))
* **proxy:** allow 4 turns when passthrough has both resume and deferred tools ([6648603](https://github.com/rynfar/meridian/commit/66486039dd7b1594285ded96ce0feecdd0ba2e45))

## [1.38.0](https://github.com/rynfar/meridian/compare/meridian-v1.37.8...meridian-v1.38.0) (2026-04-21)


### Features

* plugin system (phase 1 adapter refactor + phase 2 plugin loading, UI, docs) ([#400](https://github.com/rynfar/meridian/issues/400)) ([08cdee8](https://github.com/rynfar/meridian/commit/08cdee8c09dfe737309ad320f2ed0e708fd74842))

## [1.37.8](https://github.com/rynfar/meridian/compare/meridian-v1.37.7...meridian-v1.37.8) (2026-04-19)


### Bug Fixes

* use documented releases_created output from release-please-action ([#398](https://github.com/rynfar/meridian/issues/398)) ([906ed6d](https://github.com/rynfar/meridian/commit/906ed6d8b957577b9adf9728004c989c55d01928))

## [1.37.7](https://github.com/rynfar/meridian/compare/meridian-v1.37.6...meridian-v1.37.7) (2026-04-19)


### Bug Fixes

* remove skip-labeling from release-please so releases auto-cut on merge ([#395](https://github.com/rynfar/meridian/issues/395)) ([3abf5e9](https://github.com/rynfar/meridian/commit/3abf5e933cb09a24a55fa5ea2342e971804106de))

## [1.37.6](https://github.com/rynfar/meridian/compare/meridian-v1.37.5...meridian-v1.37.6) (2026-04-19)


### Bug Fixes

* multimodal image handling for OpenAI chat completions and nested tool_result ([#392](https://github.com/rynfar/meridian/issues/392)) ([39f0f14](https://github.com/rynfar/meridian/commit/39f0f140d1894ff71edc39908430fb647ac435a2))

## [1.37.5](https://github.com/rynfar/meridian/compare/meridian-v1.37.4...meridian-v1.37.5) (2026-04-18)


### Bug Fixes

* pass include-component-in-tag on the release-please action input ([#374](https://github.com/rynfar/meridian/issues/374)) ([0d7e272](https://github.com/rynfar/meridian/commit/0d7e272403e3f79046a548b1617df18792017bd0))
* prevent cross-session context leakage via fingerprint cache for headerless OpenCode requests ([#382](https://github.com/rynfar/meridian/issues/382)) ([83b4bcc](https://github.com/rynfar/meridian/commit/83b4bcc9f46dc07228cb5c4d0566f7ce230db7d9))
* stop leaking tool_use/tool_result blocks as text into the prompt ([#386](https://github.com/rynfar/meridian/issues/386)) ([#388](https://github.com/rynfar/meridian/issues/388)) ([c3c48b5](https://github.com/rynfar/meridian/commit/c3c48b5886467844aa7e7e854405bca7231a7f17))

## [1.37.4](https://github.com/rynfar/meridian/compare/meridian-v1.37.3...meridian-v1.37.4) (2026-04-15)


### Bug Fixes

* cache passthrough MCP server per session to preserve prompt cache ([#367](https://github.com/rynfar/meridian/issues/367)) ([cb1a3b8](https://github.com/rynfar/meridian/commit/cb1a3b84c2ceea7adc3290998da82b68077a5301))
* preserve &lt;system-reminder&gt; content for non-Droid adapters ([#370](https://github.com/rynfar/meridian/issues/370)) ([d981414](https://github.com/rynfar/meridian/commit/d981414aeb1eba5f0ae5efc54a47c2e03be6ddb7))
* set include-component-in-tag so release-please finds prior tags ([#371](https://github.com/rynfar/meridian/issues/371)) ([a01c392](https://github.com/rynfar/meridian/commit/a01c392c7daea17ed84a07a63bb5f16e32001413))

## [1.37.3](https://github.com/rynfar/meridian/compare/meridian-v1.37.2...meridian-v1.37.3) (2026-04-14)


### Bug Fixes

* return empty object from PreToolUse hook for ToolSearch ([#362](https://github.com/rynfar/meridian/issues/362)) ([f246b8b](https://github.com/rynfar/meridian/commit/f246b8b78c4503481acbbc0f7a3e2affbfa3f35a))
* stop appending file change summaries for opencode (with regression guards) ([#363](https://github.com/rynfar/meridian/issues/363)) ([921d4f6](https://github.com/rynfar/meridian/commit/921d4f6a517f99a86d98148f1507a71325dd98e5))

## [1.37.2](https://github.com/rynfar/meridian/compare/meridian-v1.37.1...meridian-v1.37.2) (2026-04-13)


### Bug Fixes

* use component-specific output keys in release-please workflow ([#357](https://github.com/rynfar/meridian/issues/357)) ([a38adf1](https://github.com/rynfar/meridian/commit/a38adf17153239aace60a52fb2974a0afd804420))

## [1.37.1](https://github.com/rynfar/meridian/compare/meridian-v1.37.0...meridian-v1.37.1) (2026-04-13)


### Bug Fixes

* cache tool definitions per session to prevent prompt cache invalidation ([a74e53c](https://github.com/rynfar/meridian/commit/a74e53caf26cf2861977f8f5bf060b6022d59e43)), closes [#353](https://github.com/rynfar/meridian/issues/353)

## [1.37.0](https://github.com/rynfar/meridian/compare/meridian-v1.36.0...meridian-v1.37.0) (2026-04-12)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/meridian/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/meridian/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))
* add favicon to telemetry dashboard ([#238](https://github.com/rynfar/meridian/issues/238)) ([52d2c09](https://github.com/rynfar/meridian/commit/52d2c0971a90e09c019c9a361f8407101493dad4))
* add ForgeCode agent adapter ([#315](https://github.com/rynfar/meridian/issues/315)) ([bb7d8e3](https://github.com/rynfar/meridian/commit/bb7d8e39db00542cda3b2c7b2ab41df302610a3c))
* add LiteLLM passthrough adapter ([#215](https://github.com/rynfar/meridian/issues/215)) ([beb5a5b](https://github.com/rynfar/meridian/commit/beb5a5bd0f7c38622d335b0711afb15ca93b8b4c))
* add live smoke tests + message validation ([#226](https://github.com/rynfar/meridian/issues/226)) ([8bc83fc](https://github.com/rynfar/meridian/commit/8bc83fc33c8ce0744884b78ba8b6c92f1484e7e3))
* add OpenAI-compatible /v1/chat/completions and /v1/models endpoints ([#234](https://github.com/rynfar/meridian/issues/234)) ([16a62b4](https://github.com/rynfar/meridian/commit/16a62b4f6a29f2dc8a1edc1590d401986fa51fe1))
* add optional API key authentication for network-exposed deployments ([19a1206](https://github.com/rynfar/meridian/commit/19a1206f1569630d3cc09f6145b4b2cff3065895))
* add pi coding agent adapter ([#259](https://github.com/rynfar/meridian/issues/259)) ([b20585f](https://github.com/rynfar/meridian/commit/b20585f8287a56fb62e54a1e4d4ccf2e7f35033b))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/meridian/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/meridian/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/meridian/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/meridian/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/meridian/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/meridian/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/meridian/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/meridian/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/meridian/issues/81)
* add version field to /health endpoint response ([#331](https://github.com/rynfar/meridian/issues/331)) ([382aee0](https://github.com/rynfar/meridian/commit/382aee0bd481bd0e56c781bf8d00be00368e980e))
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/meridian/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/meridian/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/meridian/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/meridian/issues/183)) ([7395b1f](https://github.com/rynfar/meridian/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))
* deferred tool loading with auto-defer for large tool sets ([#310](https://github.com/rynfar/meridian/issues/310)) ([f3c3230](https://github.com/rynfar/meridian/commit/f3c323029054496b6b5cb4e56c78c0ae4c61a62f)), closes [#303](https://github.com/rynfar/meridian/issues/303)
* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/meridian/issues/149)) ([1b56c0b](https://github.com/rynfar/meridian/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/meridian/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/meridian/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/meridian/issues/181)) ([b07d2d4](https://github.com/rynfar/meridian/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/meridian/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/meridian/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/meridian/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/meridian/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/meridian/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/meridian/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/meridian/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multi-profile support — switch Claude accounts without restarting ([#279](https://github.com/rynfar/meridian/issues/279)) ([7752413](https://github.com/rynfar/meridian/commit/7752413d5e9d3a81306893d50ff43f1c9d371318))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/meridian/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/meridian/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/meridian/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/meridian/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/meridian/issues/21)
* passthrough SDK params (effort, thinking, taskBudget, betas) + usage logging ([#222](https://github.com/rynfar/meridian/issues/222)) ([533323c](https://github.com/rynfar/meridian/commit/533323cb067708b132691ff3713e922dafced0d9))
* per-adapter SDK feature toggles with settings UI ([#349](https://github.com/rynfar/meridian/issues/349)) ([0cdedb3](https://github.com/rynfar/meridian/commit/0cdedb350c076f118b49cf92faf1f5a7eca2a258))
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/meridian/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/meridian/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/meridian/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/meridian/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/meridian/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/meridian/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/meridian/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session recovery logging and endpoint for conversation restoration ([#283](https://github.com/rynfar/meridian/issues/283)) ([781e302](https://github.com/rynfar/meridian/commit/781e302f3b99d8443ca2fff711c274d3a2c9c335))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/meridian/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* show client model version in telemetry ([f77095f](https://github.com/rynfar/meridian/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/meridian/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/meridian/issues/169)
* subagent model selection via x-opencode-agent-mode header ([#235](https://github.com/rynfar/meridian/issues/235)) ([bfcd7a9](https://github.com/rynfar/meridian/commit/bfcd7a97c306b2e5b4b42d0597d32d4486911397))
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/meridian/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))
* **telemetry:** add Prometheus exposition format renderer ([9c57c3a](https://github.com/rynfar/meridian/commit/9c57c3a18a035bf4aebcc19f25879e6bd3ab174b))
* **telemetry:** add Prometheus metrics renderer and /metrics endpoint ([49a88f9](https://github.com/rynfar/meridian/commit/49a88f935a232811e4834cc608965747e25db3d5))
* **telemetry:** add SQLite-backed telemetry and diagnostic stores ([4671946](https://github.com/rynfar/meridian/commit/4671946fae9ff8f0f99103f74dec2ef4b5ba5d85))
* **telemetry:** add SQLite-backed telemetry persistence ([9eed59f](https://github.com/rynfar/meridian/commit/9eed59f49949ed7d21bc124885e839381740ba8e))
* **telemetry:** mount GET /metrics Prometheus endpoint ([9d79503](https://github.com/rynfar/meridian/commit/9d79503d724ba40ef48a132eaaad78463c49fc79))
* **telemetry:** wire SQLite singleton with env-based fallback ([fb050d5](https://github.com/rynfar/meridian/commit/fb050d50ef133074e413ce65a2380fc3faf8c087))
* token telemetry, anomaly detection, passthrough default + thinking blocks ([#306](https://github.com/rynfar/meridian/issues/306)) ([44fcf14](https://github.com/rynfar/meridian/commit/44fcf143b838926a7bc2ce8371b6e04353cf141e))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/meridian/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/meridian/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/meridian/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/meridian/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))
* add missing hasDeferredTools to test helpers for typecheck ([c3c596c](https://github.com/rynfar/meridian/commit/c3c596c7d6e3dbd41289dbc5d09afe43b8b0b319))
* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/meridian/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add path parameter fallback in OpenCode file change tracking ([#253](https://github.com/rynfar/meridian/issues/253)) ([959a84e](https://github.com/rynfar/meridian/commit/959a84e9cfdb12a6bb47c752a468c6983fe20042))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/meridian/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/meridian/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/meridian/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/meridian/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* allow 3 turns in passthrough resume to prevent max-turns error ([#308](https://github.com/rynfar/meridian/issues/308)) ([af4d7e0](https://github.com/rynfar/meridian/commit/af4d7e055ba563ad3e19beb0e237f67574c33dae))
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/meridian/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* allow-list safe anthropic-beta headers on claude-max profiles ([#293](https://github.com/rynfar/meridian/issues/293)) ([f28f074](https://github.com/rynfar/meridian/commit/f28f074e24714e6b3912060eb0e9362aebf66947)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* auto-refresh expired OAuth token inline on 401 ([#230](https://github.com/rynfar/meridian/issues/230)) ([fd377a3](https://github.com/rynfar/meridian/commit/fd377a37257146b9bede11b07b64d10c5727fc9c))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/meridian/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/meridian/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/meridian/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/meridian/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/meridian/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/meridian/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/meridian/issues/145)) ([4a79701](https://github.com/rynfar/meridian/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))
* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/meridian/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/meridian/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* correct cache hit rate percentage in stderr usage log ([#320](https://github.com/rynfar/meridian/issues/320)) ([ea2aa8b](https://github.com/rynfar/meridian/commit/ea2aa8b3389138562564e70e1c3039f249afe5f4))
* correct ci.yml YAML (remove stray XML artifact) ([#251](https://github.com/rynfar/meridian/issues/251)) ([207d8a3](https://github.com/rynfar/meridian/commit/207d8a3ccc55dc53d15c885d805097bd4a273ea0))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/meridian/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/meridian/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/meridian/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/meridian/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/meridian/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/meridian/issues/69)
* default sonnet to 200k — sonnet[1m] requires Extra Usage on Max ([#255](https://github.com/rynfar/meridian/issues/255)) ([e629d6c](https://github.com/rynfar/meridian/commit/e629d6cbbdcf2716a7379c33c242b2d51d2eedd3))
* default to non-streaming (JSON) when stream field is omitted ([#241](https://github.com/rynfar/meridian/issues/241)) ([f9f4b6f](https://github.com/rynfar/meridian/commit/f9f4b6ff3a53a13a09b1cd341b39bf88be8e9fad))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/meridian/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/meridian/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/meridian/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/meridian/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/meridian/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/meridian/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* disable thinking at SDK level when strip-all removes thinking beta ([#313](https://github.com/rynfar/meridian/issues/313)) ([57b5cad](https://github.com/rynfar/meridian/commit/57b5cadd093e4224082c73de2059e6e4501e8d52))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/meridian/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/meridian/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* eliminate proxy-async-ops flaky test in CI ([4592dfd](https://github.com/rynfar/meridian/commit/4592dfda724799a7a21a4db34c8e0c529ced6717))
* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/meridian/issues/185)) ([8bd9b48](https://github.com/rynfar/meridian/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/meridian/issues/168)
* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/meridian/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/meridian/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/meridian/issues/124)
* enable thinking token passthrough for Pi adapter ([c58c04e](https://github.com/rynfar/meridian/commit/c58c04e24b7f2dc8ef6fa503e789a304f60ac9ab)), closes [#323](https://github.com/rynfar/meridian/issues/323)
* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/meridian/issues/142)) ([6888f32](https://github.com/rynfar/meridian/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/meridian/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/meridian/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/meridian/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/meridian/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/meridian/issues/123)
* fall back from sonnet[1m] to sonnet when extra usage not enabled ([#228](https://github.com/rynfar/meridian/issues/228)) ([7104d15](https://github.com/rynfar/meridian/commit/7104d156cbdcfb9eff16f949c29df3a26914fe20)), closes [#227](https://github.com/rynfar/meridian/issues/227)
* fall back to "unknown" when agent name is entirely non-ASCII ([442e84c](https://github.com/rynfar/meridian/commit/442e84c553fc3152f4e65af845340cdc8295c051))
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/meridian/commit/18a02805680c29c96dd53788601577c78c709b33))
* force executable to node in buildQueryOptions ([6e33926](https://github.com/rynfar/meridian/commit/6e33926d65d7cd3082d17f893654ae67f20504ce))
* forward accumulated usage on non-stream responses ([b5539d0](https://github.com/rynfar/meridian/commit/b5539d0798d86d2587b987448a56c1b595922cc6))
* forward accumulated usage on non-stream responses ([5270ea2](https://github.com/rynfar/meridian/commit/5270ea2b750b949b93eb28d2a489c9c0ab85fadb))
* handle all SDK stale session error variants ([4c19d48](https://github.com/rynfar/meridian/commit/4c19d488a42b430c104c01ee1308c4a54059c044)), closes [#333](https://github.com/rynfar/meridian/issues/333)
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/meridian/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/meridian/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/meridian/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/meridian/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/meridian/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/meridian/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* isolate auth status tests to prevent CI flakiness ([07d8331](https://github.com/rynfar/meridian/commit/07d83311f92445922f317f60736d78dd136494e2))
* isolate profile-switch-integration tests to prevent mock leakage ([c5e8740](https://github.com/rynfar/meridian/commit/c5e87409405a33bb75bde0534379cbee80cfdca1))
* isolate session recovery tests in CI sequential run ([2812576](https://github.com/rynfar/meridian/commit/28125762285dacc0fb4900438f3af975d9faa1bd))
* isolate session recovery tests in CI sequential run ([6c905ab](https://github.com/rynfar/meridian/commit/6c905ab7a23835ef67ffd222d481da09a079a0bd))
* isolate shared store context-usage test into its own file to prevent parallel contamination ([2a1fd66](https://github.com/rynfar/meridian/commit/2a1fd66ceab736def705545994807273ed7f2dc0))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/meridian/issues/154)) ([#158](https://github.com/rynfar/meridian/issues/158)) ([7c68ee6](https://github.com/rynfar/meridian/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/meridian/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/meridian/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/meridian/issues/70)
* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/meridian/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/meridian/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/meridian/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move clearSessionCache to afterEach in shared store test to avoid wiping store before lookup ([3fe65fb](https://github.com/rynfar/meridian/commit/3fe65fb40df71773ffc14ce02f91a7f234525d0f))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/meridian/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/meridian/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* narrow event type before translateAnthropicSseEvent to satisfy tsc ([8417623](https://github.com/rynfar/meridian/commit/8417623a7404915eb16103429b892d44bae4d310))
* npm publish with automation token ([230b185](https://github.com/rynfar/meridian/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/meridian/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/meridian/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/meridian/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/meridian/issues/49)
* OpenCode auto-detection, adapter telemetry, pi adapter improvements ([13bd6cd](https://github.com/rynfar/meridian/commit/13bd6cd792282fdd575e7fc92bf72fbe2ee547f9))
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/meridian/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/meridian/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/meridian/issues/125)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/meridian/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/meridian/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/meridian/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/meridian/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/meridian/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/meridian/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/meridian/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/meridian/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/meridian/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/meridian/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/meridian/issues/18)
* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))
* prefer system claude binary over cli.js when not running under bun ([#217](https://github.com/rynfar/meridian/issues/217)) ([88a3eff](https://github.com/rynfar/meridian/commit/88a3eff1bf6e978d3442e8738982425a8470c5d6))
* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/meridian/issues/141)) ([64b9a1d](https://github.com/rynfar/meridian/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/meridian/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/meridian/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/meridian/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/meridian/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* prevent false positives in file changes extraction from bash commands ([#236](https://github.com/rynfar/meridian/issues/236)) ([0464024](https://github.com/rynfar/meridian/commit/04640245945870126d1163acaeb4eb29acf52779))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/meridian/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/meridian/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/meridian/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/meridian/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/meridian/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/meridian/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/meridian/issues/156)) ([f0dd8dd](https://github.com/rynfar/meridian/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/meridian/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/meridian/commit/291e20f93f91dfe8942c84a38847926b20db7598))
* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/meridian/issues/153)) ([#159](https://github.com/rynfar/meridian/issues/159)) ([39f09ca](https://github.com/rynfar/meridian/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/meridian/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/meridian/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/meridian/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/meridian/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/meridian/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/meridian/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace global claude-code install with SDK cli.js shim in Dockerfile ([5391f14](https://github.com/rynfar/meridian/commit/5391f140bfb9262da2b387d841ffb0b5384627f7))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/meridian/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/meridian/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/meridian/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/meridian/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/meridian/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/meridian/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/meridian/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* respect client stream parameter in passthrough adapter ([#254](https://github.com/rynfar/meridian/issues/254)) ([1ec2abb](https://github.com/rynfar/meridian/commit/1ec2abbc0f6196fda79ba6ce631e5829e06d0b7e))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/meridian/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/meridian/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/meridian/issues/146)) ([67442c4](https://github.com/rynfar/meridian/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/meridian/issues/140)
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/meridian/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/meridian/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* run proxy-extra-usage-fallback in isolation to prevent mock leak ([287dd9a](https://github.com/rynfar/meridian/commit/287dd9a87676a642bcc3b87b8474a37dbb6cc5c3))
* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/meridian/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))
* sanitize agent name header to strip non-ASCII characters ([#326](https://github.com/rynfar/meridian/issues/326)) ([74bb8f3](https://github.com/rynfar/meridian/commit/74bb8f365a739c0a0951287a6ce6663d524a45a6))
* session store test race condition on CI ([90f927d](https://github.com/rynfar/meridian/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/meridian/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/meridian/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/meridian/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/meridian/issues/16)
* skip file locking in session store tests ([875e136](https://github.com/rynfar/meridian/commit/875e136091ff4521364429c13db2a25907777b4a))
* skip labeling in release-please to avoid stale PR node errors ([7212318](https://github.com/rynfar/meridian/commit/72123181228b71ad2cbc6694dfac3989597dac7c))
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/meridian/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/meridian/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/meridian/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* strip anthropic-beta headers for Max subscriptions to prevent extra usage billing ([#281](https://github.com/rynfar/meridian/issues/281)) ([9c673c0](https://github.com/rynfar/meridian/commit/9c673c066682b0f43048ff1d0b70ade99f34ddb1)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* strip orchestration wrapper tags before text prompt flattening ([#327](https://github.com/rynfar/meridian/issues/327)) ([ab98af1](https://github.com/rynfar/meridian/commit/ab98af138d82b0df0ae3cc0cbca6cf78b311b6c9)), closes [#167](https://github.com/rynfar/meridian/issues/167) [#317](https://github.com/rynfar/meridian/issues/317)
* strip thinking blocks and suppress Turn 2 prose in passthrough mode ([1a98fe0](https://github.com/rynfar/meridian/commit/1a98fe05975ef22e37d2266b7dd111881b8e6fb3))
* support running as root (Docker, Unraid, NAS) ([#256](https://github.com/rynfar/meridian/issues/256)) ([7dd0599](https://github.com/rynfar/meridian/commit/7dd0599e919295e467e7cab28d1716da5fb46dc1))
* surface MERIDIAN_SONNET_MODEL hint on 1m rate limit errors ([9d4611c](https://github.com/rynfar/meridian/commit/9d4611c6b7198241cad406aebaa91a7148738e78))
* **telemetry:** persist token health data in SQLite store ([88f02a5](https://github.com/rynfar/meridian/commit/88f02a54160cb29dfbb7e8af4fec5dd032e39f6f))
* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/meridian/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/meridian/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/meridian/issues/171)
* trigger npm publish with token ([c603363](https://github.com/rynfar/meridian/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/meridian/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/meridian/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))
* use dynamic import for sessionStore in test to share singleton with server ([548ecc1](https://github.com/rynfar/meridian/commit/548ecc1a9336ca02a1d86099c697e855a2393124))
* use envBool() for passthrough detection — Boolean('0') was truthy ([#261](https://github.com/rynfar/meridian/issues/261)) ([41d37da](https://github.com/rynfar/meridian/commit/41d37da234f5282020b2bc9915fef3ec453cff8d))
* use MERIDIAN_SESSION_DIR env var in shared store test for parallel-safe isolation ([43d1de6](https://github.com/rynfar/meridian/commit/43d1de6eb74802c5bebf34c3244e0ba998c48f36))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([85b5cd7](https://github.com/rynfar/meridian/commit/85b5cd7e9f6422a149b943918836b6a3baac60ff))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([1450cbd](https://github.com/rynfar/meridian/commit/1450cbd9f0513bd57b04df6d613d044af175ceaa))
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/meridian/issues/139)) ([7aee13c](https://github.com/rynfar/meridian/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))
* write promptYesNo prompt to stderr so it shows in terminal ([#301](https://github.com/rynfar/meridian/issues/301)) ([099a716](https://github.com/rynfar/meridian/commit/099a7160577108cc1cfedc6dcec8f94cf6eb0422))

## [1.36.0](https://github.com/rynfar/meridian/compare/meridian-v1.35.0...meridian-v1.36.0) (2026-04-12)


### Features

* add optional API key authentication for network-exposed deployments ([19a1206](https://github.com/rynfar/meridian/commit/19a1206f1569630d3cc09f6145b4b2cff3065895))
* per-adapter SDK feature toggles with settings UI ([#349](https://github.com/rynfar/meridian/issues/349)) ([0cdedb3](https://github.com/rynfar/meridian/commit/0cdedb350c076f118b49cf92faf1f5a7eca2a258))


### Bug Fixes

* forward accumulated usage on non-stream responses ([b5539d0](https://github.com/rynfar/meridian/commit/b5539d0798d86d2587b987448a56c1b595922cc6))
* forward accumulated usage on non-stream responses ([5270ea2](https://github.com/rynfar/meridian/commit/5270ea2b750b949b93eb28d2a489c9c0ab85fadb))
* handle all SDK stale session error variants ([4c19d48](https://github.com/rynfar/meridian/commit/4c19d488a42b430c104c01ee1308c4a54059c044)), closes [#333](https://github.com/rynfar/meridian/issues/333)

## [1.35.0](https://github.com/rynfar/meridian/compare/meridian-v1.34.1...meridian-v1.35.0) (2026-04-10)


### Features

* add version field to /health endpoint response ([#331](https://github.com/rynfar/meridian/issues/331)) ([382aee0](https://github.com/rynfar/meridian/commit/382aee0bd481bd0e56c781bf8d00be00368e980e))
* **telemetry:** add Prometheus exposition format renderer ([9c57c3a](https://github.com/rynfar/meridian/commit/9c57c3a18a035bf4aebcc19f25879e6bd3ab174b))
* **telemetry:** add Prometheus metrics renderer and /metrics endpoint ([49a88f9](https://github.com/rynfar/meridian/commit/49a88f935a232811e4834cc608965747e25db3d5))
* **telemetry:** add SQLite-backed telemetry and diagnostic stores ([4671946](https://github.com/rynfar/meridian/commit/4671946fae9ff8f0f99103f74dec2ef4b5ba5d85))
* **telemetry:** add SQLite-backed telemetry persistence ([9eed59f](https://github.com/rynfar/meridian/commit/9eed59f49949ed7d21bc124885e839381740ba8e))
* **telemetry:** mount GET /metrics Prometheus endpoint ([9d79503](https://github.com/rynfar/meridian/commit/9d79503d724ba40ef48a132eaaad78463c49fc79))
* **telemetry:** wire SQLite singleton with env-based fallback ([fb050d5](https://github.com/rynfar/meridian/commit/fb050d50ef133074e413ce65a2380fc3faf8c087))


### Bug Fixes

* **telemetry:** persist token health data in SQLite store ([88f02a5](https://github.com/rynfar/meridian/commit/88f02a54160cb29dfbb7e8af4fec5dd032e39f6f))

## [1.34.1](https://github.com/rynfar/meridian/compare/meridian-v1.34.0...meridian-v1.34.1) (2026-04-09)


### Bug Fixes

* enable thinking token passthrough for Pi adapter ([c58c04e](https://github.com/rynfar/meridian/commit/c58c04e24b7f2dc8ef6fa503e789a304f60ac9ab)), closes [#323](https://github.com/rynfar/meridian/issues/323)
* fall back to "unknown" when agent name is entirely non-ASCII ([442e84c](https://github.com/rynfar/meridian/commit/442e84c553fc3152f4e65af845340cdc8295c051))
* sanitize agent name header to strip non-ASCII characters ([#326](https://github.com/rynfar/meridian/issues/326)) ([74bb8f3](https://github.com/rynfar/meridian/commit/74bb8f365a739c0a0951287a6ce6663d524a45a6))
* strip orchestration wrapper tags before text prompt flattening ([#327](https://github.com/rynfar/meridian/issues/327)) ([ab98af1](https://github.com/rynfar/meridian/commit/ab98af138d82b0df0ae3cc0cbca6cf78b311b6c9)), closes [#167](https://github.com/rynfar/meridian/issues/167) [#317](https://github.com/rynfar/meridian/issues/317)

## [1.34.0](https://github.com/rynfar/meridian/compare/meridian-v1.33.0...meridian-v1.34.0) (2026-04-08)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/meridian/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/meridian/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))
* add favicon to telemetry dashboard ([#238](https://github.com/rynfar/meridian/issues/238)) ([52d2c09](https://github.com/rynfar/meridian/commit/52d2c0971a90e09c019c9a361f8407101493dad4))
* add ForgeCode agent adapter ([#315](https://github.com/rynfar/meridian/issues/315)) ([bb7d8e3](https://github.com/rynfar/meridian/commit/bb7d8e39db00542cda3b2c7b2ab41df302610a3c))
* add LiteLLM passthrough adapter ([#215](https://github.com/rynfar/meridian/issues/215)) ([beb5a5b](https://github.com/rynfar/meridian/commit/beb5a5bd0f7c38622d335b0711afb15ca93b8b4c))
* add live smoke tests + message validation ([#226](https://github.com/rynfar/meridian/issues/226)) ([8bc83fc](https://github.com/rynfar/meridian/commit/8bc83fc33c8ce0744884b78ba8b6c92f1484e7e3))
* add OpenAI-compatible /v1/chat/completions and /v1/models endpoints ([#234](https://github.com/rynfar/meridian/issues/234)) ([16a62b4](https://github.com/rynfar/meridian/commit/16a62b4f6a29f2dc8a1edc1590d401986fa51fe1))
* add pi coding agent adapter ([#259](https://github.com/rynfar/meridian/issues/259)) ([b20585f](https://github.com/rynfar/meridian/commit/b20585f8287a56fb62e54a1e4d4ccf2e7f35033b))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/meridian/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/meridian/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/meridian/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/meridian/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/meridian/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/meridian/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/meridian/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/meridian/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/meridian/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/meridian/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/meridian/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/meridian/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/meridian/issues/183)) ([7395b1f](https://github.com/rynfar/meridian/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))
* deferred tool loading with auto-defer for large tool sets ([#310](https://github.com/rynfar/meridian/issues/310)) ([f3c3230](https://github.com/rynfar/meridian/commit/f3c323029054496b6b5cb4e56c78c0ae4c61a62f)), closes [#303](https://github.com/rynfar/meridian/issues/303)
* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/meridian/issues/149)) ([1b56c0b](https://github.com/rynfar/meridian/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/meridian/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/meridian/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/meridian/issues/181)) ([b07d2d4](https://github.com/rynfar/meridian/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/meridian/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/meridian/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/meridian/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/meridian/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/meridian/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/meridian/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/meridian/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multi-profile support — switch Claude accounts without restarting ([#279](https://github.com/rynfar/meridian/issues/279)) ([7752413](https://github.com/rynfar/meridian/commit/7752413d5e9d3a81306893d50ff43f1c9d371318))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/meridian/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/meridian/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/meridian/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/meridian/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/meridian/issues/21)
* passthrough SDK params (effort, thinking, taskBudget, betas) + usage logging ([#222](https://github.com/rynfar/meridian/issues/222)) ([533323c](https://github.com/rynfar/meridian/commit/533323cb067708b132691ff3713e922dafced0d9))
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/meridian/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/meridian/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/meridian/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/meridian/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/meridian/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/meridian/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/meridian/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session recovery logging and endpoint for conversation restoration ([#283](https://github.com/rynfar/meridian/issues/283)) ([781e302](https://github.com/rynfar/meridian/commit/781e302f3b99d8443ca2fff711c274d3a2c9c335))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/meridian/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* show client model version in telemetry ([f77095f](https://github.com/rynfar/meridian/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/meridian/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/meridian/issues/169)
* subagent model selection via x-opencode-agent-mode header ([#235](https://github.com/rynfar/meridian/issues/235)) ([bfcd7a9](https://github.com/rynfar/meridian/commit/bfcd7a97c306b2e5b4b42d0597d32d4486911397))
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/meridian/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))
* token telemetry, anomaly detection, passthrough default + thinking blocks ([#306](https://github.com/rynfar/meridian/issues/306)) ([44fcf14](https://github.com/rynfar/meridian/commit/44fcf143b838926a7bc2ce8371b6e04353cf141e))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/meridian/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/meridian/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/meridian/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/meridian/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))
* add missing hasDeferredTools to test helpers for typecheck ([c3c596c](https://github.com/rynfar/meridian/commit/c3c596c7d6e3dbd41289dbc5d09afe43b8b0b319))
* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/meridian/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add path parameter fallback in OpenCode file change tracking ([#253](https://github.com/rynfar/meridian/issues/253)) ([959a84e](https://github.com/rynfar/meridian/commit/959a84e9cfdb12a6bb47c752a468c6983fe20042))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/meridian/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/meridian/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/meridian/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/meridian/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* allow 3 turns in passthrough resume to prevent max-turns error ([#308](https://github.com/rynfar/meridian/issues/308)) ([af4d7e0](https://github.com/rynfar/meridian/commit/af4d7e055ba563ad3e19beb0e237f67574c33dae))
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/meridian/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* allow-list safe anthropic-beta headers on claude-max profiles ([#293](https://github.com/rynfar/meridian/issues/293)) ([f28f074](https://github.com/rynfar/meridian/commit/f28f074e24714e6b3912060eb0e9362aebf66947)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* auto-refresh expired OAuth token inline on 401 ([#230](https://github.com/rynfar/meridian/issues/230)) ([fd377a3](https://github.com/rynfar/meridian/commit/fd377a37257146b9bede11b07b64d10c5727fc9c))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/meridian/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/meridian/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/meridian/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/meridian/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/meridian/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/meridian/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/meridian/issues/145)) ([4a79701](https://github.com/rynfar/meridian/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))
* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/meridian/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/meridian/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* correct cache hit rate percentage in stderr usage log ([#320](https://github.com/rynfar/meridian/issues/320)) ([ea2aa8b](https://github.com/rynfar/meridian/commit/ea2aa8b3389138562564e70e1c3039f249afe5f4))
* correct ci.yml YAML (remove stray XML artifact) ([#251](https://github.com/rynfar/meridian/issues/251)) ([207d8a3](https://github.com/rynfar/meridian/commit/207d8a3ccc55dc53d15c885d805097bd4a273ea0))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/meridian/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/meridian/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/meridian/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/meridian/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/meridian/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/meridian/issues/69)
* default sonnet to 200k — sonnet[1m] requires Extra Usage on Max ([#255](https://github.com/rynfar/meridian/issues/255)) ([e629d6c](https://github.com/rynfar/meridian/commit/e629d6cbbdcf2716a7379c33c242b2d51d2eedd3))
* default to non-streaming (JSON) when stream field is omitted ([#241](https://github.com/rynfar/meridian/issues/241)) ([f9f4b6f](https://github.com/rynfar/meridian/commit/f9f4b6ff3a53a13a09b1cd341b39bf88be8e9fad))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/meridian/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/meridian/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/meridian/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/meridian/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/meridian/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/meridian/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* disable thinking at SDK level when strip-all removes thinking beta ([#313](https://github.com/rynfar/meridian/issues/313)) ([57b5cad](https://github.com/rynfar/meridian/commit/57b5cadd093e4224082c73de2059e6e4501e8d52))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/meridian/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/meridian/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* eliminate proxy-async-ops flaky test in CI ([4592dfd](https://github.com/rynfar/meridian/commit/4592dfda724799a7a21a4db34c8e0c529ced6717))
* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/meridian/issues/185)) ([8bd9b48](https://github.com/rynfar/meridian/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/meridian/issues/168)
* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/meridian/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/meridian/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/meridian/issues/124)
* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/meridian/issues/142)) ([6888f32](https://github.com/rynfar/meridian/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/meridian/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/meridian/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/meridian/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/meridian/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/meridian/issues/123)
* fall back from sonnet[1m] to sonnet when extra usage not enabled ([#228](https://github.com/rynfar/meridian/issues/228)) ([7104d15](https://github.com/rynfar/meridian/commit/7104d156cbdcfb9eff16f949c29df3a26914fe20)), closes [#227](https://github.com/rynfar/meridian/issues/227)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/meridian/commit/18a02805680c29c96dd53788601577c78c709b33))
* force executable to node in buildQueryOptions ([6e33926](https://github.com/rynfar/meridian/commit/6e33926d65d7cd3082d17f893654ae67f20504ce))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/meridian/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/meridian/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/meridian/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/meridian/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/meridian/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/meridian/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* isolate auth status tests to prevent CI flakiness ([07d8331](https://github.com/rynfar/meridian/commit/07d83311f92445922f317f60736d78dd136494e2))
* isolate profile-switch-integration tests to prevent mock leakage ([c5e8740](https://github.com/rynfar/meridian/commit/c5e87409405a33bb75bde0534379cbee80cfdca1))
* isolate session recovery tests in CI sequential run ([2812576](https://github.com/rynfar/meridian/commit/28125762285dacc0fb4900438f3af975d9faa1bd))
* isolate session recovery tests in CI sequential run ([6c905ab](https://github.com/rynfar/meridian/commit/6c905ab7a23835ef67ffd222d481da09a079a0bd))
* isolate shared store context-usage test into its own file to prevent parallel contamination ([2a1fd66](https://github.com/rynfar/meridian/commit/2a1fd66ceab736def705545994807273ed7f2dc0))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/meridian/issues/154)) ([#158](https://github.com/rynfar/meridian/issues/158)) ([7c68ee6](https://github.com/rynfar/meridian/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/meridian/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/meridian/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/meridian/issues/70)
* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/meridian/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/meridian/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/meridian/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move clearSessionCache to afterEach in shared store test to avoid wiping store before lookup ([3fe65fb](https://github.com/rynfar/meridian/commit/3fe65fb40df71773ffc14ce02f91a7f234525d0f))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/meridian/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/meridian/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* narrow event type before translateAnthropicSseEvent to satisfy tsc ([8417623](https://github.com/rynfar/meridian/commit/8417623a7404915eb16103429b892d44bae4d310))
* npm publish with automation token ([230b185](https://github.com/rynfar/meridian/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/meridian/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/meridian/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/meridian/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/meridian/issues/49)
* OpenCode auto-detection, adapter telemetry, pi adapter improvements ([13bd6cd](https://github.com/rynfar/meridian/commit/13bd6cd792282fdd575e7fc92bf72fbe2ee547f9))
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/meridian/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/meridian/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/meridian/issues/125)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/meridian/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/meridian/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/meridian/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/meridian/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/meridian/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/meridian/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/meridian/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/meridian/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/meridian/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/meridian/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/meridian/issues/18)
* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))
* prefer system claude binary over cli.js when not running under bun ([#217](https://github.com/rynfar/meridian/issues/217)) ([88a3eff](https://github.com/rynfar/meridian/commit/88a3eff1bf6e978d3442e8738982425a8470c5d6))
* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/meridian/issues/141)) ([64b9a1d](https://github.com/rynfar/meridian/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/meridian/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/meridian/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/meridian/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/meridian/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* prevent false positives in file changes extraction from bash commands ([#236](https://github.com/rynfar/meridian/issues/236)) ([0464024](https://github.com/rynfar/meridian/commit/04640245945870126d1163acaeb4eb29acf52779))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/meridian/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/meridian/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/meridian/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/meridian/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/meridian/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/meridian/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/meridian/issues/156)) ([f0dd8dd](https://github.com/rynfar/meridian/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/meridian/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/meridian/commit/291e20f93f91dfe8942c84a38847926b20db7598))
* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/meridian/issues/153)) ([#159](https://github.com/rynfar/meridian/issues/159)) ([39f09ca](https://github.com/rynfar/meridian/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/meridian/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/meridian/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/meridian/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/meridian/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/meridian/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/meridian/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace global claude-code install with SDK cli.js shim in Dockerfile ([5391f14](https://github.com/rynfar/meridian/commit/5391f140bfb9262da2b387d841ffb0b5384627f7))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/meridian/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/meridian/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/meridian/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/meridian/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/meridian/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/meridian/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/meridian/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* respect client stream parameter in passthrough adapter ([#254](https://github.com/rynfar/meridian/issues/254)) ([1ec2abb](https://github.com/rynfar/meridian/commit/1ec2abbc0f6196fda79ba6ce631e5829e06d0b7e))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/meridian/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/meridian/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/meridian/issues/146)) ([67442c4](https://github.com/rynfar/meridian/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/meridian/issues/140)
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/meridian/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/meridian/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* run proxy-extra-usage-fallback in isolation to prevent mock leak ([287dd9a](https://github.com/rynfar/meridian/commit/287dd9a87676a642bcc3b87b8474a37dbb6cc5c3))
* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/meridian/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))
* session store test race condition on CI ([90f927d](https://github.com/rynfar/meridian/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/meridian/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/meridian/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/meridian/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/meridian/issues/16)
* skip file locking in session store tests ([875e136](https://github.com/rynfar/meridian/commit/875e136091ff4521364429c13db2a25907777b4a))
* skip labeling in release-please to avoid stale PR node errors ([7212318](https://github.com/rynfar/meridian/commit/72123181228b71ad2cbc6694dfac3989597dac7c))
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/meridian/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/meridian/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/meridian/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* strip anthropic-beta headers for Max subscriptions to prevent extra usage billing ([#281](https://github.com/rynfar/meridian/issues/281)) ([9c673c0](https://github.com/rynfar/meridian/commit/9c673c066682b0f43048ff1d0b70ade99f34ddb1)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* strip thinking blocks and suppress Turn 2 prose in passthrough mode ([1a98fe0](https://github.com/rynfar/meridian/commit/1a98fe05975ef22e37d2266b7dd111881b8e6fb3))
* support running as root (Docker, Unraid, NAS) ([#256](https://github.com/rynfar/meridian/issues/256)) ([7dd0599](https://github.com/rynfar/meridian/commit/7dd0599e919295e467e7cab28d1716da5fb46dc1))
* surface MERIDIAN_SONNET_MODEL hint on 1m rate limit errors ([9d4611c](https://github.com/rynfar/meridian/commit/9d4611c6b7198241cad406aebaa91a7148738e78))
* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/meridian/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/meridian/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/meridian/issues/171)
* trigger npm publish with token ([c603363](https://github.com/rynfar/meridian/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/meridian/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/meridian/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))
* use dynamic import for sessionStore in test to share singleton with server ([548ecc1](https://github.com/rynfar/meridian/commit/548ecc1a9336ca02a1d86099c697e855a2393124))
* use envBool() for passthrough detection — Boolean('0') was truthy ([#261](https://github.com/rynfar/meridian/issues/261)) ([41d37da](https://github.com/rynfar/meridian/commit/41d37da234f5282020b2bc9915fef3ec453cff8d))
* use MERIDIAN_SESSION_DIR env var in shared store test for parallel-safe isolation ([43d1de6](https://github.com/rynfar/meridian/commit/43d1de6eb74802c5bebf34c3244e0ba998c48f36))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([85b5cd7](https://github.com/rynfar/meridian/commit/85b5cd7e9f6422a149b943918836b6a3baac60ff))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([1450cbd](https://github.com/rynfar/meridian/commit/1450cbd9f0513bd57b04df6d613d044af175ceaa))
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/meridian/issues/139)) ([7aee13c](https://github.com/rynfar/meridian/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))
* write promptYesNo prompt to stderr so it shows in terminal ([#301](https://github.com/rynfar/meridian/issues/301)) ([099a716](https://github.com/rynfar/meridian/commit/099a7160577108cc1cfedc6dcec8f94cf6eb0422))

## [1.33.0](https://github.com/rynfar/meridian/compare/meridian-v1.32.0...meridian-v1.33.0) (2026-04-08)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/meridian/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/meridian/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))
* add favicon to telemetry dashboard ([#238](https://github.com/rynfar/meridian/issues/238)) ([52d2c09](https://github.com/rynfar/meridian/commit/52d2c0971a90e09c019c9a361f8407101493dad4))
* add ForgeCode agent adapter ([#315](https://github.com/rynfar/meridian/issues/315)) ([bb7d8e3](https://github.com/rynfar/meridian/commit/bb7d8e39db00542cda3b2c7b2ab41df302610a3c))
* add LiteLLM passthrough adapter ([#215](https://github.com/rynfar/meridian/issues/215)) ([beb5a5b](https://github.com/rynfar/meridian/commit/beb5a5bd0f7c38622d335b0711afb15ca93b8b4c))
* add live smoke tests + message validation ([#226](https://github.com/rynfar/meridian/issues/226)) ([8bc83fc](https://github.com/rynfar/meridian/commit/8bc83fc33c8ce0744884b78ba8b6c92f1484e7e3))
* add OpenAI-compatible /v1/chat/completions and /v1/models endpoints ([#234](https://github.com/rynfar/meridian/issues/234)) ([16a62b4](https://github.com/rynfar/meridian/commit/16a62b4f6a29f2dc8a1edc1590d401986fa51fe1))
* add pi coding agent adapter ([#259](https://github.com/rynfar/meridian/issues/259)) ([b20585f](https://github.com/rynfar/meridian/commit/b20585f8287a56fb62e54a1e4d4ccf2e7f35033b))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/meridian/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/meridian/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/meridian/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/meridian/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/meridian/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/meridian/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/meridian/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/meridian/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/meridian/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/meridian/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/meridian/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/meridian/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/meridian/issues/183)) ([7395b1f](https://github.com/rynfar/meridian/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))
* deferred tool loading with auto-defer for large tool sets ([#310](https://github.com/rynfar/meridian/issues/310)) ([f3c3230](https://github.com/rynfar/meridian/commit/f3c323029054496b6b5cb4e56c78c0ae4c61a62f)), closes [#303](https://github.com/rynfar/meridian/issues/303)
* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/meridian/issues/149)) ([1b56c0b](https://github.com/rynfar/meridian/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/meridian/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/meridian/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/meridian/issues/181)) ([b07d2d4](https://github.com/rynfar/meridian/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/meridian/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/meridian/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/meridian/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/meridian/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/meridian/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/meridian/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/meridian/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multi-profile support — switch Claude accounts without restarting ([#279](https://github.com/rynfar/meridian/issues/279)) ([7752413](https://github.com/rynfar/meridian/commit/7752413d5e9d3a81306893d50ff43f1c9d371318))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/meridian/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/meridian/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/meridian/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/meridian/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/meridian/issues/21)
* passthrough SDK params (effort, thinking, taskBudget, betas) + usage logging ([#222](https://github.com/rynfar/meridian/issues/222)) ([533323c](https://github.com/rynfar/meridian/commit/533323cb067708b132691ff3713e922dafced0d9))
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/meridian/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/meridian/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/meridian/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/meridian/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/meridian/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/meridian/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/meridian/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session recovery logging and endpoint for conversation restoration ([#283](https://github.com/rynfar/meridian/issues/283)) ([781e302](https://github.com/rynfar/meridian/commit/781e302f3b99d8443ca2fff711c274d3a2c9c335))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/meridian/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* show client model version in telemetry ([f77095f](https://github.com/rynfar/meridian/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/meridian/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/meridian/issues/169)
* subagent model selection via x-opencode-agent-mode header ([#235](https://github.com/rynfar/meridian/issues/235)) ([bfcd7a9](https://github.com/rynfar/meridian/commit/bfcd7a97c306b2e5b4b42d0597d32d4486911397))
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/meridian/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))
* token telemetry, anomaly detection, passthrough default + thinking blocks ([#306](https://github.com/rynfar/meridian/issues/306)) ([44fcf14](https://github.com/rynfar/meridian/commit/44fcf143b838926a7bc2ce8371b6e04353cf141e))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/meridian/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/meridian/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/meridian/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/meridian/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))
* add missing hasDeferredTools to test helpers for typecheck ([c3c596c](https://github.com/rynfar/meridian/commit/c3c596c7d6e3dbd41289dbc5d09afe43b8b0b319))
* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/meridian/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add path parameter fallback in OpenCode file change tracking ([#253](https://github.com/rynfar/meridian/issues/253)) ([959a84e](https://github.com/rynfar/meridian/commit/959a84e9cfdb12a6bb47c752a468c6983fe20042))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/meridian/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/meridian/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/meridian/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/meridian/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* allow 3 turns in passthrough resume to prevent max-turns error ([#308](https://github.com/rynfar/meridian/issues/308)) ([af4d7e0](https://github.com/rynfar/meridian/commit/af4d7e055ba563ad3e19beb0e237f67574c33dae))
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/meridian/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* allow-list safe anthropic-beta headers on claude-max profiles ([#293](https://github.com/rynfar/meridian/issues/293)) ([f28f074](https://github.com/rynfar/meridian/commit/f28f074e24714e6b3912060eb0e9362aebf66947)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* auto-refresh expired OAuth token inline on 401 ([#230](https://github.com/rynfar/meridian/issues/230)) ([fd377a3](https://github.com/rynfar/meridian/commit/fd377a37257146b9bede11b07b64d10c5727fc9c))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/meridian/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/meridian/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/meridian/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/meridian/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/meridian/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/meridian/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/meridian/issues/145)) ([4a79701](https://github.com/rynfar/meridian/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))
* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/meridian/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/meridian/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* correct cache hit rate percentage in stderr usage log ([#320](https://github.com/rynfar/meridian/issues/320)) ([ea2aa8b](https://github.com/rynfar/meridian/commit/ea2aa8b3389138562564e70e1c3039f249afe5f4))
* correct ci.yml YAML (remove stray XML artifact) ([#251](https://github.com/rynfar/meridian/issues/251)) ([207d8a3](https://github.com/rynfar/meridian/commit/207d8a3ccc55dc53d15c885d805097bd4a273ea0))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/meridian/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/meridian/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/meridian/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/meridian/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/meridian/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/meridian/issues/69)
* default sonnet to 200k — sonnet[1m] requires Extra Usage on Max ([#255](https://github.com/rynfar/meridian/issues/255)) ([e629d6c](https://github.com/rynfar/meridian/commit/e629d6cbbdcf2716a7379c33c242b2d51d2eedd3))
* default to non-streaming (JSON) when stream field is omitted ([#241](https://github.com/rynfar/meridian/issues/241)) ([f9f4b6f](https://github.com/rynfar/meridian/commit/f9f4b6ff3a53a13a09b1cd341b39bf88be8e9fad))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/meridian/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/meridian/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/meridian/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/meridian/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/meridian/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/meridian/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* disable thinking at SDK level when strip-all removes thinking beta ([#313](https://github.com/rynfar/meridian/issues/313)) ([57b5cad](https://github.com/rynfar/meridian/commit/57b5cadd093e4224082c73de2059e6e4501e8d52))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/meridian/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/meridian/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* eliminate proxy-async-ops flaky test in CI ([4592dfd](https://github.com/rynfar/meridian/commit/4592dfda724799a7a21a4db34c8e0c529ced6717))
* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/meridian/issues/185)) ([8bd9b48](https://github.com/rynfar/meridian/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/meridian/issues/168)
* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/meridian/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/meridian/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/meridian/issues/124)
* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/meridian/issues/142)) ([6888f32](https://github.com/rynfar/meridian/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/meridian/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/meridian/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/meridian/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/meridian/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/meridian/issues/123)
* fall back from sonnet[1m] to sonnet when extra usage not enabled ([#228](https://github.com/rynfar/meridian/issues/228)) ([7104d15](https://github.com/rynfar/meridian/commit/7104d156cbdcfb9eff16f949c29df3a26914fe20)), closes [#227](https://github.com/rynfar/meridian/issues/227)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/meridian/commit/18a02805680c29c96dd53788601577c78c709b33))
* force executable to node in buildQueryOptions ([6e33926](https://github.com/rynfar/meridian/commit/6e33926d65d7cd3082d17f893654ae67f20504ce))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/meridian/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/meridian/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/meridian/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/meridian/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/meridian/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/meridian/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* isolate auth status tests to prevent CI flakiness ([07d8331](https://github.com/rynfar/meridian/commit/07d83311f92445922f317f60736d78dd136494e2))
* isolate profile-switch-integration tests to prevent mock leakage ([c5e8740](https://github.com/rynfar/meridian/commit/c5e87409405a33bb75bde0534379cbee80cfdca1))
* isolate session recovery tests in CI sequential run ([2812576](https://github.com/rynfar/meridian/commit/28125762285dacc0fb4900438f3af975d9faa1bd))
* isolate session recovery tests in CI sequential run ([6c905ab](https://github.com/rynfar/meridian/commit/6c905ab7a23835ef67ffd222d481da09a079a0bd))
* isolate shared store context-usage test into its own file to prevent parallel contamination ([2a1fd66](https://github.com/rynfar/meridian/commit/2a1fd66ceab736def705545994807273ed7f2dc0))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/meridian/issues/154)) ([#158](https://github.com/rynfar/meridian/issues/158)) ([7c68ee6](https://github.com/rynfar/meridian/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/meridian/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/meridian/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/meridian/issues/70)
* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/meridian/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/meridian/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/meridian/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move clearSessionCache to afterEach in shared store test to avoid wiping store before lookup ([3fe65fb](https://github.com/rynfar/meridian/commit/3fe65fb40df71773ffc14ce02f91a7f234525d0f))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/meridian/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/meridian/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* narrow event type before translateAnthropicSseEvent to satisfy tsc ([8417623](https://github.com/rynfar/meridian/commit/8417623a7404915eb16103429b892d44bae4d310))
* npm publish with automation token ([230b185](https://github.com/rynfar/meridian/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/meridian/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/meridian/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/meridian/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/meridian/issues/49)
* OpenCode auto-detection, adapter telemetry, pi adapter improvements ([13bd6cd](https://github.com/rynfar/meridian/commit/13bd6cd792282fdd575e7fc92bf72fbe2ee547f9))
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/meridian/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/meridian/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/meridian/issues/125)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/meridian/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/meridian/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/meridian/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/meridian/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/meridian/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/meridian/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/meridian/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/meridian/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/meridian/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/meridian/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/meridian/issues/18)
* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))
* prefer system claude binary over cli.js when not running under bun ([#217](https://github.com/rynfar/meridian/issues/217)) ([88a3eff](https://github.com/rynfar/meridian/commit/88a3eff1bf6e978d3442e8738982425a8470c5d6))
* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/meridian/issues/141)) ([64b9a1d](https://github.com/rynfar/meridian/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/meridian/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/meridian/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/meridian/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/meridian/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* prevent false positives in file changes extraction from bash commands ([#236](https://github.com/rynfar/meridian/issues/236)) ([0464024](https://github.com/rynfar/meridian/commit/04640245945870126d1163acaeb4eb29acf52779))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/meridian/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/meridian/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/meridian/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/meridian/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/meridian/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/meridian/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/meridian/issues/156)) ([f0dd8dd](https://github.com/rynfar/meridian/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/meridian/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/meridian/commit/291e20f93f91dfe8942c84a38847926b20db7598))
* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/meridian/issues/153)) ([#159](https://github.com/rynfar/meridian/issues/159)) ([39f09ca](https://github.com/rynfar/meridian/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/meridian/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/meridian/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/meridian/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/meridian/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/meridian/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/meridian/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace global claude-code install with SDK cli.js shim in Dockerfile ([5391f14](https://github.com/rynfar/meridian/commit/5391f140bfb9262da2b387d841ffb0b5384627f7))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/meridian/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/meridian/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/meridian/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/meridian/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/meridian/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/meridian/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/meridian/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* respect client stream parameter in passthrough adapter ([#254](https://github.com/rynfar/meridian/issues/254)) ([1ec2abb](https://github.com/rynfar/meridian/commit/1ec2abbc0f6196fda79ba6ce631e5829e06d0b7e))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/meridian/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/meridian/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/meridian/issues/146)) ([67442c4](https://github.com/rynfar/meridian/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/meridian/issues/140)
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/meridian/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/meridian/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* run proxy-extra-usage-fallback in isolation to prevent mock leak ([287dd9a](https://github.com/rynfar/meridian/commit/287dd9a87676a642bcc3b87b8474a37dbb6cc5c3))
* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/meridian/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))
* session store test race condition on CI ([90f927d](https://github.com/rynfar/meridian/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/meridian/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/meridian/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/meridian/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/meridian/issues/16)
* skip file locking in session store tests ([875e136](https://github.com/rynfar/meridian/commit/875e136091ff4521364429c13db2a25907777b4a))
* skip labeling in release-please to avoid stale PR node errors ([7212318](https://github.com/rynfar/meridian/commit/72123181228b71ad2cbc6694dfac3989597dac7c))
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/meridian/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/meridian/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/meridian/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* strip anthropic-beta headers for Max subscriptions to prevent extra usage billing ([#281](https://github.com/rynfar/meridian/issues/281)) ([9c673c0](https://github.com/rynfar/meridian/commit/9c673c066682b0f43048ff1d0b70ade99f34ddb1)), closes [#278](https://github.com/rynfar/meridian/issues/278)
* strip thinking blocks and suppress Turn 2 prose in passthrough mode ([1a98fe0](https://github.com/rynfar/meridian/commit/1a98fe05975ef22e37d2266b7dd111881b8e6fb3))
* support running as root (Docker, Unraid, NAS) ([#256](https://github.com/rynfar/meridian/issues/256)) ([7dd0599](https://github.com/rynfar/meridian/commit/7dd0599e919295e467e7cab28d1716da5fb46dc1))
* surface MERIDIAN_SONNET_MODEL hint on 1m rate limit errors ([9d4611c](https://github.com/rynfar/meridian/commit/9d4611c6b7198241cad406aebaa91a7148738e78))
* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/meridian/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/meridian/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/meridian/issues/171)
* trigger npm publish with token ([c603363](https://github.com/rynfar/meridian/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/meridian/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/meridian/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))
* use dynamic import for sessionStore in test to share singleton with server ([548ecc1](https://github.com/rynfar/meridian/commit/548ecc1a9336ca02a1d86099c697e855a2393124))
* use envBool() for passthrough detection — Boolean('0') was truthy ([#261](https://github.com/rynfar/meridian/issues/261)) ([41d37da](https://github.com/rynfar/meridian/commit/41d37da234f5282020b2bc9915fef3ec453cff8d))
* use MERIDIAN_SESSION_DIR env var in shared store test for parallel-safe isolation ([43d1de6](https://github.com/rynfar/meridian/commit/43d1de6eb74802c5bebf34c3244e0ba998c48f36))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([85b5cd7](https://github.com/rynfar/meridian/commit/85b5cd7e9f6422a149b943918836b6a3baac60ff))
* use positional comparison in lineage overlap to prevent false compaction ([#283](https://github.com/rynfar/meridian/issues/283)) ([1450cbd](https://github.com/rynfar/meridian/commit/1450cbd9f0513bd57b04df6d613d044af175ceaa))
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/meridian/issues/139)) ([7aee13c](https://github.com/rynfar/meridian/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))
* write promptYesNo prompt to stderr so it shows in terminal ([#301](https://github.com/rynfar/meridian/issues/301)) ([099a716](https://github.com/rynfar/meridian/commit/099a7160577108cc1cfedc6dcec8f94cf6eb0422))

## [1.32.0](https://github.com/rynfar/meridian/compare/meridian-v1.31.2...meridian-v1.32.0) (2026-04-08)


### Features

* add ForgeCode agent adapter ([#315](https://github.com/rynfar/meridian/issues/315)) ([bb7d8e3](https://github.com/rynfar/meridian/commit/bb7d8e39db00542cda3b2c7b2ab41df302610a3c))


### Bug Fixes

* skip labeling in release-please to avoid stale PR node errors ([7212318](https://github.com/rynfar/meridian/commit/72123181228b71ad2cbc6694dfac3989597dac7c))

## [1.31.2](https://github.com/rynfar/meridian/compare/meridian-v1.31.1...meridian-v1.31.2) (2026-04-07)


### Bug Fixes

* disable thinking at SDK level when strip-all removes thinking beta ([#313](https://github.com/rynfar/meridian/issues/313)) ([57b5cad](https://github.com/rynfar/meridian/commit/57b5cadd093e4224082c73de2059e6e4501e8d52))

## [1.31.1](https://github.com/rynfar/meridian/compare/meridian-v1.31.0...meridian-v1.31.1) (2026-04-07)


### Bug Fixes

* add missing hasDeferredTools to test helpers for typecheck ([c3c596c](https://github.com/rynfar/meridian/commit/c3c596c7d6e3dbd41289dbc5d09afe43b8b0b319))

## [1.31.0](https://github.com/rynfar/meridian/compare/meridian-v1.30.1...meridian-v1.31.0) (2026-04-07)


### Features

* deferred tool loading with auto-defer for large tool sets ([#310](https://github.com/rynfar/meridian/issues/310)) ([f3c3230](https://github.com/rynfar/meridian/commit/f3c323029054496b6b5cb4e56c78c0ae4c61a62f)), closes [#303](https://github.com/rynfar/meridian/issues/303)

## [1.30.1](https://github.com/rynfar/meridian/compare/meridian-v1.30.0...meridian-v1.30.1) (2026-04-07)


### Bug Fixes

* allow 3 turns in passthrough resume to prevent max-turns error ([#308](https://github.com/rynfar/meridian/issues/308)) ([af4d7e0](https://github.com/rynfar/meridian/commit/af4d7e055ba563ad3e19beb0e237f67574c33dae))

## [1.30.0](https://github.com/rynfar/meridian/compare/meridian-v1.29.2...meridian-v1.30.0) (2026-04-07)


### Features

* token telemetry, anomaly detection, passthrough default + thinking blocks ([#306](https://github.com/rynfar/meridian/issues/306)) ([44fcf14](https://github.com/rynfar/meridian/commit/44fcf143b838926a7bc2ce8371b6e04353cf141e))

## [1.29.2](https://github.com/rynfar/meridian/compare/v1.29.1...v1.29.2) (2026-04-06)


### Bug Fixes

* allow-list safe anthropic-beta headers on claude-max profiles ([#293](https://github.com/rynfar/meridian/issues/293)) ([f28f074](https://github.com/rynfar/meridian/commit/f28f074e24714e6b3912060eb0e9362aebf66947)), closes [#278](https://github.com/rynfar/meridian/issues/278)

## [1.27.6](https://github.com/rynfar/meridian/compare/v1.27.5...v1.27.6) (2026-04-05)


### Bug Fixes

* support running as root (Docker, Unraid, NAS) ([#256](https://github.com/rynfar/meridian/issues/256)) ([7dd0599](https://github.com/rynfar/meridian/commit/7dd0599e919295e467e7cab28d1716da5fb46dc1))

## [1.27.5](https://github.com/rynfar/meridian/compare/v1.27.4...v1.27.5) (2026-04-05)


### Bug Fixes

* replace global claude-code install with SDK cli.js shim in Dockerfile ([5391f14](https://github.com/rynfar/meridian/commit/5391f140bfb9262da2b387d841ffb0b5384627f7))

## [1.27.4](https://github.com/rynfar/meridian/compare/v1.27.3...v1.27.4) (2026-04-05)


### Bug Fixes

* add path parameter fallback in OpenCode file change tracking ([#253](https://github.com/rynfar/meridian/issues/253)) ([959a84e](https://github.com/rynfar/meridian/commit/959a84e9cfdb12a6bb47c752a468c6983fe20042))

## [1.27.3](https://github.com/rynfar/meridian/compare/v1.27.2...v1.27.3) (2026-04-05)


### Bug Fixes

* use envBool() for passthrough detection — Boolean('0') was truthy ([#261](https://github.com/rynfar/meridian/issues/261)) ([41d37da](https://github.com/rynfar/meridian/commit/41d37da234f5282020b2bc9915fef3ec453cff8d))

## [1.27.2](https://github.com/rynfar/meridian/compare/v1.27.1...v1.27.2) (2026-04-05)


### Bug Fixes

* respect client stream parameter in passthrough adapter ([#254](https://github.com/rynfar/meridian/issues/254)) ([1ec2abb](https://github.com/rynfar/meridian/commit/1ec2abbc0f6196fda79ba6ce631e5829e06d0b7e))

## [1.27.1](https://github.com/rynfar/meridian/compare/v1.27.0...v1.27.1) (2026-04-05)


### Bug Fixes

* default sonnet to 200k — sonnet[1m] requires Extra Usage on Max ([#255](https://github.com/rynfar/meridian/issues/255)) ([e629d6c](https://github.com/rynfar/meridian/commit/e629d6cbbdcf2716a7379c33c242b2d51d2eedd3))
* OpenCode auto-detection, adapter telemetry, pi adapter improvements ([13bd6cd](https://github.com/rynfar/meridian/commit/13bd6cd792282fdd575e7fc92bf72fbe2ee547f9))
* strip thinking blocks and suppress Turn 2 prose in passthrough mode ([1a98fe0](https://github.com/rynfar/meridian/commit/1a98fe05975ef22e37d2266b7dd111881b8e6fb3))

## [1.27.0](https://github.com/rynfar/meridian/compare/v1.26.6...v1.27.0) (2026-04-04)


### Features

* add pi coding agent adapter ([#259](https://github.com/rynfar/meridian/issues/259)) ([b20585f](https://github.com/rynfar/meridian/commit/b20585f8287a56fb62e54a1e4d4ccf2e7f35033b))

## [1.26.6](https://github.com/rynfar/meridian/compare/v1.26.5...v1.26.6) (2026-04-03)


### Bug Fixes

* correct ci.yml YAML (remove stray XML artifact) ([#251](https://github.com/rynfar/meridian/issues/251)) ([207d8a3](https://github.com/rynfar/meridian/commit/207d8a3ccc55dc53d15c885d805097bd4a273ea0))
* force executable to node in buildQueryOptions ([6e33926](https://github.com/rynfar/meridian/commit/6e33926d65d7cd3082d17f893654ae67f20504ce))

## [1.26.5](https://github.com/rynfar/meridian/compare/v1.26.4...v1.26.5) (2026-04-03)


### Bug Fixes

* isolate shared store context-usage test into its own file to prevent parallel contamination ([2a1fd66](https://github.com/rynfar/meridian/commit/2a1fd66ceab736def705545994807273ed7f2dc0))

## [1.26.4](https://github.com/rynfar/meridian/compare/v1.26.3...v1.26.4) (2026-04-03)


### Bug Fixes

* use MERIDIAN_SESSION_DIR env var in shared store test for parallel-safe isolation ([43d1de6](https://github.com/rynfar/meridian/commit/43d1de6eb74802c5bebf34c3244e0ba998c48f36))

## [1.26.3](https://github.com/rynfar/meridian/compare/v1.26.2...v1.26.3) (2026-04-03)


### Bug Fixes

* move clearSessionCache to afterEach in shared store test to avoid wiping store before lookup ([3fe65fb](https://github.com/rynfar/meridian/commit/3fe65fb40df71773ffc14ce02f91a7f234525d0f))

## [1.26.2](https://github.com/rynfar/meridian/compare/v1.26.1...v1.26.2) (2026-04-03)


### Bug Fixes

* use dynamic import for sessionStore in test to share singleton with server ([548ecc1](https://github.com/rynfar/meridian/commit/548ecc1a9336ca02a1d86099c697e855a2393124))

## [1.26.1](https://github.com/rynfar/meridian/compare/v1.26.0...v1.26.1) (2026-04-03)


### Bug Fixes

* narrow event type before translateAnthropicSseEvent to satisfy tsc ([8417623](https://github.com/rynfar/meridian/commit/8417623a7404915eb16103429b892d44bae4d310))

## [1.26.0](https://github.com/rynfar/meridian/compare/v1.25.1...v1.26.0) (2026-04-03)


### Features

* add OpenAI-compatible /v1/chat/completions and /v1/models endpoints ([#234](https://github.com/rynfar/meridian/issues/234)) ([16a62b4](https://github.com/rynfar/meridian/commit/16a62b4f6a29f2dc8a1edc1590d401986fa51fe1))
* passthrough SDK params (effort, thinking, taskBudget, betas) + usage logging ([#222](https://github.com/rynfar/meridian/issues/222)) ([533323c](https://github.com/rynfar/meridian/commit/533323cb067708b132691ff3713e922dafced0d9))

## [1.25.1](https://github.com/rynfar/meridian/compare/v1.25.0...v1.25.1) (2026-04-03)


### Bug Fixes

* isolate auth status tests to prevent CI flakiness ([07d8331](https://github.com/rynfar/meridian/commit/07d83311f92445922f317f60736d78dd136494e2))

## [1.25.0](https://github.com/rynfar/meridian/compare/v1.24.5...v1.25.0) (2026-04-03)


### Features

* add favicon to telemetry dashboard ([#238](https://github.com/rynfar/meridian/issues/238)) ([52d2c09](https://github.com/rynfar/meridian/commit/52d2c0971a90e09c019c9a361f8407101493dad4))
* add live smoke tests + message validation ([#226](https://github.com/rynfar/meridian/issues/226)) ([8bc83fc](https://github.com/rynfar/meridian/commit/8bc83fc33c8ce0744884b78ba8b6c92f1484e7e3))
* subagent model selection via x-opencode-agent-mode header ([#235](https://github.com/rynfar/meridian/issues/235)) ([bfcd7a9](https://github.com/rynfar/meridian/commit/bfcd7a97c306b2e5b4b42d0597d32d4486911397))


### Bug Fixes

* default to non-streaming (JSON) when stream field is omitted ([#241](https://github.com/rynfar/meridian/issues/241)) ([f9f4b6f](https://github.com/rynfar/meridian/commit/f9f4b6ff3a53a13a09b1cd341b39bf88be8e9fad))
* prevent false positives in file changes extraction from bash commands ([#236](https://github.com/rynfar/meridian/issues/236)) ([0464024](https://github.com/rynfar/meridian/commit/04640245945870126d1163acaeb4eb29acf52779))

## [1.24.5](https://github.com/rynfar/meridian/compare/v1.24.4...v1.24.5) (2026-04-02)


### Bug Fixes

* run proxy-extra-usage-fallback in isolation to prevent mock leak ([287dd9a](https://github.com/rynfar/meridian/commit/287dd9a87676a642bcc3b87b8474a37dbb6cc5c3))

## [1.24.4](https://github.com/rynfar/meridian/compare/v1.24.3...v1.24.4) (2026-04-02)


### Bug Fixes

* eliminate proxy-async-ops flaky test in CI ([4592dfd](https://github.com/rynfar/meridian/commit/4592dfda724799a7a21a4db34c8e0c529ced6717))
* surface MERIDIAN_SONNET_MODEL hint on 1m rate limit errors ([9d4611c](https://github.com/rynfar/meridian/commit/9d4611c6b7198241cad406aebaa91a7148738e78))

## [1.24.3](https://github.com/rynfar/meridian/compare/v1.24.2...v1.24.3) (2026-04-02)


### Bug Fixes

* auto-refresh expired OAuth token inline on 401 ([#230](https://github.com/rynfar/meridian/issues/230)) ([fd377a3](https://github.com/rynfar/meridian/commit/fd377a37257146b9bede11b07b64d10c5727fc9c))

## [1.24.2](https://github.com/rynfar/meridian/compare/v1.24.1...v1.24.2) (2026-04-02)


### Bug Fixes

* fall back from sonnet[1m] to sonnet when extra usage not enabled ([#228](https://github.com/rynfar/meridian/issues/228)) ([7104d15](https://github.com/rynfar/meridian/commit/7104d156cbdcfb9eff16f949c29df3a26914fe20)), closes [#227](https://github.com/rynfar/meridian/issues/227)

## [1.24.1](https://github.com/rynfar/meridian/compare/v1.24.0...v1.24.1) (2026-04-01)


### Bug Fixes

* prefer system claude binary over cli.js when not running under bun ([#217](https://github.com/rynfar/meridian/issues/217)) ([88a3eff](https://github.com/rynfar/meridian/commit/88a3eff1bf6e978d3442e8738982425a8470c5d6))

## [1.24.0](https://github.com/rynfar/meridian/compare/v1.23.1...v1.24.0) (2026-04-01)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/meridian/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/meridian/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))
* add LiteLLM passthrough adapter ([#215](https://github.com/rynfar/meridian/issues/215)) ([beb5a5b](https://github.com/rynfar/meridian/commit/beb5a5bd0f7c38622d335b0711afb15ca93b8b4c))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/meridian/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/meridian/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/meridian/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/meridian/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/meridian/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/meridian/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/meridian/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/meridian/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/meridian/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/meridian/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/meridian/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/meridian/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/meridian/issues/183)) ([7395b1f](https://github.com/rynfar/meridian/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))
* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/meridian/issues/149)) ([1b56c0b](https://github.com/rynfar/meridian/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/meridian/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/meridian/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/meridian/issues/181)) ([b07d2d4](https://github.com/rynfar/meridian/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/meridian/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/meridian/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/meridian/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/meridian/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/meridian/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/meridian/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/meridian/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/meridian/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/meridian/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/meridian/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/meridian/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/meridian/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/meridian/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/meridian/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/meridian/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/meridian/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/meridian/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/meridian/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/meridian/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/meridian/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* show client model version in telemetry ([f77095f](https://github.com/rynfar/meridian/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/meridian/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/meridian/issues/169)
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/meridian/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/meridian/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/meridian/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/meridian/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/meridian/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))
* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/meridian/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/meridian/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/meridian/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/meridian/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/meridian/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/meridian/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/meridian/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/meridian/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/meridian/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/meridian/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/meridian/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/meridian/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/meridian/issues/145)) ([4a79701](https://github.com/rynfar/meridian/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))
* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/meridian/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/meridian/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/meridian/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/meridian/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/meridian/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/meridian/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/meridian/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/meridian/issues/69)
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/meridian/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/meridian/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/meridian/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/meridian/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/meridian/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/meridian/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/meridian/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/meridian/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/meridian/issues/15)
* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/meridian/issues/185)) ([8bd9b48](https://github.com/rynfar/meridian/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/meridian/issues/168)
* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/meridian/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/meridian/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/meridian/issues/124)
* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/meridian/issues/142)) ([6888f32](https://github.com/rynfar/meridian/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/meridian/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/meridian/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/meridian/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/meridian/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/meridian/issues/123)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/meridian/commit/18a02805680c29c96dd53788601577c78c709b33))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/meridian/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/meridian/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/meridian/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/meridian/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/meridian/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/meridian/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/meridian/issues/154)) ([#158](https://github.com/rynfar/meridian/issues/158)) ([7c68ee6](https://github.com/rynfar/meridian/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/meridian/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/meridian/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/meridian/issues/70)
* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/meridian/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/meridian/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/meridian/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/meridian/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/meridian/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/meridian/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/meridian/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/meridian/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/meridian/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/meridian/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/meridian/issues/49)
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/meridian/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/meridian/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/meridian/issues/125)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/meridian/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/meridian/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/meridian/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/meridian/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/meridian/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/meridian/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/meridian/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/meridian/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/meridian/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/meridian/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/meridian/issues/18)
* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))
* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/meridian/issues/141)) ([64b9a1d](https://github.com/rynfar/meridian/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/meridian/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/meridian/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/meridian/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/meridian/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/meridian/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/meridian/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/meridian/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/meridian/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/meridian/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/meridian/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/meridian/issues/156)) ([f0dd8dd](https://github.com/rynfar/meridian/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/meridian/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/meridian/commit/291e20f93f91dfe8942c84a38847926b20db7598))
* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/meridian/issues/153)) ([#159](https://github.com/rynfar/meridian/issues/159)) ([39f09ca](https://github.com/rynfar/meridian/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/meridian/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/meridian/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/meridian/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/meridian/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/meridian/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/meridian/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/meridian/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/meridian/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/meridian/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/meridian/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/meridian/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/meridian/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/meridian/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/meridian/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/meridian/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/meridian/issues/146)) ([67442c4](https://github.com/rynfar/meridian/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/meridian/issues/140)
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/meridian/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/meridian/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/meridian/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))
* session store test race condition on CI ([90f927d](https://github.com/rynfar/meridian/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/meridian/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/meridian/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/meridian/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/meridian/issues/16)
* skip file locking in session store tests ([875e136](https://github.com/rynfar/meridian/commit/875e136091ff4521364429c13db2a25907777b4a))
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/meridian/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/meridian/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/meridian/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/meridian/issues/111)
* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/meridian/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/meridian/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/meridian/issues/171)
* trigger npm publish with token ([c603363](https://github.com/rynfar/meridian/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/meridian/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/meridian/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/meridian/issues/139)) ([7aee13c](https://github.com/rynfar/meridian/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))

## [1.23.1](https://github.com/rynfar/meridian/compare/v1.23.0...v1.23.1) (2026-04-01)


### Bug Fixes

* capture subprocess stderr to surface real exit-code-1 failures ([#213](https://github.com/rynfar/meridian/issues/213)) ([40eeda7](https://github.com/rynfar/meridian/commit/40eeda7c0219213c29f72ce84b44a2676e7442b3))

## [1.23.0](https://github.com/rynfar/meridian/compare/v1.22.2...v1.23.0) (2026-04-01)


### Features

* add env var to disable file change summaries ([#209](https://github.com/rynfar/meridian/issues/209)) ([374293f](https://github.com/rynfar/meridian/commit/374293feab42d554cf7dd41df377ac9e1d6a2c50))

## [1.22.2](https://github.com/rynfar/meridian/compare/v1.22.1...v1.22.2) (2026-04-01)


### Bug Fixes

* passthrough mode tool_use broken for multi-turn and streaming ([#207](https://github.com/rynfar/meridian/issues/207)) ([ae2e941](https://github.com/rynfar/meridian/commit/ae2e941d0c47ad35b7dcd4b07c114aabb31be3a1))

## [1.22.1](https://github.com/rynfar/meridian/compare/v1.22.0...v1.22.1) (2026-03-30)


### Bug Fixes

* add --version and --help flags to CLI ([#196](https://github.com/rynfar/meridian/issues/196)) ([029d049](https://github.com/rynfar/meridian/commit/029d04936cead82fd845d048fcd3dfb2b286c181))

## [1.22.0](https://github.com/rynfar/meridian/compare/v1.21.1...v1.22.0) (2026-03-30)


### Features

* file change visibility in responses ([#189](https://github.com/rynfar/meridian/issues/189)) ([#192](https://github.com/rynfar/meridian/issues/192)) ([9112d4a](https://github.com/rynfar/meridian/commit/9112d4a01b55c13e0dcb2b6dba4c5ec713f2c65a))


### Bug Fixes

* reduce token overhead in passthrough mode ([#191](https://github.com/rynfar/meridian/issues/191)) ([98e8f9b](https://github.com/rynfar/meridian/commit/98e8f9b2689ad9cda4d1db511cb1fd38ee44e919))

## [1.21.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.21.0...v1.21.1) (2026-03-29)


### Bug Fixes

* emit message_delta and message_stop before error on mid-stream failures ([#185](https://github.com/rynfar/opencode-claude-max-proxy/issues/185)) ([8bd9b48](https://github.com/rynfar/opencode-claude-max-proxy/commit/8bd9b48a69016a75a512c68fc9e79bbc2b2a09cd)), closes [#168](https://github.com/rynfar/opencode-claude-max-proxy/issues/168)

## [1.21.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.20.0...v1.21.0) (2026-03-29)


### Features

* Crush (Charm) agent adapter with full E2E test suite ([#183](https://github.com/rynfar/opencode-claude-max-proxy/issues/183)) ([7395b1f](https://github.com/rynfar/opencode-claude-max-proxy/commit/7395b1fc91d67274c7dbf0ef695dd6ef51608e85))

## [1.20.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.4...v1.20.0) (2026-03-29)


### Features

* Droid (Factory AI) agent adapter ([#181](https://github.com/rynfar/opencode-claude-max-proxy/issues/181)) ([b07d2d4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b07d2d45a12b4e1a91ed49a6df2e040c2fd3fba0))

## [1.19.4](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.3...v1.19.4) (2026-03-29)


### Bug Fixes

* CI workflow must use npm test, not bun test ([1644484](https://github.com/rynfar/opencode-claude-max-proxy/commit/1644484b1990adc401a9e8b01d4cd4e41e5df193))

## [1.19.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.2...v1.19.3) (2026-03-29)


### Bug Fixes

* run session store tests sequentially to avoid shared module state ([bb4555c](https://github.com/rynfar/opencode-claude-max-proxy/commit/bb4555c40c4d61537ae41525af20fa149dc9de87))

## [1.19.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.1...v1.19.2) (2026-03-28)


### Bug Fixes

* migrate all session store tests to setSessionStoreDir ([fc8d72b](https://github.com/rynfar/opencode-claude-max-proxy/commit/fc8d72be677a8cb4fdcb734cb8ad5b83626ce5ea))

## [1.19.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.19.0...v1.19.1) (2026-03-28)


### Bug Fixes

* skip file locking in session store tests ([875e136](https://github.com/rynfar/opencode-claude-max-proxy/commit/875e136091ff4521364429c13db2a25907777b4a))

## [1.19.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.2...v1.19.0) (2026-03-27)


### Features

* show client model version in telemetry ([f77095f](https://github.com/rynfar/opencode-claude-max-proxy/commit/f77095ff8ca8901bd2370b2735772102854a565a))
* show client model version in telemetry ([f3b8aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/f3b8aa0bf5a53b44a137d0be2c5177a1dc8ab2ed)), closes [#169](https://github.com/rynfar/opencode-claude-max-proxy/issues/169)


### Bug Fixes

* treat identical message replay as diverged, not continuation ([c819b4e](https://github.com/rynfar/opencode-claude-max-proxy/commit/c819b4ec5bf2452f1eddb76ee99fd123caa52a1a))
* treat identical message replay as diverged, not continuation ([465eb19](https://github.com/rynfar/opencode-claude-max-proxy/commit/465eb194c41e0790947e735dfc5a291b34f7e494)), closes [#171](https://github.com/rynfar/opencode-claude-max-proxy/issues/171)

## [1.18.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.1...v1.18.2) (2026-03-26)


### Bug Fixes

* session store test race condition on CI ([90f927d](https://github.com/rynfar/opencode-claude-max-proxy/commit/90f927d8f0821ad7ed2548455fa96001d08510d6))

## [1.18.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.18.0...v1.18.1) (2026-03-26)


### Bug Fixes

* ensure Docker entrypoint scripts are executable ([#142](https://github.com/rynfar/opencode-claude-max-proxy/issues/142)) ([6888f32](https://github.com/rynfar/opencode-claude-max-proxy/commit/6888f32fa0a7355f702f44b101fe0629ae1a8201))
* make CLAUDE_PROXY_WORKDIR override extracted cwd ([#154](https://github.com/rynfar/opencode-claude-max-proxy/issues/154)) ([#158](https://github.com/rynfar/opencode-claude-max-proxy/issues/158)) ([7c68ee6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7c68ee64435a53c1e0fec3025e688f067f0089c0))
* rate-limit retry with backoff and auth status resilience ([#156](https://github.com/rynfar/opencode-claude-max-proxy/issues/156)) ([f0dd8dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/f0dd8ddc826bc8ea5218e42e9c3619775150001d))
* remap block indices across multi-turn streaming responses ([#153](https://github.com/rynfar/opencode-claude-max-proxy/issues/153)) ([#159](https://github.com/rynfar/opencode-claude-max-proxy/issues/159)) ([39f09ca](https://github.com/rynfar/opencode-claude-max-proxy/commit/39f09cacbbc272ebf23364400a4a60489b84a7d4))

## [1.18.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.2...v1.18.0) (2026-03-26)


### Features

* detect rate-limited accounts and fall back from 1m models ([#149](https://github.com/rynfar/opencode-claude-max-proxy/issues/149)) ([1b56c0b](https://github.com/rynfar/opencode-claude-max-proxy/commit/1b56c0b02b7de1f7ac6f04dc27f72a23949f43ab))

## [1.17.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.1...v1.17.2) (2026-03-25)


### Bug Fixes

* cache failed auth status lookups to avoid repeated exec calls ([#145](https://github.com/rynfar/opencode-claude-max-proxy/issues/145)) ([4a79701](https://github.com/rynfar/opencode-claude-max-proxy/commit/4a7970109586b7eb07907eb547c40bcb9c7867ca))
* retry as fresh session when undo hits stale UUID ([#146](https://github.com/rynfar/opencode-claude-max-proxy/issues/146)) ([67442c4](https://github.com/rynfar/opencode-claude-max-proxy/commit/67442c42442af1651306f92b9eb2fa003ac29b77)), closes [#140](https://github.com/rynfar/opencode-claude-max-proxy/issues/140)
* use subscription type to determine sonnet model variant ([#139](https://github.com/rynfar/opencode-claude-max-proxy/issues/139)) ([7aee13c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7aee13c6f2e766dab77924138c35ce5d96efa778))

## [1.17.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.17.0...v1.17.1) (2026-03-25)


### Bug Fixes

* prevent @hono/node-server from overriding global Response/Request ([#141](https://github.com/rynfar/opencode-claude-max-proxy/issues/141)) ([64b9a1d](https://github.com/rynfar/opencode-claude-max-proxy/commit/64b9a1d01034de1ffb60fe0ddfb57d4c1916056b))

## [1.17.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.2...v1.17.0) (2026-03-24)


### Features

* add diagnostic log viewer to telemetry dashboard ([d7ab690](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7ab690236f08e6f5c2cba9d043666a7efe8d33f))
* add tabbed layout to telemetry dashboard ([6800ea5](https://github.com/rynfar/opencode-claude-max-proxy/commit/6800ea56e6a09744f50e24ca12a0b40ae50c6abf))
* telemetry diagnostic log viewer with tabbed dashboard ([94f6c8b](https://github.com/rynfar/opencode-claude-max-proxy/commit/94f6c8bf30ddc31f384efe0c481168b6ddf305e9))


### Bug Fixes

* escape quotes in dashboard onclick handlers ([6728fc3](https://github.com/rynfar/opencode-claude-max-proxy/commit/6728fc31ea1679d653a89a7ea7622807cb95a0c1))

## [1.16.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.1...v1.16.2) (2026-03-24)


### Bug Fixes

* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([f1a7e7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/f1a7e7b6785a3d5b32d2e091e467d93b89862e39))
* redesign session management with per-message hashing, SDK-native undo, and compaction survival ([291e20f](https://github.com/rynfar/opencode-claude-max-proxy/commit/291e20f93f91dfe8942c84a38847926b20db7598))

## [1.16.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.16.0...v1.16.1) (2026-03-24)


### Bug Fixes

* enable 1M context window for Sonnet models ([0e3464a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e3464ab8f6f8acd2eff118f8bbd49f446d442c4))
* enable 1M context window for Sonnet models ([08dc8ff](https://github.com/rynfar/opencode-claude-max-proxy/commit/08dc8ff17624cacc54a5b6cecb072a118c7f46ea)), closes [#124](https://github.com/rynfar/opencode-claude-max-proxy/issues/124)
* extract client working directory from system prompt for remote proxy ([fbf8cfb](https://github.com/rynfar/opencode-claude-max-proxy/commit/fbf8cfb2a56e478490e823e3dceedadb4646b5ef))
* extract client working directory from system prompt for remote proxy ([10279ec](https://github.com/rynfar/opencode-claude-max-proxy/commit/10279ec044a04f0001bc2dc79d24eed07769f05e)), closes [#123](https://github.com/rynfar/opencode-claude-max-proxy/issues/123)
* optimize Docker layer ordering to cache dependencies ([dd4351a](https://github.com/rynfar/opencode-claude-max-proxy/commit/dd4351ad52f1a558ed143595a9fffa8ae8a449c9))
* optimize Docker layer ordering to cache dependencies ([8f29948](https://github.com/rynfar/opencode-claude-max-proxy/commit/8f2994844abc9413abfcd9faf96767d1eadad8f4)), closes [#125](https://github.com/rynfar/opencode-claude-max-proxy/issues/125)

## [1.16.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.3...v1.16.0) (2026-03-24)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/opencode-claude-max-proxy/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))
* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/opencode-claude-max-proxy/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/opencode-claude-max-proxy/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/opencode-claude-max-proxy/issues/104)
* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/opencode-claude-max-proxy/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/opencode-claude-max-proxy/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/opencode-claude-max-proxy/issues/81)
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* enable 1M context window for Opus models ([e23afba](https://github.com/rynfar/opencode-claude-max-proxy/commit/e23afba9e0936fe814bcd31e162512571e9805a6))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/opencode-claude-max-proxy/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/opencode-claude-max-proxy/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/opencode-claude-max-proxy/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/opencode-claude-max-proxy/commit/46be89aae0be674d94111b2b9bb597363ec25463))
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/opencode-claude-max-proxy/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/opencode-claude-max-proxy/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/opencode-claude-max-proxy/issues/69)
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/opencode-claude-max-proxy/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/opencode-claude-max-proxy/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/opencode-claude-max-proxy/issues/86)
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/opencode-claude-max-proxy/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/opencode-claude-max-proxy/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/opencode-claude-max-proxy/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/opencode-claude-max-proxy/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/opencode-claude-max-proxy/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/opencode-claude-max-proxy/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/opencode-claude-max-proxy/issues/70)
* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/opencode-claude-max-proxy/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/opencode-claude-max-proxy/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/opencode-claude-max-proxy/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/opencode-claude-max-proxy/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/opencode-claude-max-proxy/issues/49)
* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/opencode-claude-max-proxy/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/opencode-claude-max-proxy/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/opencode-claude-max-proxy/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/opencode-claude-max-proxy/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/opencode-claude-max-proxy/issues/74)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/opencode-claude-max-proxy/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/opencode-claude-max-proxy/commit/617530daa216daa916d72c5a612c8ee574ceff74))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)
* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/opencode-claude-max-proxy/commit/93ef05030825f2668e49063d5991e188af483f5f))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/opencode-claude-max-proxy/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/opencode-claude-max-proxy/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/opencode-claude-max-proxy/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/opencode-claude-max-proxy/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/opencode-claude-max-proxy/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))
* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/opencode-claude-max-proxy/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))
* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/opencode-claude-max-proxy/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))
* remove mock.module leak that breaks session store tests ([795fade](https://github.com/rynfar/opencode-claude-max-proxy/commit/795fadee02e18a55f0b7e661640167b485de571f))
* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/opencode-claude-max-proxy/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/opencode-claude-max-proxy/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/opencode-claude-max-proxy/issues/99)
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/opencode-claude-max-proxy/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/opencode-claude-max-proxy/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))
* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/opencode-claude-max-proxy/commit/7270b47451c0a6859ab815df1df0b1def4583842))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/opencode-claude-max-proxy/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/opencode-claude-max-proxy/commit/10c9a3c047978fe2e98d291254919bd992461218))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)
* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/opencode-claude-max-proxy/commit/1698713c0206716647e51392f056cb1aabb05f74))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/opencode-claude-max-proxy/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/opencode-claude-max-proxy/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)
* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update runCli test mock to match ProxyInstance shape ([29429f2](https://github.com/rynfar/opencode-claude-max-proxy/commit/29429f25d9d4481a50c0de0934c95996d3a6343d))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.15.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.2...v1.15.3) (2026-03-24)


### Bug Fixes

* add workingDirectory to fingerprint hash for cross-project isolation ([69cfa1a](https://github.com/rynfar/opencode-claude-max-proxy/commit/69cfa1af4f22229494bcc1c3f1cd13dcbe54280a)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)

## [1.15.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.1...v1.15.2) (2026-03-24)


### Bug Fixes

* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([3256aac](https://github.com/rynfar/opencode-claude-max-proxy/commit/3256aacd32528f1d82e4298306e12d31296a9ef3))
* stabilize fingerprint resume by removing volatile systemContext and normalizing content format ([be88868](https://github.com/rynfar/opencode-claude-max-proxy/commit/be88868a21da4239644af5c405de12f4f970ce5f)), closes [#111](https://github.com/rynfar/opencode-claude-max-proxy/issues/111)

## [1.15.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.15.0...v1.15.1) (2026-03-23)


### Bug Fixes

* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([54839b2](https://github.com/rynfar/opencode-claude-max-proxy/commit/54839b2b512e7172b0973de1596287505980fe74))
* block CLAUDE_CODE_ONLY_TOOLS in normal (non-passthrough) mode ([46be89a](https://github.com/rynfar/opencode-claude-max-proxy/commit/46be89aae0be674d94111b2b9bb597363ec25463))

## [1.15.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.14.0...v1.15.0) (2026-03-23)


### Features

* add proxyOverheadMs metric to telemetry ([5c573b1](https://github.com/rynfar/opencode-claude-max-proxy/commit/5c573b1b3c95a9a30e4cc77408ec08e47e4a2c24))
* add proxyOverheadMs metric to telemetry ([049063e](https://github.com/rynfar/opencode-claude-max-proxy/commit/049063ee9df27ca3a100e9eb9e3eeba367560eaa)), closes [#104](https://github.com/rynfar/opencode-claude-max-proxy/issues/104)


### Bug Fixes

* mock Date.now in pruning test to prevent CI failure ([5ca8653](https://github.com/rynfar/opencode-claude-max-proxy/commit/5ca8653a854960ef2998c3850d804e6a192ab10f))
* mock Date.now in pruning test to prevent flaky CI failure ([ea56c74](https://github.com/rynfar/opencode-claude-max-proxy/commit/ea56c74ebeaa6275daa43a5aba6892c5f78558f7))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b20dfee](https://github.com/rynfar/opencode-claude-max-proxy/commit/b20dfee5658738716fa329279a1f4f712aff8d90))
* prevent env var loop and MCP server transport reuse with SDK &gt;=0.2.81 ([b3f3ad6](https://github.com/rynfar/opencode-claude-max-proxy/commit/b3f3ad6b3bb7ccd7fa76746987c2ef944c780690))

## [1.14.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.6...v1.14.0) (2026-03-23)


### Features

* export TypeScript declarations from dist ([cd06761](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd06761b761b3196df2db47c12e32956c4f82e4c))


### Bug Fixes

* export TypeScript declaration files from distFix/types export ([3a50c93](https://github.com/rynfar/opencode-claude-max-proxy/commit/3a50c93ce55ccd40e9554f061ac0b852ec916df6))
* remove Hono type leak from public API and fix exports ([1764596](https://github.com/rynfar/opencode-claude-max-proxy/commit/17645967e0bfa993c118206b1cb672ac53cc77b0))

## [1.13.6](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.5...v1.13.6) (2026-03-23)


### Bug Fixes

* replace time-based session TTL with durable count-bounded storage ([121e82d](https://github.com/rynfar/opencode-claude-max-proxy/commit/121e82d95b6b84f3b6ad46d116cdc6ee8bdfe029))
* replace time-based session TTL with durable count-bounded storage ([71b2cc7](https://github.com/rynfar/opencode-claude-max-proxy/commit/71b2cc7661f407c827a43b5cc1f66885c7d25041)), closes [#99](https://github.com/rynfar/opencode-claude-max-proxy/issues/99)

## [1.13.5](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.4...v1.13.5) (2026-03-23)


### Bug Fixes

* remove duplicate cleanup timer and stop re-throwing in error event handler ([ae7404a](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae7404af675599de2ce4159bf82ed148b6104bb8))

## [1.13.4](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.3...v1.13.4) (2026-03-23)


### Bug Fixes

* pass systemContext to storeSession for consistent fingerprinting ([055b025](https://github.com/rynfar/opencode-claude-max-proxy/commit/055b02571c985c979c90deb491894b863fa9832d))
* pass systemContext to storeSession for consistent fingerprinting ([617530d](https://github.com/rynfar/opencode-claude-max-proxy/commit/617530daa216daa916d72c5a612c8ee574ceff74))

## [1.13.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.2...v1.13.3) (2026-03-23)


### Bug Fixes

* prevent cross-project session contamination in fingerprint cache ([93ef050](https://github.com/rynfar/opencode-claude-max-proxy/commit/93ef05030825f2668e49063d5991e188af483f5f))

## [1.13.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.1...v1.13.2) (2026-03-23)


### Bug Fixes

* remove mock.module leak that breaks session store tests ([576bbe2](https://github.com/rynfar/opencode-claude-max-proxy/commit/576bbe2326aa6f6b7bc53764029940218e1d8b17))

## [1.13.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.13.0...v1.13.1) (2026-03-23)


### Bug Fixes

* detect conversation divergence (undo/edit) via lineage hashing ([ced5819](https://github.com/rynfar/opencode-claude-max-proxy/commit/ced58192a0af583db2e01311f80d7db6ed8908e6))
* detect conversation divergence (undo/edit) via lineage hashing ([a09558a](https://github.com/rynfar/opencode-claude-max-proxy/commit/a09558a789ce7b133021f43c3ec3ec85f71014b5)), closes [#86](https://github.com/rynfar/opencode-claude-max-proxy/issues/86)

## [1.13.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.2...v1.13.0) (2026-03-22)


### Features

* add telemetry dashboard with request performance tracking ([def290f](https://github.com/rynfar/opencode-claude-max-proxy/commit/def290f975ed8c1229ecde13d9c1742142ce2e78))
* add telemetry dashboard with request performance tracking ([79c04a2](https://github.com/rynfar/opencode-claude-max-proxy/commit/79c04a2179690e857c1e8998d4ea1b432d7a3082)), closes [#81](https://github.com/rynfar/opencode-claude-max-proxy/issues/81)

## [1.12.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.1...v1.12.2) (2026-03-22)


### Bug Fixes

* pass OpenCode system prompt via SDK appendSystemPrompt ([1375a7e](https://github.com/rynfar/opencode-claude-max-proxy/commit/1375a7ed32740cca5e7fc25397e7ac5f79d9e8e8))
* pass OpenCode system prompt via SDK appendSystemPrompt ([9ff630c](https://github.com/rynfar/opencode-claude-max-proxy/commit/9ff630c0dca72525cc157652a4c2409c2e9d1e84)), closes [#74](https://github.com/rynfar/opencode-claude-max-proxy/issues/74)
* **proxy:** add LRU eviction to bound session cache growth ([661f007](https://github.com/rynfar/opencode-claude-max-proxy/commit/661f007300fd5ea1893a1147f3761021efd9318f))
* **proxy:** add LRU eviction to bound session cache growth ([93d7959](https://github.com/rynfar/opencode-claude-max-proxy/commit/93d7959ffbfce0d44312f3d1cc4325fabfdf028a))
* **proxy:** convert blocking execSync calls to async ([fb79545](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb795457649653375a5122d9e3deebb8d86251df))
* **proxy:** convert blocking execSync calls to async ([e59637f](https://github.com/rynfar/opencode-claude-max-proxy/commit/e59637f04728cafc5845a872c22bd7504723d9d5))
* **session-store:** add file locking and error logging ([b996a81](https://github.com/rynfar/opencode-claude-max-proxy/commit/b996a81a8b8e9cb4775b584358ae16baa6aae6e8))
* **session-store:** add file locking for concurrent access safety ([10c9a3c](https://github.com/rynfar/opencode-claude-max-proxy/commit/10c9a3c047978fe2e98d291254919bd992461218))

## [1.12.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.12.0...v1.12.1) (2026-03-21)


### Bug Fixes

* deduplicate tool_use blocks in streaming passthrough mode ([f8238b9](https://github.com/rynfar/opencode-claude-max-proxy/commit/f8238b9e45f47da9c6ca0eaa3b812199dde800f6))
* deduplicate tool_use blocks in streaming passthrough mode ([0007887](https://github.com/rynfar/opencode-claude-max-proxy/commit/000788786ed8a9d98a9ced2ad75ac36a8f6cc4d3)), closes [#69](https://github.com/rynfar/opencode-claude-max-proxy/issues/69)
* make tsconfig.json optional in Docker COPY to prevent build failure ([9526f54](https://github.com/rynfar/opencode-claude-max-proxy/commit/9526f54323ec6d8f2f603f9d9fd9d1e5dd227cee))
* make tsconfig.json optional in Docker COPY to prevent build failure ([fe61ebf](https://github.com/rynfar/opencode-claude-max-proxy/commit/fe61ebf3ec65eae8940a71b1d5bc2ca15fb3e860)), closes [#70](https://github.com/rynfar/opencode-claude-max-proxy/issues/70)

## [1.12.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.2...v1.12.0) (2026-03-21)


### Features

* add build pipeline for npm publishing, remove runtime Bun dependency ([4f62897](https://github.com/rynfar/opencode-claude-max-proxy/commit/4f6289729608dad3bcf9e89833bc59506fe89efa))


### Bug Fixes

* restore concurrency queue, idle timeout, and Docker crash recovery ([7270b47](https://github.com/rynfar/opencode-claude-max-proxy/commit/7270b47451c0a6859ab815df1df0b1def4583842))

## [1.11.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.1...v1.11.2) (2026-03-20)


### Bug Fixes

* optimize docker-compose with lightweight init and dedup config ([a737190](https://github.com/rynfar/opencode-claude-max-proxy/commit/a737190449d1e0feaa05c6b6d23c1affda05e08f))
* optimize Dockerfile with multi-stage build and node:22-slim runtime ([679ceef](https://github.com/rynfar/opencode-claude-max-proxy/commit/679ceefd2f7f74a596959d3b64a7d5cf4de06737))
* replace ubuntu base image with multi-stage node:22 build to fix Docker build failures ([1702a15](https://github.com/rynfar/opencode-claude-max-proxy/commit/1702a15ea5ff58149bc7cceb670cf37a6baae0c4))
* resolve UID mismatch between claude user and docker-compose init volume ([b8da7b4](https://github.com/rynfar/opencode-claude-max-proxy/commit/b8da7b4c1ad3b0fa2e38c30024aa44fbc87c761c))
* resolve UID mismatch between claude user and docker-compose init volume ([7e353ad](https://github.com/rynfar/opencode-claude-max-proxy/commit/7e353adf840f94fb27d9a59cd3659e5dbceb207d))

## [1.11.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.11.0...v1.11.1) (2026-03-20)


### Bug Fixes

* skip system context and assistant messages on resume ([1698713](https://github.com/rynfar/opencode-claude-max-proxy/commit/1698713c0206716647e51392f056cb1aabb05f74))

## [1.11.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.10.1...v1.11.0) (2026-03-20)


### Features

* multimodal content support (images, documents, files) ([0e6fc7a](https://github.com/rynfar/opencode-claude-max-proxy/commit/0e6fc7ac6ef894a86d05fcd665a992816ba86139))
* multimodal content support (images, documents, files) ([bc072cb](https://github.com/rynfar/opencode-claude-max-proxy/commit/bc072cbcbb18521328cc1e5309016f197d9d0040))


### Bug Fixes

* include mcpTools.ts in published package files ([10d8ee8](https://github.com/rynfar/opencode-claude-max-proxy/commit/10d8ee8441dada2fd454328161e4471de79e9776))
* include mcpTools.ts in published package files ([5039707](https://github.com/rynfar/opencode-claude-max-proxy/commit/50397077c86627a9a5103a0e69dd781cae5cd145))
* include src/plugin/ in published package files ([799e29e](https://github.com/rynfar/opencode-claude-max-proxy/commit/799e29e0c0ad9357518fecdb32f7a92715f2abac))

## [1.10.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.10.0...v1.10.1) (2026-03-20)


### Bug Fixes

* only send new messages on resume, not full history ([b1e101b](https://github.com/rynfar/opencode-claude-max-proxy/commit/b1e101b0dec5056fe1df18f23adebc4734c2230c))
* only send new messages on resume, not full history ([5dcbae3](https://github.com/rynfar/opencode-claude-max-proxy/commit/5dcbae3917070a4b5fe3db1fd480b96bfd6c883a)), closes [#49](https://github.com/rynfar/opencode-claude-max-proxy/issues/49)

## [1.10.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.9.0...v1.10.0) (2026-03-20)


### Features

* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))
* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))
* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))
* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))
* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))
* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)
* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.9.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.8.1...v1.9.0) (2026-03-20)


### Features

* per-terminal proxy launcher and shared session store ([836102c](https://github.com/rynfar/opencode-claude-max-proxy/commit/836102cb8d9b36acc88e3d4e19d753df0515020c))
* per-terminal proxy launcher and shared session store ([d2ace88](https://github.com/rynfar/opencode-claude-max-proxy/commit/d2ace88a927b225a148bc5e4239b779d3ddf6a78))

## [1.8.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.8.0...v1.8.1) (2026-03-20)


### Bug Fixes

* Docker auth persistence and non-root user ([afa18f7](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa18f7e9973d651e0f14f1e0623c51d9c8eb0ea))
* Docker auth persistence and non-root user ([c4f58a6](https://github.com/rynfar/opencode-claude-max-proxy/commit/c4f58a68d3630aed1af863df2bdc7fbf034d92eb)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)

## [1.8.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.3...v1.8.0) (2026-03-20)


### Features

* Docker support and README install options ([cfb8396](https://github.com/rynfar/opencode-claude-max-proxy/commit/cfb8396878ab7194ab5c8039e6a0c7abb68368a0))
* Docker support and README install options ([d61670e](https://github.com/rynfar/opencode-claude-max-proxy/commit/d61670eaa7ec2004743cf505ceffd359dc11166b)), closes [#15](https://github.com/rynfar/opencode-claude-max-proxy/issues/15)


### Bug Fixes

* pass system prompt via appendSystemPrompt instead of merging into prompt ([2b55399](https://github.com/rynfar/opencode-claude-max-proxy/commit/2b5539919de9d538e142b0d5b81f83ef9d513a90))

## [1.7.3](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.2...v1.7.3) (2026-03-20)


### Bug Fixes

* npm publish with automation token ([230b185](https://github.com/rynfar/opencode-claude-max-proxy/commit/230b185a4b75dff8826d1a63bffbc975502c7d4c))

## [1.7.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.1...v1.7.2) (2026-03-20)


### Bug Fixes

* trigger npm publish with token ([c603363](https://github.com/rynfar/opencode-claude-max-proxy/commit/c60336316102e440c22164eb5656a8142cea4cf0))

## [1.7.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.7.0...v1.7.1) (2026-03-20)


### Bug Fixes

* add NPM_TOKEN to publish workflow ([8339bb0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8339bb09d258f54df6dbd96df96192ec25f20b37))

## [1.7.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.6.1...v1.7.0) (2026-03-20)


### Features

* register OpenCode tools as MCP tools in passthrough mode ([e683539](https://github.com/rynfar/opencode-claude-max-proxy/commit/e6835398611374ca924d9e389d64c27ca5ce88c5))


### Bug Fixes

* block SDK tools with schema-incompatible OpenCode equivalents ([5bfd10f](https://github.com/rynfar/opencode-claude-max-proxy/commit/5bfd10f9b4b0900954b17c153846cf9f2f79b292))

## [1.6.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.6.0...v1.6.1) (2026-03-20)


### Bug Fixes

* block all Claude Code-only tools in passthrough mode ([92fbe7b](https://github.com/rynfar/opencode-claude-max-proxy/commit/92fbe7bd6ade265d70726c672ff9f4c119d42d3d)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* block Claude Code-only tools in passthrough mode ([c06d1ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/c06d1ea0ecbaaac984c129d3121185badcd1de7f)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)
* only block tools with no OpenCode equivalent ([cc73e9e](https://github.com/rynfar/opencode-claude-max-proxy/commit/cc73e9eac063ac22053e84c9244dc9c8de6a2a0e)), closes [#35](https://github.com/rynfar/opencode-claude-max-proxy/issues/35)

## [1.6.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.5.0...v1.6.0) (2026-03-20)


### Features

* true concurrent SDK sessions (no serialization) ([6dd5aa0](https://github.com/rynfar/opencode-claude-max-proxy/commit/6dd5aa02132bd94257a1b400bd78047bd5fc851b))


### Bug Fixes

* concurrent requests with auto-restart supervisor ([1a8f695](https://github.com/rynfar/opencode-claude-max-proxy/commit/1a8f6951437aeea6ea70c75c382c2d4c0bd582e5))
* revert to Bun.serve, document known concurrent crash ([ecbaec2](https://github.com/rynfar/opencode-claude-max-proxy/commit/ecbaec2b779ea8a0fa6b92f9f684a638ef98b128))

## [1.5.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.4.0...v1.5.0) (2026-03-20)


### Features

* clear error messages for auth failures and SDK crashes ([4e21e9a](https://github.com/rynfar/opencode-claude-max-proxy/commit/4e21e9a735a90620806253e6db410b36895708b4))
* concurrency control, auto-restart supervisor, error handling ([318ca75](https://github.com/rynfar/opencode-claude-max-proxy/commit/318ca751e3d1c6af1d7c29a86744da959b47e386))
* error classification, health endpoint, and startup auth check ([43a80f1](https://github.com/rynfar/opencode-claude-max-proxy/commit/43a80f1754499830e1e85adbd82eb65bb0212b42))
* passthrough mode for multi-model agent delegation ([4836a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/4836a48889a110050e5ffdbc6fabf4a547e30c95))
* passthrough mode for multi-model agent delegation ([a74ced9](https://github.com/rynfar/opencode-claude-max-proxy/commit/a74ced9350be19a9916c13a944540135d9c4eabb)), closes [#21](https://github.com/rynfar/opencode-claude-max-proxy/issues/21)
* validate passthrough architecture concept ([deed3db](https://github.com/rynfar/opencode-claude-max-proxy/commit/deed3dbf1b3bfc42f80a0983e6ea5094e09ae2d6))

## [1.4.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.3.0...v1.4.0) (2026-03-20)


### Features

* fuzzy match agent names for reliable subagent delegation ([fec9516](https://github.com/rynfar/opencode-claude-max-proxy/commit/fec9516b55341461c19129e94d3cc7d316876d71))
* fuzzy match agent names to fix invalid subagent_type values ([5364124](https://github.com/rynfar/opencode-claude-max-proxy/commit/53641241bee09f7aa11ba0da7c235cd68c54d190))
* PreToolUse hook for reliable subagent delegation ([01df852](https://github.com/rynfar/opencode-claude-max-proxy/commit/01df852ef0d1ffd0bb888f2d6c0e392933c52b5e))
* register SDK agent definitions from OpenCode's Task tool ([afa480f](https://github.com/rynfar/opencode-claude-max-proxy/commit/afa480f2c0d39c1c88fec721137615f93e1a9d13))
* use PreToolUse hook for agent name correction (replaces stream hacks) ([7cb37b6](https://github.com/rynfar/opencode-claude-max-proxy/commit/7cb37b66051b26058baf500da035ac600f51b8b9))

## [1.3.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.2.0...v1.3.0) (2026-03-20)


### Features

* add session resume support for conversation continuity ([c40ff63](https://github.com/rynfar/opencode-claude-max-proxy/commit/c40ff63149db52c68ebde816aaf13546cfd2d27f))
* session resume support for conversation continuity ([1e98be0](https://github.com/rynfar/opencode-claude-max-proxy/commit/1e98be0f8ffb9ff1c4d0d2c244c84a34b2504f32))


### Bug Fixes

* deduplicate message_start/stop events in multi-turn streaming ([23a0044](https://github.com/rynfar/opencode-claude-max-proxy/commit/23a0044bc4d06be97b002e83438b951c04d2251b)), closes [#20](https://github.com/rynfar/opencode-claude-max-proxy/issues/20)
* deduplicate streaming events for cleaner multi-turn responses ([b98b2dd](https://github.com/rynfar/opencode-claude-max-proxy/commit/b98b2dd130acc464845f718177217ce66ce53a2f))
* increase session TTL to 24 hours, verified end-to-end ([181a5fe](https://github.com/rynfar/opencode-claude-max-proxy/commit/181a5fe741507291fcad3bbb64b97076f45f2ba9))
* pass working directory to SDK for correct system prompt ([c0a3120](https://github.com/rynfar/opencode-claude-max-proxy/commit/c0a3120d3f5db54a429ca759017f5838ff94c33f))
* pass working directory to SDK query for correct system prompt ([d7bfc42](https://github.com/rynfar/opencode-claude-max-proxy/commit/d7bfc4267dcc70809ee341ed7fed576c21297c13)), closes [#18](https://github.com/rynfar/opencode-claude-max-proxy/issues/18)

## [1.2.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.1.1...v1.2.0) (2026-03-20)


### Features

* add request debug logging for tool loop visibility ([0051d60](https://github.com/rynfar/opencode-claude-max-proxy/commit/0051d601d923cd0775fcde88d488d399ba915e63))
* enable concurrent requests for subagent support (Phase 3) ([34452a3](https://github.com/rynfar/opencode-claude-max-proxy/commit/34452a332c91c047812b0073b576807d1c106dfd))
* forward tool_use blocks to clients (Phase 1) ([6042cd7](https://github.com/rynfar/opencode-claude-max-proxy/commit/6042cd70f79bb1a7c66ca0f5e091ee19dd28a256))
* remove internal MCP tools, use maxTurns: 1 (Phase 2) ([a740574](https://github.com/rynfar/opencode-claude-max-proxy/commit/a740574e1a91bb78fab8f7c717b3c16285ab0fb4))
* transparent API proxy with full tool execution and subagent support ([96be81c](https://github.com/rynfar/opencode-claude-max-proxy/commit/96be81cb0f2e0420ad84b0b762bd0acf9832191e))


### Bug Fixes

* block SDK built-in tools, enforce MCP-only tool execution ([ca1f8e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/ca1f8e163b6f00f047a709a2d9b4ea581be0d6a9))
* deny Task tool retries via canUseTool callback ([8b1a8b0](https://github.com/rynfar/opencode-claude-max-proxy/commit/8b1a8b0b4fb229b5e7743f8a839eba5ab6111f3b))
* deterministically normalize agent names in task tool_use blocks ([64133e1](https://github.com/rynfar/opencode-claude-max-proxy/commit/64133e1928836faf3d5347188183e540209ae8ca))
* filter MCP tool events from stream, forward only client-facing tools ([18a0280](https://github.com/rynfar/opencode-claude-max-proxy/commit/18a02805680c29c96dd53788601577c78c709b33))
* inject agent type hints to prevent capitalization errors ([172dca1](https://github.com/rynfar/opencode-claude-max-proxy/commit/172dca1b7180c25a484b53ab2d1b766dc2113c2f))
* restore MCP tools with bypassPermissions for correct tool execution ([d25e45d](https://github.com/rynfar/opencode-claude-max-proxy/commit/d25e45d0ce05018840db76d13401eda9ef70cfa9))

## [1.1.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.1.0...v1.1.1) (2026-03-20)


### Bug Fixes

* show friendly error message when port is already in use ([7b9d96a](https://github.com/rynfar/opencode-claude-max-proxy/commit/7b9d96a29cfc54ee7e9c288a4a0fa759bc51ed40)), closes [#16](https://github.com/rynfar/opencode-claude-max-proxy/issues/16)

## [1.1.0](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.2...v1.1.0) (2026-03-19)


### Features

* restore MCP tool federation for multi-turn agent sessions ([099a830](https://github.com/rynfar/opencode-claude-max-proxy/commit/099a830ca7f48d060db4acd923cebee68a3e7fd0))


### Bug Fixes

* allow configuring MCP tool working directory via env var ([b4d7d74](https://github.com/rynfar/opencode-claude-max-proxy/commit/b4d7d740658fe70602b4db8d62c15af5ecb34b28))
* disable all tools in Claude Code sessions ([7fab74c](https://github.com/rynfar/opencode-claude-max-proxy/commit/7fab74ca05e95124d6ea75bc95314cbcea51d118))
* include system prompt context in proxy requests ([948b8fb](https://github.com/rynfar/opencode-claude-max-proxy/commit/948b8fb64c6a3d6d8e7434d668334eaee78258fa))
* prevent empty/failed streaming responses in OpenCode proxy ([da170e7](https://github.com/rynfar/opencode-claude-max-proxy/commit/da170e7f1931340d9587a68c1fc1c24b6a5a52e8))
* queue concurrent streaming requests to avoid ~60s delay ([fb30a48](https://github.com/rynfar/opencode-claude-max-proxy/commit/fb30a489abccb917a30c09d85c908f90a30143ee))
* queue concurrent streaming requests to avoid ~60s delay ([054dd2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/054dd2cc6499b51c032ccbe7a08937dbe49e51ff))
* resolve Claude executable path and enable true SSE streaming ([d95bacb](https://github.com/rynfar/opencode-claude-max-proxy/commit/d95bacbc0b2a60f78e11086d9979ff1374383b78))
* run MCP tools in the caller project directory ([25767ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/25767ea8a6979dfed41e378caaac4e0dec04ac55))
* update SDK and fix streaming to filter tool_use blocks ([ae4d7ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/ae4d7ea4614f5f0774d505385b6248dbcbc65bc5))

## [1.0.2](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.1...v1.0.2) (2026-01-26)


### Bug Fixes

* remove bun install from publish job ([966b2ea](https://github.com/rynfar/opencode-claude-max-proxy/commit/966b2ea8a06f4dc12dd4f0f19be94b3539b83dfd))
* remove bun install from publish job ([cd36411](https://github.com/rynfar/opencode-claude-max-proxy/commit/cd36411193af22e779638232427dd8c49f8926e0))

## [1.0.1](https://github.com/rynfar/opencode-claude-max-proxy/compare/v1.0.0...v1.0.1) (2026-01-26)


### Bug Fixes

* move npm publish into release-please workflow ([82db07c](https://github.com/rynfar/opencode-claude-max-proxy/commit/82db07c07bf87bfc69ae08cc8f24c007408ad3ed))
* move npm publish into release-please workflow ([f7c4b2c](https://github.com/rynfar/opencode-claude-max-proxy/commit/f7c4b2c08a6993d20239e63b9fb668017577ab32))

## 1.0.0 (2026-01-26)


### Features

* Claude Max proxy for OpenCode ([b9df612](https://github.com/rynfar/opencode-claude-max-proxy/commit/b9df6121564b90b3dbbf821f981d67851d7a4e1e))


### Bug Fixes

* add SSE heartbeat to prevent connection resets ([194fd51](https://github.com/rynfar/opencode-claude-max-proxy/commit/194fd51e2fdf375cbac06fbfcf634800adab5d72))
* add SSE heartbeat to prevent connection resets ([ec7120d](https://github.com/rynfar/opencode-claude-max-proxy/commit/ec7120d22eef490e146530e5d66c1d90b055d0b5)), closes [#1](https://github.com/rynfar/opencode-claude-max-proxy/issues/1)
