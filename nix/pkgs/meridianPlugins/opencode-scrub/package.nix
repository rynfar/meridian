{ buildMeridianPlugin, fetchFromGitHub }:
buildMeridianPlugin (finalAttrs: {
  pname = "meridian-plugin-opencode-scrub";
  version = "0.3.0";

  src = fetchFromGitHub {
    owner = "rynfar";
    repo = finalAttrs.pname;
    tag = "${finalAttrs.pname}-v${finalAttrs.version}";
    hash = "sha256-WSMyEpGrBLAu8NTNazTEjG/VbFgN+BDjcFk9N1obW+A=";
  };

  meta.description = "Meridian plugin: strip opencode-identifying fingerprints from the system prompt before it reaches Claude";
})
