{ claude-code, lib }:
let
  inherit (lib.strings) hasSuffix versionOlder;
  inherit (lib.trivial) functionArgs importJSON;
  floor = (importJSON ./manifest.json).version;
  rebuildable = claude-code ? override && functionArgs claude-code.override ? manifest;
in
if !versionOlder claude-code.version floor then
  claude-code
else if rebuildable then
  claude-code.override {
    manifest = importJSON (
      if hasSuffix ".zst" claude-code.src.url then ./manifest.zst.json else ./manifest.json
    );
  }
else
  throw "meridian needs claude-code ${floor} or newer, but the claude-code it was given is ${claude-code.version} and cannot be rebuilt at ${floor}: it is a wrapper, or comes from a nixpkgs too old to take a release manifest. Use, or wrap, a claude-code that is ${floor} or newer."
