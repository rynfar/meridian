# Deployment

[← Back to README](../README.md)

This page covers installing and running Meridian beyond `npm install -g`: NixOS/Nix flakes, the Home Manager service, and Docker.

## NixOS / Nix Flake
Meridian provides a Nix flake for declarative installation.

**Add to your flake inputs:**

```nix
{
  inputs.meridian.url = "github:rynfar/meridian";
}
```

**Install the package** (via overlay or directly):

```nix
# Option A: overlay
nixpkgs.overlays = [ meridian.overlays.default ];
environment.systemPackages = [ pkgs.meridian ];

# Option B: direct reference
environment.systemPackages = [ meridian.packages.${system}.meridian ];
```

**OpenCode plugin** -- the plugin file is included at `${pkgs.meridian}/lib/meridian/plugin/meridian.ts`. Since this path lives in the Nix store, you need to make it available to OpenCode:

If you generate your OpenCode config from Nix (e.g. via Home Manager), interpolate the path directly:

```nix
# home-manager example
xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
  plugin = [ "${pkgs.meridian}/lib/meridian/plugin/meridian.ts" ];
};
```

If you don't manage your OpenCode config through Nix, symlink the plugin to a stable path and reference that instead:

```nix
# configuration.nix or home-manager
environment.etc."meridian/plugin/meridian.ts".source =
  "${pkgs.meridian}/lib/meridian/plugin/meridian.ts";
```

Then in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["/etc/meridian/plugin/meridian.ts"] }
```

> **Important:** Do not use `meridian setup` on NixOS. It writes an absolute Nix store path (e.g. `/nix/store/...-meridian-1.x.x/lib/...`) into your OpenCode config, which will break on the next `nixos-rebuild switch` or `home-manager switch` when the store path changes. Use one of the approaches above instead.

> **Note:** Meridian's package depends on the unfree `claude-code` from nixpkgs instead of bundling its own binary. The flake accepts the unfree license when it builds the package and exports the finished derivation, so consuming it through the overlay or `packages.<system>.meridian` does not re-run nixpkgs' unfree check and needs no `allowUnfree` setting.

**Home Manager service** -- run Meridian as a user systemd service:

```nix
# flake.nix
{
  inputs.meridian.url = "github:rynfar/meridian";
}

# home-manager config
{
  imports = [ meridian.homeModules.default ];

  services.meridian = {
    enable = true;
    settings = {
      port = 3456;
      host = "127.0.0.1";
      # passthrough = true;
      # defaultAgent = "opencode";
      # sonnetModel = "sonnet";
      # Load plugins from the Nix store (rendered to a plugins.json manifest).
      # The official scrub plugins ship prebuilt via the meridian overlay:
      # pluginConfig = [ { path = pkgs.meridianPlugins.opencode-scrub.path; } ];
      # pluginDir = "/path/to/extra/plugins";
    };
    # Extra env vars not covered by settings
    # environment = {
    #   MERIDIAN_MAX_CONCURRENT = "20";
    # };
  };
}
```

The service starts automatically on login. Manage it with `systemctl --user {start,stop,restart,status} meridian`.

The module manages only the systemd user service — it does **not** put the `meridian` CLI on your `$PATH`. If you also want to run `meridian` from a shell, add the package yourself:

```nix
home.packages = [ config.services.meridian.package ];
```

The plugin path is also available as `config.services.meridian.opencode.pluginPath` for use in your OpenCode config:

```nix
xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
  plugin = [ config.services.meridian.opencode.pluginPath ];
};
```
## Docker

Claude Code authentication requires a browser, which isn't available inside containers. Authenticate on your local machine first, then mount the credentials into Docker.

### Single account

```bash
# 1. Authenticate locally (one time)
claude login

# 2. Run with mounted credentials
docker run -v ~/.claude:/home/claude/.claude -p 3456:3456 meridian
```

Meridian refreshes OAuth tokens automatically — once the credentials are mounted, no further browser access is needed.

> **macOS hosts:** mounting `~/.claude` does **not** carry credentials into the container — on macOS the CLI stores OAuth tokens in the Keychain, not in files, so the container sees an empty credential store and requests fail with an authentication error. Use an [OAuth-token profile](#oauth-token-profiles-in-docker-no-volume-mount) instead (recommended), or run `claude login` once inside the container (`docker exec -it <name> claude login`).

### Multiple profiles in Docker

Authenticate each profile locally, then pass them to Docker via the `MERIDIAN_PROFILES` environment variable:

```bash
# 1. Authenticate each account locally
meridian profile add personal
meridian profile add work    # sign out of claude.ai first, sign into work account

# 2. Run Docker with profile configs pointing to mounted credential directories
docker run \
  -v ~/.config/meridian/profiles/personal:/profiles/personal \
  -v ~/.config/meridian/profiles/work:/profiles/work \
  -e 'MERIDIAN_PROFILES=[{"id":"personal","claudeConfigDir":"/profiles/personal"},{"id":"work","claudeConfigDir":"/profiles/work"}]' \
  -e MERIDIAN_DEFAULT_PROFILE=personal \
  -p 3456:3456 meridian
```

Switch profiles at runtime via the `x-meridian-profile` header or `meridian profile switch` (see [Multi-Profile Support](profiles.md)).

### OAuth-token profiles in Docker (no volume mount)

If you'd rather not mount a credential directory, generate a long-lived OAuth token on the host with `claude setup-token` and pass it as a profile. There's nothing to mount — the token alone is the credential:

```bash
docker run \
  -e 'MERIDIAN_PROFILES=[{"id":"ci","oauthToken":"sk-ant-oat01-..."}]' \
  -e MERIDIAN_DEFAULT_PROFILE=ci \
  -p 3456:3456 meridian
```

This is the recommended path for CI runners, ephemeral containers, and cross-host deployments where browser-based login isn't reachable. Treat the token like any other secret — inject it via your platform's secret store rather than committing it to your image or compose file.
