# Browser account login incorporation (#792)

Status: real new-account OAuth and actual headless use verified; existing-account
re-authentication, final-head CI and integration remain acceptance gates.
Tracked API scope: [#1215](https://github.com/rynfar/meridian/issues/1215).
Source head: `47160ffe9a19cdf9fc38a2399d64f56210b0d1f6`. The four Nowaker
commits were cherry-picked with Author/AuthorDate intact; maintainer fixes are
separate. The user's dirty checkout was preserved.

Product fit: browser re-authentication and explicit new-account creation
remove the need for a shell on the server. Unknown login IDs remain refused;
creation uses its own guarded route. PKCE verifiers stay server-side, state
checks precede exchange, read-only instances refuse credential writes, and
new credentials are isolated until the account slot is published. This
changes authentication flows, not merely usage accounting.

## Concrete findings and before/after proof

1. The authored page used plain object maps. Valid IDs `__proto__` and
   `constructor` inherited truthy entries and never received login links.
   The emitted-page VM regression failed before the correction. Actual
   collaborative-browser DOM inspection confirmed both disabled links before,
   then all four fixture accounts enabled afterward. The three maps now have
   null prototypes. Existing profile search/sort behavior remains in the page.
2. Two actual Node processes could both successfully create distinct accounts
   from one stale snapshot, losing one account. Same-name creators could both
   report success with different credential directories. The maintained
   `e2e-profile-creation-concurrent.mjs` fails in both modes against the
   authored implementation and passes after the shared writer-lock fix.
   Creation, OAuth-token CLI add, remove and rename now read and publish under
   one cross-process lock. HTTP lock waits yield to the event loop. Publication
   is atomic and malformed existing files are refused. Read-only existing
   file refusal and rename rollback remain covered. Interrupted writers fail
   closed; manual lock cleanup requires stopping all writers.
3. A macOS `execFile` failure included `security -w` password arguments in
   debug logs. The maintained `e2e-keychain-write-log.mjs` uses the actual
   compiled credential store with a controlled failed OS command. Its
   baseline reports `secretLeaked: true`; the correction reports
   `secretLeaked: false`, while preserving the failure event and numeric exit
   code. Only synthetic credentials enter that probe.

4. During actual sign-in, returning from Claude reloaded the page and discarded
   the in-memory creation handle, leaving the returned code without its form.
   The emitted-page regression failed before the correction (`stored.size`
   zero instead of one). Pending metadata now stays in tab-scoped session
   storage until completion/cancel/expiry. It contains only the opaque handle,
   public authorize URL, profile name and expiry, never a pasted code/token.
   An actual collaborative-browser reload restored the correct account form
   with an empty code field. Expired, malformed-name and unsafe-URL controls
   are discarded; disabled-storage browsers keep a usable live form and see
   a notice to retain that page. The initial real grant was not exchanged; a
   fresh grant was subsequently completed as described below.

## Verification recorded so far

- macOS arm64, Node 22.22.3, Bun 1.3.11: profile-page regression, focused
  profile/login/OAuth/rename/config-store tests, typecheck and build pass.
- Linux arm64 Docker: 200 focused tests pass, zero skips/failures. Both
  independent-process creation modes pass and the actual file-backed native
  credential round trip passes.
- macOS actual Keychain write/read round trip with a synthetic grant passes,
  using a unique directory-derived service; the probe deletes only its item.
  Platform-specific credential-file assertions skip macOS deliberately; Linux
  checks them without skips.
- Full npm test after writer-lock and credential-log corrections passed:
  5,130 pass, zero failures, 35 platform skips. Final full repetition after
  the navigation correction: 5,135 pass, zero failures, 35 platform skips.
  Standalone typecheck and build also pass.
- Actual browser authorization completed new-account creation after a page
  reload. The returned code/state matched the retained form and was transferred
  directly in the browser, without appearing in chat. The isolated account was
  published and its credentials stored in its own macOS Keychain service.
- Maintained `scripts/e2e-profile-login-client.mjs` passed twice using that actual
  newly created account: macOS arm64, OpenCode 1.18.34, Opus 5.5, SDK 0.2.141,
  Claude Code 2.1.284, Bun 1.3.11, independently installed scrub 0.2.3. A real
  client tool reads a unique receipt, then the same session recalls it without
  tools. Both client invocations exit zero; all four real SDK queries use the
  new account directory and a query resumes. The second run observes actual
  upstream assistant messages confirming `claude-opus-5-5`.
- Snapshot support recovered after earlier automation errors. No saved visual
  evidence of real credentials or authorization codes is captured. DOM
  before/after measurements establish the synthetic page regression.
- Existing-account re-authentication is still pending. An expired attempt and
  an authorization request containing `code=true` are not completed grants.
  The automatic loopback redirect has not been observed; no success is claimed.

Reproduction scripts and commands are retained in the repository and E2E.md.
Private temporary logs are supporting local artifacts, not the durable proof
record. OAuth URLs/codes, credentials and raw client output are excluded.

Known store limitation: a successfully exchanged grant whose later profile
publication fails can leave an unreferenced macOS Keychain item. The source
store interface has no delete operation; isolated per-attempt services prevent
changing a winner's credentials. This is not claimed to clean up orphan items.
The native-store probe explicitly removes its own successful synthetic item.
