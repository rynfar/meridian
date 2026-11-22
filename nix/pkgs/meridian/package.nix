{
  bun,
  callPackage,
  claude-code,
  lib,
  makeWrapper,
  nodejs_22,
  self,
  stdenvNoCC,
  versionCheckHook,
}:
let
  inherit (lib.meta) getExe;
  inherit (lib.sources) cleanSource;
  inherit (lib.strings) escapeShellArgs;
  inherit (lib.trivial) importJSON;
  inherit (stdenvNoCC) hostPlatform;
  package = importJSON "${self}/package.json";
in
stdenvNoCC.mkDerivation (finalAttrs: {
  inherit (package) version;
  pname = "meridian";

  src = cleanSource self;

  strictDeps = true;

  nativeBuildInputs = [
    bun
    makeWrapper
    nodejs_22
  ];

  buildInputs = [ nodejs_22 ];

  configurePhase = ''
    runHook preConfigure
    cp -R ${finalAttrs.passthru.node_modules}/build/node_modules .
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/meridian
    cp -r dist plugin package.json $out/lib/meridian/
    mkdir -p $out/lib/meridian/docs
    cp docs/configuration.md $out/lib/meridian/docs/
    cp -R ${finalAttrs.passthru.node_modules}/runtime/node_modules $out/lib/meridian/
    chmod -R u+w $out/lib/meridian/node_modules
    node ${./prune-foreign-platforms.mjs} $out/lib/meridian/node_modules ${
      escapeShellArgs [
        hostPlatform.node.platform
        hostPlatform.node.arch
      ]
    }

    makeWrapper ${getExe nodejs_22} $out/bin/${finalAttrs.meta.mainProgram} \
      --add-flags "$out/lib/meridian/dist/cli.js" \
      --set-default MERIDIAN_CLAUDE_PATH ${getExe claude-code}

    makeWrapper ${getExe nodejs_22} $out/bin/meridian-bookkeeping \
      --add-flags "$out/lib/meridian/dist/session-bookkeeping.js"

    runHook postInstall
  '';

  doInstallCheck = true;

  nativeInstallCheckInputs = [ versionCheckHook ];

  passthru.node_modules = callPackage ./node_modules.nix { inherit (finalAttrs) pname src version; };

  meta = {
    inherit (package) description;
    homepage = "https://github.com/rynfar/${finalAttrs.pname}";
    license = lib.licenses.mit;
    mainProgram = finalAttrs.pname;
    platforms = lib.platforms.unix;
    sourceProvenance = with lib.sourceTypes; [ fromSource ];
  };
})
