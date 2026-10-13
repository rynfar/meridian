<p align="center">
  <img src="assets/banner.svg" alt="Meridian — Claude and Antigravity, in your tools." width="920" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#try-antigravity">Try Antigravity</a> ·
  <a href="#desktop">Desktop</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="https://discord.gg/jP2a2Z92NZ">Discord</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rynfar/meridian"><img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square&color=58a6ff" alt="npm version" /></a>
  <a href="docs/antigravity.md"><img src="https://img.shields.io/badge/Antigravity-preview-bc8cff?style=flat-square" alt="Antigravity: preview" /></a>
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-58a6ff?style=flat-square" alt="MIT license" /></a>
</p>

Meridian connects coding clients to **Claude and Antigravity using your subscription**.
Run Pi, OpenCode or another supported client against a local API, and manage
providers, requests and usage from a browser or the optional Mac app.

Claude requests run through Anthropic’s Agent SDK. Antigravity requests run
through Google’s official, signed-in `agy` CLI. Account permissions, model
availability and subscription limits still apply.

| <img src="assets/providers/claude.png" width="40" alt="Claude logo" /><br>Claude | <img src="assets/providers/antigravity.png" width="40" alt="Antigravity logo" /><br>Antigravity |
| :--- | :--- |
| **Released** · Claude Agent SDK | **Preview · v1.74.0+** · Official `agy` CLI |
| Persistent sessions, prompt caching and multiple account profiles | Streaming, client tools, conversation reuse and saved-answer recovery |
| [Client compatibility and setup](docs/agents.md) | [Pi and OpenCode setup](docs/antigravity.md) |
| Headless macOS, Linux and Windows | Authenticated acceptance on macOS arm64; Linux/Windows verification unfinished |

## Quick start

