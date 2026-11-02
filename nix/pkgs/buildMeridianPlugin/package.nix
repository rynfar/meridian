{
  lib,
  nodejs,
  stdenvNoCC,
  typescript,
}:
lib.extendMkDerivation {
  constructDrv = stdenvNoCC.mkDerivation;

  excludeDrvArgNames = [
    "meta"
    "passthru"
  ];

  extendDrvArgs =
    finalAttrs:
    {
      meta ? { },
      passthru ? { },
      ...
    }:
    let
      packageDir = "lib/node_modules/@rynfar/${finalAttrs.pname}";
      entry = "${packageDir}/dist/index.js";
    in
    {
      strictDeps = true;
      nativeBuildInputs = [
        typescript
        nodejs
      ];

      buildPhase = ''
        runHook preBuild
        tsc
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p "$out"/${packageDir}
        cp -r dist package.json "$out"/${packageDir}
        runHook postInstall
      '';

      doInstallCheck = true;

      installCheckPhase = ''
        runHook preInstallCheck
        installedVersion=$(node --input-type=module --eval '
          const { default: plugin } = await import(process.argv[1]);
          console.log(plugin.version);
        ' "$out"/${entry})
        test "$installedVersion" = "$version"
        runHook postInstallCheck
      '';

      passthru = {
        path = "${finalAttrs.finalPackage}/${entry}";
      }
      // passthru;

      meta = {
        homepage = "https://github.com/rynfar/${finalAttrs.pname}";
        license = lib.licenses.mit;
        platforms = lib.platforms.unix;
      }
      // meta;
    };
}
