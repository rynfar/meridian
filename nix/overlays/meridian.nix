{ self }:
final: _: {
  inherit (final.callPackage "${self}/nix/scope.nix" { inherit self; }) meridian meridianPlugins;
}
