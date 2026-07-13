{
  autoPatchelfHook,
  bun,
  bun2nix,
  lib,
  makeWrapper,
  nodejs_22,
  stdenv,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  inherit (lib.importJSON ../package.json) version;
  pname = "meridian";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    bun2nix.hook
    bun
    nodejs_22
    makeWrapper
  ]
  # node_modules vendors native ELF binaries — most importantly
  # @anthropic-ai/claude-code/bin/claude.exe (the Claude Code CLI the SDK
  # spawns) and its bundled ripgrep. They are dynamically linked against a
  # generic-Linux loader path (/lib64/ld-linux-*), which does not exist on
  # NixOS — every query died with exit=127 "Could not start dynamically
  # linked executable" (#501). autoPatchelfHook rewrites their interpreter
  # and rpaths to Nix store paths at build time, so users don't need the
  # nix-ld escape hatch.
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  # Runtime libraries autoPatchelfHook links the vendored ELFs against.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib # libstdc++ / libgcc_s for the bun-compiled claude.exe
  ];

  bunDeps = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };

  bunInstallFlags = [ "--linker=hoisted" ];

  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/meridian
    cp -r dist node_modules plugin package.json $out/lib/meridian/

    makeWrapper ${lib.getExe nodejs_22} $out/bin/meridian \
      --add-flags "$out/lib/meridian/dist/cli.js"

    runHook postInstall
  '';

  # claude.exe is a bun single-file executable: the JS payload is embedded in
  # the binary. Stripping would discard it and corrupt the CLI, so only the
  # patchelf part of fixup may touch it.
  dontStrip = true;

  # Vendored prebuilt binaries may reference optional libs we don't provide
  # (autoPatchelfHook fails the build on ANY missing dep otherwise). The
  # loader only needs the ones actually used at runtime; claude.exe's hard
  # deps (glibc, libstdc++) are covered above.
  autoPatchelfIgnoreMissingDeps = [ "*" ];

  meta = {
    description = "Local Anthropic API powered by your Claude Max subscription";
    homepage = "https://github.com/rynfar/meridian";
    license = lib.licenses.mit;
    mainProgram = "meridian";
    platforms = lib.platforms.unix;
  };
}
