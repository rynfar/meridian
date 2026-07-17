packages:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) mapAttrsToList;
  inherit (lib.generators) mkKeyValueDefault;
  inherit (lib.lists) concatLists elem optional;
  inherit (lib.meta) getExe;
  inherit (lib.modules) mkIf;
  inherit (lib.options)
    literalExpression
    mkEnableOption
    mkOption
    mkPackageOption
    ;
  inherit (lib.strings)
    concatStrings
    concatStringsSep
    stringToCharacters
    toUpper
    upperChars
    ;
  inherit (lib.types)
    attrsOf
    bool
    int
    listOf
    nullOr
    path
    port
    str
    submodule
    ;
  cfg = config.services.meridian;
  mkPluginFile = plugins: toString (pluginFormat.generate "plugins.json" { inherit plugins; });
  pluginFormat = pkgs.formats.json { };
in
{
  options.services.meridian = {
    enable = mkEnableOption "the Meridian proxy service";

    package = mkPackageOption packages "meridian" {
      pkgsText = "inputs.meridian.packages.\${pkgs.stdenv.hostPlatform.system}";
    };

    settings = {
      port = mkOption {
        type = port;
        default = 3456;
        description = "Port to listen on.";
      };

      host = mkOption {
        type = str;
        default = "127.0.0.1";
        description = "Host to bind to.";
      };

      idleTimeoutSeconds = mkOption {
        type = int;
        default = 120;
        description = "HTTP keep-alive idle timeout in seconds.";
      };

      passthrough = mkOption {
        type = nullOr bool;
        default = null;
        description = "Forward tool calls to client instead of executing. `null` lets Meridian auto-detect.";
      };

      defaultAgent = mkOption {
        type = nullOr str;
        default = null;
        description = "Default adapter for unrecognized agents (`opencode`, `forgecode`, `pi`, `crush`, `droid`, `passthrough`).";
      };

      sonnetModel = mkOption {
        type = nullOr str;
        default = null;
        description = "Sonnet context tier: `sonnet` (200k) or `sonnet[1m]` (1M, requires Extra Usage).";
      };

      pluginConfig = mkOption {
        type = listOf (submodule {
          options = {
            enabled = mkOption {
              type = bool;
              default = true;
              description = "Whether Meridian loads this plugin. Disabled entries stay in the manifest but are marked disabled.";
            };

            path = mkOption {
              type = path;
              example = literalExpression "pkgs.meridianPlugins.opencode-scrub.path";
              description = ''
                Path to the plugin's ESM entry file.
                Reference an entry *inside a packaged derivation*
                so the plugin's dependencies land in the store next to it.
                A bare `./file.js` path literal copies only that one file,
                which breaks plugins that import sibling `node_modules`.
              '';
            };
          };
        });
        default = [ ];
        # Render to a manifest only when plugins are actually configured.
        # Rendering the empty default too would export MERIDIAN_PLUGIN_CONFIG
        # unconditionally, silently overriding the user's own
        # ~/.config/meridian/plugins.json.
        apply = plugins: if plugins == [ ] then null else mkPluginFile plugins;
        description = "Plugins to load, in list order, rendered to a `plugins.json` manifest passed as `MERIDIAN_PLUGIN_CONFIG`. Leave empty to keep using `~/.config/meridian/plugins.json`.";
      };

      pluginDir = mkOption {
        type = nullOr path;
        default = null;
        description = "Directory Meridian auto-discovers plugins from. `null` uses Meridian's default (`~/.config/meridian/plugins`).";
      };

      telemetry = {
        persist = mkOption {
          type = bool;
          default = false;
          description = "Enable SQLite telemetry persistence.";
        };

        retentionDays = mkOption {
          type = nullOr int;
          default = null;
          description = "Days to retain telemetry data before cleanup.";
        };
      };
    };

    environment = mkOption {
      type = attrsOf str;
      default = { };
      description = "Extra environment variables passed to the Meridian service.";
    };

    opencode.pluginPath = mkOption {
      type = str;
      default = "${cfg.package}/lib/meridian/plugin/meridian.ts";
      readOnly = true;
      description = ''
        Nix store path to the OpenCode plugin file.
        Use this to reference the plugin in your OpenCode config.
      '';
    };
  };

  config = mkIf cfg.enable {
    systemd.user.services.meridian = {
      Unit.Description = "Meridian - Local Anthropic API proxy";

      Service = {
        Type = "exec";
        ExecStart = getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        Environment =
          let
            # camelCase settings name -> SNAKE_CASE fragment ("retentionDays" -> "RETENTION_DAYS")
            toSnake = s: concatStrings (map (c: if elem c upperChars then "_${c}" else c) (stringToCharacters s));
            envName = attrPath: "MERIDIAN_" + toUpper (concatStringsSep "_" (map toSnake attrPath));
            # Flatten cfg.settings into env assignments, skipping nulls.
            # Restricted to lib functions that have existed for years so the
            # module imposes no minimum nixpkgs version on consumers.
            flatten =
              prefix: attrs:
              concatLists (
                mapAttrsToList (
                  name: value:
                  if builtins.isAttrs value then
                    flatten (prefix ++ [ name ]) value
                  else
                    optional (value != null) (mkKeyValueDefault { } "=" (envName (prefix ++ [ name ])) value)
                ) attrs
              );
          in
          flatten [ ] cfg.settings ++ mapAttrsToList (mkKeyValueDefault { } "=") cfg.environment;
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
