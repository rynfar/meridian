{ buildMeridianPlugin, fetchFromGitHub }:
buildMeridianPlugin (finalAttrs: {
  pname = "meridian-plugin-pi-scrub";
  version = "0.2.3";

  src = fetchFromGitHub {
    owner = "rynfar";
    repo = finalAttrs.pname;
    tag = "${finalAttrs.pname}-v${finalAttrs.version}";
    hash = "sha256-nZBnunLHjqV0JS/BgUOyXFCQ2Fdjcd/pNEtEIo/h9A4=";
  };

  meta.description = "Meridian plugin: strip pi-identifying fingerprints from the system prompt before it reaches Claude";
})
