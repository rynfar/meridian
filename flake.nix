{
  description = "Meridian – Local API bridge for Claude and Antigravity subscriptions";

  inputs = {
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    inputs@{
      flake-parts,
      home-manager,
      systems,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } (
      { lib, self, ... }:
      let
        inherit (flake-parts.lib) importApply;
        inherit (lib.attrsets) optionalAttrs;
      in
      {
        imports = [ home-manager.flakeModules.home-manager ];

        systems = import systems;

        perSystem = { config, pkgs, ... }: {
          legacyPackages = { inherit (pkgs.callPackage ./nix/scope.nix { inherit self; }) meridianPlugins; };

          packages = {
            default = config.packages.meridian;
            inherit (pkgs.callPackage ./nix/scope.nix { inherit self; }) meridian;
          };

          # Home Manager only renders systemd user units on Linux.
          checks = optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            home = import ./nix/tests/home.nix { inherit home-manager pkgs self; };
          };
        };

        flake = {
          homeModules = {
            default = self.homeModules.meridian;
            meridian = importApply ./nix/modules/home.nix { inherit self; };
          };

          overlays = {
            default = self.overlays.meridian;
            meridian = import ./nix/overlays/meridian.nix { inherit self; };
          };
        };
      }
    );
}
