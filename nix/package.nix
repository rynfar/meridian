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
  # Keep the hoisted linker: its flat layout is what makes libsql's optional
  # platform package (@libsql/darwin-arm64, @libsql/linux-x64-gnu) resolvable at
  # runtime. bun2nix's isolated default scopes those under node_modules/.bun,
  # where the bundled CLI cannot find them — the build still succeeds and the
  # installed binary dies on first import, which is worse than failing loudly.
  #
  # Pin the backend to copyfile. Each of the alternatives fails somewhere in the
  # Nix sandbox, because everything is materialised out of the read-only store:
  #
  #   clonefile  Darwin's default. Carries the source's mode across, so package
  #              directories land mode 444 and the hoisted linker's nested mkdir
  #              hits AccessDenied — this is #913 itself.
  #   hardlink   Linux's default. Directories are created fresh so the install
  #              succeeds, but the files share an inode with the store, and
  #              bun2nix's own `chmod -R u+rwx ./node_modules` in
  #              bunLifecycleScriptsPhase then fails "Operation not permitted".
  #   symlink    Only usable with the isolated linker, whose layout hides
  #              libsql's optional platform package from the bundled CLI.
  #
  # copyfile creates directories fresh AND gives every file its own inode, so
  # both the nested mkdir and the later chmod succeed.
  #
  # Invisible until #880: the tree previously needed ZERO nested node_modules,
  # and now needs 8 ("Failed to install 19 packages"). Linux was never affected
  # because its default backend is already hardlink, which creates fresh
  # directories — which is exactly why a Linux-only CI gate built green while
  # macOS users could not install at all.
  bunInstallFlags = toCommandLineGNU { } {
    ignore-scripts = true;
    linker = "hoisted";
    backend = "copyfile";
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
