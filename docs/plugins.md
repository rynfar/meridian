# Plugins

[← Back to README](../README.md)

Extend Meridian's behavior with composable plugins — no core modifications needed.

**Quick start:** Drop a `.ts` or `.js` file in `~/.config/meridian/plugins/` and restart.

```ts
// ~/.config/meridian/plugins/my-plugin.ts
export default {
  name: "my-plugin",
  onRequest(ctx) {
    // modify request context
    return { ...ctx, systemContext: ctx.systemContext + "\nBe concise." }
  },
}
```

- **Manage plugins** at `http://localhost:3456/plugins`
- **Reload without restart:** `POST /plugins/reload`
- **Full guide:** See [PLUGINS.md](../PLUGINS.md)

### Official plugins

Content-scoped scrubbers maintained alongside Meridian. Core stays a clean
proxy — anything that rewrites client prompt content ships as one of these
opt-in plugins instead:

| Plugin | What it does |
|--------|--------------|
| [`@rynfar/meridian-plugin-hermes-scrub`](https://github.com/rynfar/meridian-plugin-hermes-scrub) | Strips Hermes Agent's `# Finishing the job` harness block from the system prompt. Fixes empty-stream responses when proxying Hermes, and avoids its coding-harness fingerprint. |
| [`@rynfar/meridian-plugin-pi-scrub`](https://github.com/rynfar/meridian-plugin-pi-scrub) | Strips Pi's coding-agent-harness prompt line that Anthropic meters as Extra Usage. |
| [`@rynfar/meridian-plugin-opencode-scrub`](https://github.com/rynfar/meridian-plugin-opencode-scrub) | Strips OpenCode harness boilerplate from the system prompt before it reaches Claude. |

**Nix users:** the flake packages all three prebuilt — `pkgs.meridianPlugins.<name>` via the `meridian` overlay (or `meridian.legacyPackages.${system}.meridianPlugins`), each exposing `.path` for a `plugins.json` entry or the home-manager `pluginConfig` option. Pins are refreshed by a scheduled workflow that rebuilds every plugin before bumping.

Everyone else: install into Meridian's config dir and register the built file in
`~/.config/meridian/plugins.json`:

```bash
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

Paths must be absolute — the loader does not expand `~`.

Both plugin locations are configurable for the standalone CLI: `MERIDIAN_PLUGIN_DIR` overrides the auto-discovery directory and `MERIDIAN_PLUGIN_CONFIG` the manifest path (useful for Nix, containers, or running several instances with different plugin sets).
