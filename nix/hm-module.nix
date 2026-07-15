packages:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) filterAttrsRecursive mapAttrsToList mapAttrsToListRecursive;
  inherit (lib.generators) mkKeyValueDefault;
  inherit (lib.lists) concatMap elem;
  inherit (lib.meta) getExe;
  inherit (lib.modules) mkIf;
  inherit (lib.options)
    mkEnableOption
    mkOption
    mkPackageOption
    ;
  inherit (lib.strings)
    join
    upperChars
    splitStringBy
    toUpper
    ;
  inherit (lib.trivial) flip pipe;
  inherit (lib.types)
    attrsOf
    bool
    int
    nullOr
    port
    str
    ;
  cfg = config.services.meridian;
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
            env = flip pipe [
              (concatMap (splitStringBy (_: curr: elem curr upperChars) true))
              (map toUpper)
              (join "_")
              (s: "MERIDIAN_${s}")
            ];
          in
          pipe cfg.settings [
            (filterAttrsRecursive (_: v: v != null))
            (mapAttrsToListRecursive (path: value: mkKeyValueDefault { } "=" (env path) value))
          ]
          ++ mapAttrsToList (mkKeyValueDefault { } "=") cfg.environment;
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
