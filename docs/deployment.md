# Deployment

[← Back to README](../README.md)

This page covers installing and running Meridian beyond `npm install -g`: NixOS/Nix flakes, the Home Manager service, and Docker.

The [optional Mac app](../apps/desktop/README.md) can connect through a local HTTP
port. Docker and Nix keep ownership of their processes and updates; the app does
not rewrite their configuration or install packages inside those environments.
Headless deployments do not install or require Electron.

## NixOS / Nix Flake
Meridian provides a Nix flake for declarative installation.

**Add to your flake inputs:**

```nix
{
  inputs.meridian.url = "github:rynfar/meridian";
}
```

**Install the package.** In a NixOS or Home Manager configuration, use the
overlay. It builds Meridian with your own nixpkgs, so your overlays and
`config` apply to it, including to the unfree `claude-code` it wraps, which you
allow there:

```nix
nixpkgs.overlays = [ meridian.overlays.default ];
# Add claude-code to your predicate if you already have one.
nixpkgs.config.allowUnfreePredicate = pkg: lib.getName pkg == "claude-code";
environment.systemPackages = [ pkgs.meridian ];  # Home Manager: home.packages
```

With Home Manager's `useGlobalPkgs`, set the overlay and the predicate in your
NixOS configuration; without it, in Home Manager's own `nixpkgs` options.

To run or install Meridian outside a configuration, use the package the flake
builds with its own nixpkgs. Your nixpkgs config does not reach that build, so
allow `claude-code` for the command itself:

```sh
NIXPKGS_ALLOW_UNFREE=1 nix run --impure github:rynfar/meridian
# `nix profile install` on Nix releases without `nix profile add`
NIXPKGS_ALLOW_UNFREE=1 nix profile add --impure github:rynfar/meridian
```

Do not reference `meridian.packages.${system}.meridian` from a configuration:
it would need `NIXPKGS_ALLOW_UNFREE=1` and `--impure` on every rebuild. Use the
overlay instead.

**OpenCode plugin** -- the compiled plugin package is included at `${pkgs.meridian}/lib/meridian/dist/meridian`. Since this path lives in the Nix store, you need to make it available to OpenCode:

If you generate your OpenCode config from Nix (e.g. via Home Manager), interpolate the path directly:

```nix
# home-manager example
xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
  plugin = [ "${pkgs.meridian}/lib/meridian/dist/meridian" ];
};
```

If you don't manage your OpenCode config through Nix, symlink the plugin to a stable path and reference that instead:

```nix
# configuration.nix or home-manager
environment.etc."meridian/plugin/meridian".source =
  "${pkgs.meridian}/lib/meridian/dist/meridian";
```

Then in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["/etc/meridian/plugin/meridian"] }
```

> **Important:** Do not use `meridian setup` on NixOS. It writes an absolute Nix store path (e.g. `/nix/store/...-meridian-1.x.x/lib/...`) into your OpenCode config, which will break on the next `nixos-rebuild switch` or `home-manager switch` when the store path changes. Use one of the approaches above instead.

> **Note:** Meridian depends on the unfree `claude-code` from nixpkgs instead of bundling its own binary. The Home Manager module below builds Meridian the same way as the overlay, with the module's `pkgs`, so it does not need the overlay, but that nixpkgs must allow `claude-code` too. With the overlay or the module, if your nixpkgs' `claude-code` is older than the release Meridian requires, Meridian builds that same package at the required release; once your nixpkgs catches up, Meridian uses yours unchanged.

**Upgrading from an earlier flake revision.** Earlier revisions built Meridian
with the flake's own nixpkgs and accepted `claude-code`'s licence for you.
After updating the input:

- **The licence.** Evaluation fails with nixpkgs' unfree-package error naming
  `claude-code` until you allow it, as shown above, in the nixpkgs that builds
  Meridian. With Home Manager's `useGlobalPkgs` that is your system's nixpkgs;
  otherwise it is Home Manager's own `nixpkgs.config`.
- **`meridian.packages.${system}.meridian` in a configuration.** Switch to the
  overlay.
- **Plugin paths.** Each plugin is now installed at
  `lib/node_modules/@rynfar/meridian-plugin-<name>/dist/index.js`.
  Configurations that use `.path` follow it; a hard-coded `lib/index.js`
  breaks.
- **Plugin inputs.** The `meridian-plugin-*` inputs are gone. Remove any
  `follows` or override of them; Nix only warns about one that no longer
  applies.

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
      # The official scrub plugins ship prebuilt in the flake's legacyPackages
      # (and as pkgs.meridianPlugins through the meridian overlay):
      # pluginConfig = [ { path = meridian.legacyPackages.${pkgs.stdenv.hostPlatform.system}.meridianPlugins.opencode-scrub.path; } ];
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

Build the local image from the repository root first (the commands below use this image tag):

```bash
docker build -t meridian .
```

For browser-login credentials, authenticate on the host and mount the credential directory. For macOS or headless deployments, use an OAuth-token profile below. Browser authorization can also be completed on another machine using [headless profile login](profiles.md#headless--ssh-complete-claude-oauth-with-a-pasted-code).

The image runs as UID 1000; mounted credential directories must be writable by that user for refresh. Publish on loopback for local clients. Network deployments also need [proxy authentication](configuration.md#api-key-authentication); with the key set, open the admin pages by signing in once at `/login` ([details](configuration.md#signing-in-from-a-browser)), and re-authenticate an expired profile from the Profiles page ([browser login](profiles.md#from-the-web-ui-re-authenticate-a-profile-without-a-terminal)) instead of running `claude login` inside the container.

### Single account

```bash
# 1. Authenticate locally (one time)
claude login

