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

  # bun materialises node_modules from the cache we copied out of the read-only
  # Nix store, and on Darwin its default backend is clonefile, which carries the
  # source's permissions across. The hoisted linker then has to create a nested
  # node_modules/ inside a package directory whenever a transitive dependency
  # needs its own copy — and that mkdir hits AccessDenied on a mode-444 parent.
  #
  # It stayed invisible until #880: before @opencode-ai/plugin the tree needed
  # ZERO nested node_modules, so the hoisted linker never had to write inside a
  # package directory. It now needs 8, and the build fails with "Failed to
  # install 19 packages" (#913). Linux is unaffected — its default backend is
  # hardlink, which creates fresh directories.
  #
  # bun2nix already does exactly this chmod, but only in bunLifecycleScriptsPhase,
  # which runs AFTER the install that fails.
  preBunNodeModulesInstallPhase = ''
    chmod -R u+w "$BUN_INSTALL_CACHE_DIR"
  '';

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
      --set-default MERIDIAN_CLAUDE_PATH ${getExe claude-code}

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
