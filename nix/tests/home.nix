{
  home-manager,
  pkgs,
  self,
}:
let
  inherit (pkgs) lib;
  evaluate =
    settings:
    (home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        self.homeModules.meridian
        { services.meridian.package = pkgs.emptyDirectory; }
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
  quoted = evaluate {
    enable = true;
    environment = {
      MERIDIAN_PROFILES = ''[{"claudeConfigDir":"/home/example/claude work","id":"personal"}]'';
      MERIDIAN_WORKDIR = ''/home/example/back\slash'';
      CLAUDE_CONFIG_DIR = "%h/.claude-work";
    };
  };
  quotedLines = [
    ''Environment="CLAUDE_CONFIG_DIR=%h/.claude-work"''
    ''Environment="MERIDIAN_PROFILES=[{\"claudeConfigDir\":\"/home/example/claude work\",\"id\":\"personal\"}]"''
    ''Environment="MERIDIAN_WORKDIR=/home/example/back\\slash"''
  ];
in
assert (evaluate { }).systemd.user.services == { };
assert !(builtins.hasAttr "systemd/user/meridian.service" (evaluate { }).xdg.configFile);
assert default.services.meridian.unsetEnvironment == [ ];
assert default.systemd.user.services.meridian.Service.UnsetEnvironment == [ ];
assert
  isolated.systemd.user.services.meridian.Service.UnsetEnvironment
  == isolated.services.meridian.unsetEnvironment;
assert builtins.elem ''"CLAUDE_CONFIG_DIR=/home/example/.claude-work"''
  isolated.systemd.user.services.meridian.Service.Environment;
assert builtins.elem ''"MERIDIAN_CONFIG_DIR=/home/example/.config/meridian-opencode"''
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
pkgs.runCommand "meridian-home"
  {
    nativeBuildInputs = [ pkgs.gnugrep ];
    defaultUnit = default.xdg.configFile."systemd/user/meridian.service".source;
    isolatedUnit = isolated.xdg.configFile."systemd/user/meridian.service".source;
    quotedUnit = quoted.xdg.configFile."systemd/user/meridian.service".source;
  }
  ''
    grep -Fxq '[Service]' "$defaultUnit"
    if grep -q '^UnsetEnvironment=' "$defaultUnit"; then
      exit 1
    fi
    for name in ${lib.escapeShellArgs isolated.services.meridian.unsetEnvironment}; do
      grep -Fxq "UnsetEnvironment=$name" "$isolatedUnit"
    done
    test "$(grep -c '^UnsetEnvironment=' "$isolatedUnit")" -eq ${toString (builtins.length isolated.services.meridian.unsetEnvironment)}
    grep -Fxq 'Environment="CLAUDE_CONFIG_DIR=/home/example/.claude-work"' "$isolatedUnit"
    grep -Fxq 'Environment="MERIDIAN_CONFIG_DIR=/home/example/.config/meridian-opencode"' "$isolatedUnit"
    for line in ${lib.escapeShellArgs quotedLines}; do
      grep -Fxq "$line" "$quotedUnit"
    done
    if grep -q '^Environment=[^"]' "$defaultUnit" "$isolatedUnit" "$quotedUnit"; then
      exit 1
    fi
    touch "$out"
  ''