# 2. Run with mounted credentials
docker run --name meridian -e MERIDIAN_HOST_ID=meridian-local \
  -v ~/.claude:/home/claude/.claude -p 127.0.0.1:3456:3456 meridian
```

Meridian attempts automatic refresh while the refresh credential remains valid. Expired or revoked login credentials still require another login.

> **macOS hosts:** mounting `~/.claude` does **not** carry credentials into the container — on macOS the CLI stores OAuth tokens in the Keychain, not in files, so the container sees an empty credential store and requests fail with an authentication error. Use an [OAuth-token profile](#oauth-token-profiles-in-docker-no-volume-mount) instead (recommended), or run `claude login` once inside the container (`docker exec -it <name> claude login`).

### Multiple profiles in Docker

Authenticate each profile locally, then pass them to Docker via the `MERIDIAN_PROFILES` environment variable:

```bash
# 1. Authenticate each account locally
meridian profile add personal
meridian profile add work    # sign out of claude.ai first, sign into work account

# 2. Run Docker with profile configs pointing to mounted credential directories
docker run -e MERIDIAN_HOST_ID=meridian-local \
  -v ~/.config/meridian/profiles/personal:/profiles/personal \
  -v ~/.config/meridian/profiles/work:/profiles/work \
  -e 'MERIDIAN_PROFILES=[{"id":"personal","claudeConfigDir":"/profiles/personal"},{"id":"work","claudeConfigDir":"/profiles/work"}]' \
  -e MERIDIAN_DEFAULT_PROFILE=personal \
  -p 127.0.0.1:3456:3456 meridian
```

Use `x-meridian-profile` per request or switch the active profile through the web UI. CLI commands run on the host need the same endpoint/auth configuration. macOS browser-login profiles can also use Keychain storage; mounting their directories alone may not transfer credentials. Use token profiles when moving across hosts.

### OAuth-token profiles in Docker (no volume mount)

If you'd rather not mount a credential directory, generate a long-lived OAuth token on the host with `claude setup-token` and pass it as a profile. There's nothing to mount — the token alone is the credential:

```bash
docker run -e MERIDIAN_HOST_ID=meridian-local \
  -e 'MERIDIAN_PROFILES=[{"id":"ci","oauthToken":"sk-ant-oat01-..."}]' \
  -e MERIDIAN_DEFAULT_PROFILE=ci \
  -p 127.0.0.1:3456:3456 meridian
```

This is the recommended path for CI runners, ephemeral containers, and cross-host deployments where browser-based login isn't reachable. Treat the token like any other secret — inject it via your platform's secret store rather than committing it to your image or compose file.

### Persistence and host identity

Set `MERIDIAN_HOST_ID` to a stable value unique to each container that shares a session directory. The examples use `meridian-local` for one local instance; use a different value for another instance. This keeps session-lock ownership stable across container restarts.

Persist `/home/claude/.cache/meridian` for session mappings, and `/home/claude/.config/meridian` for settings, plugins, profiles, and optional SQLite telemetry. SDK transcript state also needs to survive: mount the default `.claude` directory or each profile's isolated config directory. Persisting Meridian's session map alone cannot preserve a missing SDK transcript.

The supplied `docker-compose.yml` persists only the default Claude credential/state directory. Add the other volumes and a stable host identity for durable operation. Its published port binds all host interfaces by default; change it to `127.0.0.1:3456:3456` for local-only use. See [session-store constraints](configuration.md#known-limitations).
