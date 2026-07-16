{
  formats,
  lib,
  pname,
  src,
  stdenvNoCC,
  typescript,
}:
let
  inherit (lib.trivial) importJSON;
  packageFile = packageFormat.generate "package.json" { type = "module"; };
  packageFormat = formats.json { };
in
stdenvNoCC.mkDerivation (
  finalAttrs:
  let
    package = importJSON "${finalAttrs.src}/package.json";
  in
  {
    inherit pname src;
    inherit (package) version;

    strictDeps = true;
    nativeBuildInputs = [ typescript ];

    buildPhase = ''
      runHook preBuild
      tsc
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib
      cp dist/*.js $out/lib/
      cp ${packageFile} $out/lib/package.json
      runHook postInstall
    '';

    passthru.path = "${finalAttrs.finalPackage}/lib/index.js";

    meta = {
      inherit (package) description;
      homepage = "https://github.com/rynfar/${finalAttrs.pname}";
      license = lib.licenses.mit;
      platforms = lib.platforms.unix;
    };
  }
)
