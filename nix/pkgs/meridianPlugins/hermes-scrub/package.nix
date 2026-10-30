{ buildMeridianPlugin, fetchFromGitHub }:
buildMeridianPlugin (finalAttrs: {
  pname = "meridian-plugin-hermes-scrub";
  version = "0.2.0";

  src = fetchFromGitHub {
    owner = "rynfar";
    repo = finalAttrs.pname;
    tag = "${finalAttrs.pname}-v${finalAttrs.version}";
    hash = "sha256-Pk6kPBJbNfbJ3lBx/dJZ8RHsXMPhYQtYQuHJec8fa/A=";
  };

  meta.description = "Meridian plugin: strip Hermes Agent's coding-harness fingerprint from the system prompt before it reaches Claude";
})
