{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    bun2nix = {
      url = "github:nix-community/bun2nix/2.0.8";
      inputs = {
        flake-parts.follows = "flake-parts";
        nixpkgs.follows = "nixpkgs";
        systems.follows = "systems";
      };
    };
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    meridian-plugin-hermes-scrub = {
      url = "github:rynfar/meridian-plugin-hermes-scrub";
      flake = false;
    };
    meridian-plugin-opencode-scrub = {
      url = "github:rynfar/meridian-plugin-opencode-scrub";
      flake = false;
    };
    meridian-plugin-pi-scrub = {
      url = "github:rynfar/meridian-plugin-pi-scrub";
      flake = false;
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    inputs@{
      bun2nix,
      flake-parts,
      home-manager,
      nixpkgs,
      systems,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } (
      {
        moduleWithSystem,
        self,
        withSystem,
        ...
      }:
      {
        imports = [ home-manager.flakeModules.home-manager ];

        systems = import systems;

        perSystem =
          {
            config,
            lib,
            pkgs,
            system,
            ...
          }:
          let
            inherit (lib.attrsets) filterAttrs mapAttrs' nameValuePair;
            inherit (lib.strings) hasPrefix removePrefix;
            inherit (lib.trivial) pipe;
          in
          {
            _module.args.pkgs = import nixpkgs {
              inherit system;
              config.allowUnfreePredicate = pkg: lib.getName pkg == "claude-code";
              overlays = [ bun2nix.overlays.default ];
            };

            packages = {
              default = config.packages.meridian;
              meridian = pkgs.callPackage ./nix/package.nix { };
            };

            legacyPackages.meridianPlugins = pipe inputs [
              (filterAttrs (pname: _: hasPrefix "meridian-plugin-" pname))
              (mapAttrs' (
                pname: src:
                nameValuePair (removePrefix "meridian-plugin-" pname) (
                  pkgs.callPackage ./nix/plugin.nix { inherit pname src; }
                )
              ))
            ];
          };

        flake = {
          homeModules = {
            default = self.homeModules.meridian;
            meridian = moduleWithSystem (
              { self', ... }: flake-parts.lib.importApply ./nix/hm-module.nix self'.packages
            );
          };

          overlays = {
            default = self.overlays.meridian;
            meridian =
              _: prev:
              withSystem prev.stdenv.hostPlatform.system (
                { self', ... }:
                {
                  inherit (self'.packages) meridian;
                  inherit (self'.legacyPackages) meridianPlugins;
                }
              );
          };
        };
      }
    );
}
