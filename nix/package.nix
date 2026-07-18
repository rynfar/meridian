{
  bun,
  bun2nix,
  claude-code,
  lib,
  makeWrapper,
  nodejs_22,
  stdenvNoCC,
}:
let
  inherit (lib.cli) toCommandLineGNU;
  inherit (lib.meta) getExe;
  inherit (lib.sources) cleanSource;
  inherit (lib.strings) removePrefix versionOlder;
  inherit (lib.trivial) importJSON;
  package = importJSON ../package.json;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  inherit (package) version;
  pname = "meridian";

  src = cleanSource ../.;

  nativeBuildInputs = [
    bun
    bun2nix.hook
    makeWrapper
    nodejs_22
  ];

  bunDeps = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };
  bunInstallFlags = toCommandLineGNU { } {
    ignore-scripts = true;
    linker = "hoisted";
  };

  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/meridian
    cp -r dist node_modules plugin package.json $out/lib/meridian/

    rm -rf $out/lib/meridian/node_modules/@anthropic-ai/{claude-code,claude-code-*,claude-agent-sdk-*} \
      $out/lib/meridian/node_modules/.bin/claude

    makeWrapper ${getExe nodejs_22} $out/bin/${finalAttrs.meta.mainProgram} \
      --add-flags "$out/lib/meridian/dist/cli.js" \
      --set MERIDIAN_CLAUDE_PATH ${getExe claude-code}

    runHook postInstall
  '';

  meta = {
    inherit (package) description;
    broken = versionOlder claude-code.version (
      removePrefix "^" package.dependencies."@anthropic-ai/claude-code"
    );
    homepage = "https://github.com/rynfar/${finalAttrs.pname}";
    license = lib.licenses.mit;
    mainProgram = finalAttrs.pname;
    platforms = lib.platforms.unix;
    sourceProvenance = with lib.sourceTypes; [ fromSource ];
  };
})
