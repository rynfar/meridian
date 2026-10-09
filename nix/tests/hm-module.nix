{ pkgs, home-manager }:
let
  inherit (pkgs) lib;
  evaluate =
    settings:
    (home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        (import ../hm-module.nix { meridian = pkgs.emptyDirectory; })
        {
          home = {
            username = "meridian-test";
            homeDirectory = "/home/meridian-test";
            stateVersion = "25.11";
          };
          services.meridian = settings;
        }
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
assert !(builtins.hasAttr "systemd/user/meridian.service" (evaluate { }).xdg.configFile);
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
pkgs.runCommand "meridian-home-module"
  {
    nativeBuildInputs = [ pkgs.gnugrep ];
    defaultUnit = default.xdg.configFile."systemd/user/meridian.service".source;
    isolatedUnit = isolated.xdg.configFile."systemd/user/meridian.service".source;
  }
  ''
    grep -Fxq '[Service]' "$defaultUnit"
    ! grep -q '^UnsetEnvironment=' "$defaultUnit"
    for name in ${lib.escapeShellArgs isolated.services.meridian.unsetEnvironment}; do
      grep -Fxq "UnsetEnvironment=$name" "$isolatedUnit"
    done
    test "$(grep -c '^UnsetEnvironment=' "$isolatedUnit")" -eq ${toString (builtins.length isolated.services.meridian.unsetEnvironment)}
    grep -Fxq 'Environment=CLAUDE_CONFIG_DIR=/home/example/.claude-work' "$isolatedUnit"
    grep -Fxq 'Environment=MERIDIAN_CONFIG_DIR=/home/example/.config/meridian-opencode' "$isolatedUnit"
    touch "$out"
  ''