For the released **Claude** backend, install [Node.js 22+](https://nodejs.org/), then:

```sh
npm install -g @rynfar/meridian
claude login
meridian
```

Open `http://127.0.0.1:3456`. For OpenCode V1, run `meridian setup` and restart
OpenCode. For Pi and other clients, follow the [client setup guide](docs/agents.md).
See [configuration](docs/configuration.md) for API-key protection and Windows
setup, or [deployment](docs/deployment.md) for Docker and Nix.

## Try Antigravity

**Antigravity is included in Meridian 1.74.0 and later as a preview.**
The verified setup uses **agy 1.2.7**, **Pi 0.72.1** or **OpenCode V1 1.18.31**,
and macOS on Apple Silicon. Other versions need their own verification.

Install Node.js 22+ and the
[official Antigravity CLI](https://antigravity.google/). Run `agy` to sign in with
your subscription account and disable paid overage credits in its settings.
Then install Meridian:

```sh
npm install -g @rynfar/meridian@1.74.0

MERIDIAN_BACKEND=antigravity \
MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1 \
MERIDIAN_AGY_STATE_PATH="$HOME/.local/state/meridian/antigravity.sqlite" \
MERIDIAN_PORT=3457 \
meridian
```

Open `http://127.0.0.1:3457/providers` and use **Connect Pi / OpenCode**, or follow
the [CLI setup instructions](docs/antigravity.md#configure-installed-clients).
For a source build, follow the [development guide](docs/development.md).
The tool bridge lets the client execute tools with its own permissions. The
SQLite path enables saved state across service restarts; it does not guarantee
recovery of an unfinished action.

### What works

- **The coding loop:** incremental text, client tools, parallel tool batches,
  approvals, questions, cancellation and client-owned plugins/delegation.
- **Model and output selection:** available model/effort variants, forced tools
  and validated structured output.
- **Client APIs:** Anthropic Messages, OpenAI Chat Completions and a documented
  Responses subset.
- **Attachments:** images and public HTTPS image URLs; documents, speech and
  video through local conversion. These are not native media APIs.
- **Continuity:** warm conversation reuse, eligible completed-session restoration,
  history replay and bounded recovery of saved answers and tool IDs.
- **Provider management:** web and macOS setup, separate quota/status displays,
  shared navigation and activity. Native browser/subagent access requires
  separate explicit grants.

### What is unfinished

Active-task reattachment and automatic reconciliation of uncertain tool outcomes
are unfinished. Some provider-specific plugins, hosted-tool/file contracts and
client versions need adapters and acceptance tests. Authenticated Linux/Windows
verification is also outstanding.

The CLI does not expose exact output-token caps, numeric thinking budgets,
sampling controls or every native media/reasoning feature. Meridian cannot add
those guarantees through a wrapper. Upstream CLI failures can still interrupt a
turn. The [support and recovery checklist](docs/antigravity-support.md) records
what is missing, available workarounds and what would close each gap.

## Desktop

<p align="center">
  <img src="assets/desktop-dashboard.jpg" alt="Meridian Desktop showing usage limits, cache activity and recent requests. Sample data." width="1000" />
</p>
<p align="center"><sub>macOS dashboard preview · Sample data</sub></p>

The optional Mac app manages the local service, versions, plugins and diagnostics.
Use **Providers** to navigate Claude and Antigravity; their accounts and quota
windows stay separate. Request history helps track failures and activity across
the service.

The desktop preview targets **macOS on Apple Silicon**. Download the signed,
notarized DMG or ZIP from [GitHub Releases](https://github.com/rynfar/meridian/releases/tag/meridian-v1.74.0),
or follow the [source instructions](apps/desktop/README.md#run-locally). To try Antigravity, connect the app to a Meridian 1.74.0+ service configured as shown above.
Older Meridian versions do not include Antigravity.

Headless use remains supported. The npm package does not install Electron;
Docker, Nix and existing service managers can run the same server.

## How it works

<p align="center">
  <img src="assets/how-it-works.svg" alt="Pi, OpenCode and other supported clients connect to Meridian. Claude uses the Agent SDK; Antigravity uses the official agy CLI. Each provider uses its own signed-in account." width="920" />
</p>

Meridian translates supported client requests at the provider boundary. It keeps
Claude-specific account routing and cache behavior separate from Antigravity’s
CLI sessions and permissions. Antigravity generation stays on the signed-in CLI;
there is no Google API-key or model-SDK fallback.

## Documentation

| Guide | Contents |
| --- | --- |
| [Antigravity setup](docs/antigravity.md) | Models, client tools, attachments, permissions and setup |
| [Antigravity support & recovery](docs/antigravity-support.md) | Feature status, unfinished work and recovery limits |
| [Claude client setup](docs/agents.md) | Compatibility matrix and client configuration |
| [Desktop](apps/desktop/README.md) | Local preview, service ownership and platform status |
| [Configuration](docs/configuration.md) | CLI, environment variables and API-key protection |
| [Accounts & profiles](docs/profiles.md) | Claude sign-in, multiple accounts and routing |
| [Deployment](docs/deployment.md) | Docker, Nix and headless services |
| [Plugins](docs/plugins.md) | Official packages and plugin configuration |
| [Monitoring](MONITORING.md) | Usage, request diagnostics and prompt caching |
| [Development](docs/development.md) | Build, test and programmatic API |
| [Live verification](E2E.md) | Tested versions, flows and known failures |

## Contributing

[Report an issue](https://github.com/rynfar/meridian/issues), open a PR or join
[Discord](https://discord.gg/jP2a2Z92NZ). Read [AGENTS.md](AGENTS.md),
[ARCHITECTURE.md](ARCHITECTURE.md) and [E2E.md](E2E.md) before changing behavior.
For Antigravity reports, include your OS, `agy` and client versions, the failing
flow and redacted diagnostics.

Accepted PRs are merged as your own PR with you as the commit author; fixes we
need are pushed to your branch. Signing your commits lets us merge without
touching them. Earlier PRs that were not handled this way are listed in the
[attribution ledger](docs/maintenance/ATTRIBUTION_LEDGER.md).

Meridian is [MIT licensed](https://opensource.org/license/mit). Claude and Antigravity are trademarks of
their respective owners. [Provider asset credits](assets/providers/README.md).
