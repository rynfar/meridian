# Authorized account preflight — 2026-11-04

Owner explicitly authorized **personal and kraken** accounts for live testing. This supersedes earlier same-account-only handoff instructions. Neither account was used for inference in this preflight.

- **Personal:** current access token, usage endpoint HTTP200; Extra Usage **enabled**. Included weekly utilization67%. Not admitted while Extra Usage is on. No login request is needed based on this result.
- **Kraken:** current stored access token; usage endpoint HTTP429. Extra Usage status and available included usage were not confirmed. No retry or inference.
- No refresh, owner credential write, billing change or private access-only grant was made. Both account reads used the normal Meridian credential-store interface in the exact #1505 project environment, with credential writes disabled. Sanitized receipts contain no access/refresh tokens or account identifiers beyond owner-supplied profile labels.
- Prior exact installed-client revoked-token failure remains valid for its old isolated grant. It does not establish current failure of these two accounts. That red remains archived separately.

[Read-only results](read-only-account-preflight.json), [selection receipt and frozen helper identity](account-selection-receipt.json). The hash-named0444 helper is retained here. No model/client acceptance credit. Next prerequisite: owner disables Extra Usage on personal; one read-only quota recheck before the frozen installed-client live gate, with mandatory matching Meridian V1 plugin/config/route/header and scrub witnesses. Kraken429 is retained, not polled away.
