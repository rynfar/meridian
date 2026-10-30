{
  claude-code,
  lib,
  newScope,
  self,
}:
lib.makeScope newScope (
  scope:
  lib.packagesFromDirectoryRecursive {
    inherit (scope) callPackage;
    directory = ./pkgs;
  }
  // {
    inherit self;
    claude-code = scope.callPackage ./pkgs/claude-code/package.nix { inherit claude-code; };
  }
)
