{ claude-code, lib }:
let
  inherit (lib.strings) hasSuffix versionOlder;
  inherit (lib.trivial) importJSON;
  manifest = importJSON (
    if hasSuffix ".zst" claude-code.src.url then ./manifest.zst.json else ./manifest.json
  );
in
if versionOlder claude-code.version manifest.version then
  claude-code.override { inherit manifest; }
else
  claude-code
