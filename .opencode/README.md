# opencode project configuration

[`opencode.json`](./opencode.json) pre-approves the directories Meridian owns,
so that working on this repository with an agent does not interrupt you to
confirm access to Meridian's own config directory several times an hour.

It also refuses a handful of files outright. **That half is the point**, and it
is why this config is not simply `"external_directory": "allow"`.

## What is allowed, and why it needs saying

Meridian reads and writes outside the repository by design, so an agent doing
almost anything here - running the proxy, reading settings, inspecting
telemetry - crosses opencode's external-directory boundary immediately:

| path | what lives there |
|---|---|
| `~/.config/meridian/**` | `settings.json`, `adapter-instances.json`, `sdk-features.json`, `model-pricing.json`, `plugins.json`, `plugins/`, `telemetry.db` |
| `~/.cache/meridian/**` | the session store (`MERIDIAN_SESSION_DIR`) |
| `~/.cache/opencode-claude-max-proxy/**` | the same store under its pre-rename path |

## What is denied, and why it cannot be relaxed

Four files in those same locations hold **live credentials**. Without the
denies below, pre-approving the directory would hand every agent working on
this repository the keys to every account configured in it:

| path | what it holds |
|---|---|
| `~/.config/meridian/profiles.json` | `apiKey` and `oauthToken` per profile (`ProfileConfig`, `src/proxy/profiles.ts`) |
| `~/.config/meridian/profiles/<id>/.credentials.json` | the OAuth access and **refresh** tokens for a browser-login profile |
| `~/.config/meridian/design-token.json` | a refresh token, which rotates on use |
| `~/.claude/.credentials.json` | Claude Code's own credentials (`src/proxy/tokenRefresh.ts`) |

A refresh token is the serious one: it is long-lived, it rotates on use, and a
copy that leaks into a transcript cannot be un-leaked. Recovering from that is
an interactive `claude login` per affected account.

**The two rules are not interchangeable, and each is load-bearing.**
`external_directory` is a *directory*-level gate - the prompt it raises names
`~/.config/meridian/*`, not a file - so it cannot tell `profiles.json` from
`settings.json`, which sit side by side. Only the file-path-matched `read`
rules can. Deleting the `read` block therefore silently exposes the
credentials while leaving this file looking careful.

Ordering is also load-bearing: opencode evaluates the **last** matching rule
(`findLast` in `packages/opencode/src/permission/index.ts`), so the broad
allows must stay above the narrow denies. Reordering them inverts the meaning.

Nothing here restricts Meridian itself. These rules govern opencode's own
file tools; the proxy, the CLI and their subprocesses read and write exactly
as they always have, which is why `meridian profile add` and `meridian profile
login` still work normally.

## Deliberately not listed

- **`~/.claude/**` as a whole** and **`~/.config/opencode/**`** are not
  pre-approved *here*. The first is Claude Code's directory rather than
  Meridian's; the second belongs to another tool and holds its provider API
  keys, and Meridian only writes it during `meridian setup`. Whether they
  prompt is left to your own global config, which is the right place to decide
  about somewhere this project mostly does not go. The `read` deny on
  `~/.claude/.credentials.json` still applies either way.
- **Relocated directories.** `MERIDIAN_CONFIG_DIR`, `MERIDIAN_SESSION_DIR`,
  `MERIDIAN_PLUGIN_DIR`, `MERIDIAN_PRICING_CONFIG`, `MERIDIAN_TELEMETRY_DB` and
  `MERIDIAN_DESIGN_TOKEN_PATH` can put any of this anywhere, so no static
  config can enumerate them. If you relocate one, add it yourself - and add the
  matching `read` deny if the new location holds credentials.

## Applying it

opencode loads config once at startup, so a change here reaches a session only
after that session's opencode is restarted.
