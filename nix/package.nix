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
  # Deliberately NOT overriding bunInstallFlags.
  #
  # This used to force `--linker=hoisted` on every platform. That broke
  # `nix build` on Darwin from 1.62.7 onward (#913): bun materialises
  # node_modules from a cache backed by the read-only Nix store, and on Darwin
  # its default backend is clonefile, which carries the source's mode across.
  # The hoisted linker then has to create a nested node_modules/ inside a
  # package directory whenever a transitive dependency needs its own copy, and
  # that mkdir hits AccessDenied on a mode-444 parent.
  #
  # It stayed invisible until #880 because the tree previously needed ZERO
  # nested node_modules. @opencode-ai/plugin brought 8, and the build began
  # failing with "Failed to install 19 packages". Linux was unaffected: its
  # default backend is hardlink, which creates fresh directories — which is why
  # a Linux-only CI gate built green while macOS users could not install at all.
  #
  # bun2nix's own defaults are platform-aware (`--linker=isolated`, plus
  # `--backend=symlink` on Darwin) and never perform that nested write. Letting
  # them apply is the fix; the hook adds --ignore-scripts itself.

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
