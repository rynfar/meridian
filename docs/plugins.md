# Plugins

[← Back to README](../README.md)

Extend Meridian's behavior with composable plugins — no core modifications needed.

**Quick start:** Drop a compiled `.js` file in `~/.config/meridian/plugins/` and restart.

```js
// ~/.config/meridian/plugins/my-plugin.js
export default {
  name: "my-plugin",
  onRequest(ctx) {
    // modify request context
    return { ...ctx, systemContext: (ctx.systemContext || "") + "\nBe concise." }
  },
}
```

- **Manage plugins** at `http://localhost:3456/plugins`
- **Reload without restart:** `POST /plugins/reload`
- **Full guide:** See [PLUGINS.md](../PLUGINS.md)

## Install from the Mac app

In [Meridian Desktop](../apps/desktop/README.md), open **Plugins**, check for
updates, then choose **Install** or **Update**. Pi, OpenCode, Hermes and OpenClaw
packages are available in the catalog. The app preserves unrelated plugin
configuration and reloads its owned service; a stopped service loads them on
its next start. Local headless installations using the same configuration retain
those plugins after a handoff. Docker and Nix installations manage their own
packages. Client connection setup is separate from installing a scrub plugin.

For TypeScript authoring and runtime requirements, see the [authoring guide](../PLUGINS.md).

### Official plugins

Content-scoped scrubbers maintained alongside Meridian. Core stays a clean
proxy — anything that rewrites client prompt content ships as one of these
opt-in plugins instead:

| Plugin | What it does |
|--------|--------------|
| [`@rynfar/meridian-plugin-hermes-scrub`](https://github.com/rynfar/meridian-plugin-hermes-scrub) | Strips Hermes Agent's `# Finishing the job` harness block from the system prompt. Fixes empty-stream responses when proxying Hermes, and avoids its coding-harness fingerprint. |
| [`@rynfar/meridian-plugin-pi-scrub`](https://github.com/rynfar/meridian-plugin-pi-scrub) | Strips Pi's coding-agent-harness prompt line from the system prompt. |
| [`@rynfar/meridian-plugin-opencode-scrub`](https://github.com/rynfar/meridian-plugin-opencode-scrub) | Strips OpenCode harness boilerplate from the system prompt before it reaches Claude. |
| [`@rynfar/meridian-plugin-openclaw-scrub`](https://github.com/rynfar/meridian-plugin-openclaw-scrub) | Removes OpenClaw prompt fingerprints, output directives and stale heartbeat replay. |

**Nix users:** the flake packages hermes-scrub, pi-scrub and opencode-scrub prebuilt — `pkgs.meridianPlugins.<name>` via the `meridian` overlay (or `meridian.legacyPackages.${system}.meridianPlugins`), each exposing `.path` for a `plugins.json` entry or the home-manager `pluginConfig` option. Each follows its plugin's release tags, and a scheduled `nix-update` workflow bumps them, rebuilding every plugin before opening a PR. openclaw-scrub is not in the flake yet — add it as `nix/pkgs/meridianPlugins/openclaw-scrub/package.nix`, following the other plugins.

Everyone else: install into Meridian's config dir and register the built file in
`~/.config/meridian/plugins.json`:

```bash
mkdir -p ~/.config/meridian
cd ~/.config/meridian
npm install @rynfar/meridian-plugin-hermes-scrub
```

```json
{
  "plugins": [
    { "path": "/Users/you/.config/meridian/node_modules/@rynfar/meridian-plugin-hermes-scrub/dist/index.js", "enabled": true }
  ]
}
```

Use absolute paths for npm packages. Bare filenames are resolved in the plugin discovery directory; the loader does not expand `~`.

Both plugin locations live in Meridian's config directory, so an instance started with its own `MERIDIAN_CONFIG_DIR` reads its own `plugins/` and `plugins.json`. For the standalone CLI, `MERIDIAN_PLUGIN_DIR` overrides the auto-discovery directory and `MERIDIAN_PLUGIN_CONFIG` the manifest path (useful for Nix or containers).

The metering and failure observations behind these scrubbers are historical and account-specific. A prompt rewrite cannot guarantee subscription eligibility or avoid a genuine quota limit.

### Docker

Set `MERIDIAN_PLUGINS` to a comma-separated list of npm package specs (`name` or `name@version`) and the container installs and registers them on startup — no custom image build required:

```yaml
services:
  proxy:
    build: .
    environment:
      MERIDIAN_PLUGINS: "@rynfar/meridian-plugin-pi-scrub,@rynfar/meridian-plugin-opencode-scrub"
```

The entrypoint runs `npm install` into `~/.config/meridian` inside the container and writes the resulting entries to `plugins.json` (or `MERIDIAN_PLUGIN_CONFIG` if set). This runs on every container start. The supplied Compose file does not persist that config directory, so installs survive restarts of the same container but are lost when it is recreated unless you add a volume. If you want plugins baked into a reproducible image instead, install them in a custom `Dockerfile` layer at build time rather than via this env var.
