# Home Manager service environment isolation

The Home Manager module preserves the systemd user manager's environment by
default. For a subscription-only service, explicitly remove inherited API,
router, token and process-global directory overrides:

```nix
services.meridian = {
  enable = true;
  settings = {
    passthrough = true;
    defaultAgent = "opencode";
  };
  environment.MERIDIAN_CONFIG_DIR = "${config.xdg.configHome}/meridian-opencode";
  unsetEnvironment = [
    "ANTHROPIC_API_KEY"
    "ANTHROPIC_BASE_URL"
    "ANTHROPIC_AUTH_TOKEN"
    "CLAUDE_CODE_OAUTH_TOKEN"
    "CLAUDE_CONFIG_DIR"
    "MERIDIAN_WORKDIR"
    "CLAUDE_PROXY_WORKDIR"
  ];
};
```

This uses each user's standard HOME Claude login. Separate systemd user
managers have independent services and login files; use distinct loopback
ports when several users run Meridian on the same host.

For an explicit login directory, set
`environment.CLAUDE_CONFIG_DIR = "/home/example/.claude-work"` and remove
`CLAUDE_CONFIG_DIR` from `unsetEnvironment`. Log in with that same directory.
Meridian configuration and Claude login directories are independent.

Systemd applies `UnsetEnvironment` after assembling the service environment,
so listed names are also removed from `environment` and generated settings.
Use variable names, not `NAME=value` assignments. API-key and OAuth-token
profiles should select their own policy; subscription isolation is opt-in.

The module check verifies rendering, default compatibility and invalid names.
It does not verify a Claude login or an authenticated SDK request.
