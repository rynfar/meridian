<p align="center">
  <img src="assets/banner.svg" alt="Meridian — Harness Claude, your way." width="800" />
</p>

<p align="center">
  <strong>Your tools. Your sessions. One place to see what’s happening.</strong>
</p>

<p align="center">
  <a href="https://github.com/rynfar/meridian/releases">Releases</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="docs/agents.md">Connect your agent</a> ·
  <a href="https://discord.gg/jP2a2Z92NZ">Discord</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rynfar/meridian"><img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square&color=58a6ff" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/desktop-macOS_preview-bc8cff?style=flat-square" alt="Desktop: macOS preview" />
  <img src="https://img.shields.io/badge/headless-macOS_·_Linux_·_Windows-58a6ff?style=flat-square" alt="Headless: macOS, Linux and Windows" />
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-bc8cff?style=flat-square" alt="MIT license" /></a>
</p>

Meridian connects Anthropic- and OpenAI-compatible clients to Claude through the
Claude Agent SDK. Keep the editor or terminal you like, with streaming, persistent
sessions, account routing and visibility into usage and prompt caching.

**Now with an optional Mac app.** Manage Meridian versions, install plugins, find
failed requests and see your usage limits without keeping a terminal open.
Headless Meridian remains fully supported—npm, Docker, Nix and your existing
service manager all remain valid ways to run it.

## Meet Meridian Desktop

<p align="center">
  <img src="assets/desktop-dashboard.jpg" alt="Meridian Desktop overview showing usage limits, cache activity and recent requests. Sample data." width="1000" />
</p>

<p align="center"><sub>macOS dashboard preview · Sample data</sub></p>

| See what matters | Keep it under control |
| --- | --- |
| **Usage & limits** — account quota windows, reset times and token activity. | **Versions** — install published Meridian releases, switch versions and roll back. |
| **Requests & cache** — timing, failures, cache history and request details. | **Service** — start, stop, restart and recover an app-managed installation. |
| **Logs & alerts** — searchable diagnostics and opt-in failure, cache and quota notifications. | **Plugins** — install and update the Pi, OpenCode, Hermes and OpenClaw scrub plugins. |

Native macOS chrome, menu bar controls and Liquid Glass on supported Macs through
[electron-liquid-glass](https://github.com/Meridius-Labs/electron-liquid-glass).
The desktop preview targets **macOS on Apple Silicon**. Linux and Windows desktop
apps are planned; their runtime support is not ready yet.

## Get started

### With the Mac app

The first downloadable desktop release is being prepared. Until it is published,
use the [desktop preview instructions](apps/desktop/README.md#run-locally).
Signed, notarized `.dmg` and `.zip` downloads will appear under
[GitHub Releases](https://github.com/rynfar/meridian/releases).

1. Connect to an existing local Meridian service, or install Meridian from **Versions**.
2. For a new installation, choose app management in **Service** and start it.
3. Sign in to a Claude account, then follow your [agent’s setup guide](docs/agents.md).

The app can monitor Docker or Nix installations through a published local HTTP
port. Their package manager retains control of updates and lifecycle. Supported
macOS LaunchAgents can be handed to the app and returned to headless operation.
[How service ownership works →](apps/desktop/README.md#connect-to-an-existing-installation)

### Headless, as always

Requires Node.js 22 or newer and a Claude account configured for the SDK.

```sh
npm install -g @rynfar/meridian
claude login
meridian
```

Meridian listens at `http://127.0.0.1:3456`. For OpenCode V1, run
`meridian setup` once and restart OpenCode. Other clients—including OpenCode V2—have
[specific setup instructions](docs/agents.md).

```sh
# Example for a POSIX shell, with Meridian API-key protection disabled:
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

`x` is a client-required placeholder. If you configure Meridian’s API-key
protection, use that key instead. Claude authentication comes from the configured
Claude account. See [configuration](docs/configuration.md) for authentication,
ports and Windows setup, or [deployment](docs/deployment.md) for Docker and Nix.

**No desktop dependency.** Installing the headless package does not install
Electron. You can run Meridian entirely without the app, including its browser
[telemetry dashboard](MONITORING.md).

## Built for ongoing work

- **Keep conversations going.** Sessions resume across requests and proxy restarts,
  with handling for client compaction, undo and branching.
- **Use the protocol your client speaks.** Anthropic Messages, OpenAI Chat
  Completions and Responses endpoints, including streaming and tool forwarding.
- **Keep accounts organized.** Multiple Claude profiles, explicit account selection
  and opt-in sticky session routing.
- **Understand cache behavior.** Request history, prompt-cache metrics, diagnostic
  events and optional persistent telemetry. API-equivalent cost estimates are
  estimates, not your subscription bill.
- **Keep your deployment.** CLI, containers, declarative Nix services or the
  optional desktop manager share the same Meridian server.

<p align="center">
  <img src="assets/how-it-works.svg" alt="Your client connects to Meridian, which sends requests through the Claude Agent SDK." width="920" />
</p>

Meridian uses the SDK’s authentication and request execution. Account access,
model availability and usage limits still depend on your provider account.

## Bring your agent

Setup guides cover **OpenCode, Pi, Claude Code, Codex CLI, Cline, Aider, Crush,
ForgeCode, Droid, Open WebUI, Cherry Studio, Polytoken, Jcode and Prime Agent**.
Compatibility varies by client and version; see the
[tested-agent matrix](docs/agents.md#compatibility-at-a-glance) for evidence and
limitations. Prime Agent concurrent subagents remain unsuitable for unattended
or usage-sensitive work. Continue is unverified.

The desktop **Plugins** page installs the four official scrub plugins. Client
connection setup is still separate; installing a scrub plugin does not configure
its corresponding client. [Plugin guide →](docs/plugins.md)

## Documentation

| Start here | What you’ll find |
| --- | --- |
| [Desktop guide](apps/desktop/README.md) | Setup, service ownership, updates, plugins and platform status |
| [Agent setup](docs/agents.md) | Client configuration and compatibility notes |
| [Configuration](docs/configuration.md) | CLI, environment variables, endpoints and API-key protection |
| [Antigravity & providers](docs/antigravity.md) | Subscription-account CLI backend, tools, images and structured output |
| [Accounts & profiles](docs/profiles.md) | Sign-in, multiple accounts and session routing |
| [Deployment](docs/deployment.md) | Docker, Nix and headless services |
| [Plugins](docs/plugins.md) | Official packages and plugin configuration |
| [Monitoring](MONITORING.md) | Usage, request diagnostics and prompt caching |
| [Development](docs/development.md) | Build, test and programmatic API |
| [Desktop releases](docs/desktop-releases.md) | Signing, notarization and download publication |

## Contribute

[Report a bug or suggest a feature](https://github.com/rynfar/meridian/issues),
open a PR, or join [Discord](https://discord.gg/jP2a2Z92NZ).
Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[E2E.md](E2E.md) before changing behavior. Meridian is [MIT licensed](https://opensource.org/license/mit).
