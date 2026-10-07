{ pkgs }:
let
  inherit (pkgs) lib;
  evaluate =
    settings:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        {
          options.systemd.user.services = lib.mkOption {
            type = lib.types.attrs;
            default = { };
          };
        }
        (import ../hm-module.nix { meridian = pkgs.emptyDirectory; })
        { services.meridian = settings; }
      ];
    }).config;
  default = evaluate { enable = true; };
  isolated = evaluate {
    enable = true;
    environment = {
      MERIDIAN_CONFIG_DIR = "/home/example/.config/meridian-opencode";
      CLAUDE_CONFIG_DIR = "/home/example/.claude-work";
    };
    unsetEnvironment = [
      "ANTHROPIC_API_KEY"
      "ANTHROPIC_BASE_URL"
      "CLAUDE_CODE_OAUTH_TOKEN"
    ];
  };
in
assert (evaluate { }).systemd.user.services == { };
assert default.services.meridian.unsetEnvironment == [ ];
assert default.systemd.user.services.meridian.Service.UnsetEnvironment == [ ];
assert
  isolated.systemd.user.services.meridian.Service.UnsetEnvironment
  == isolated.services.meridian.unsetEnvironment;
assert builtins.elem "CLAUDE_CONFIG_DIR=/home/example/.claude-work"
  isolated.systemd.user.services.meridian.Service.Environment;
assert builtins.elem "MERIDIAN_CONFIG_DIR=/home/example/.config/meridian-opencode"
  isolated.systemd.user.services.meridian.Service.Environment;
assert
  !(builtins.tryEval (
    builtins.deepSeq
      (evaluate {
        enable = true;
        unsetEnvironment = [ "BAD=VALUE" ];
      }).systemd.user.services
      true
  )).success;
pkgs.writeText "meridian-home-module" "ok"
