/**
 * Landing page for Anthropic's OAuth redirect (`GET /callback`).
 *
 * Deliberately the one page without the shared site header. `/callback` is
 * reachable without the API key — it has to be, since Anthropic's redirect
 * carries no credentials — and the header polls `/health` and `/profiles/list`,
 * which are gated. Embedding it would render a broken "offline" chrome on the
 * one page a user sees mid-login. Everything else follows DESIGN.md: theme
 * tokens only, no page-level body background.
 *
 * The tab is not closed for the user. It was opened with `noopener`, so
 * `window.close()` would be refused after the sign-in navigation anyway, and
 * the page the user came from already knows the outcome — it polls for it.
 */

import { themeCss } from "./profileBar"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export interface LoginCallbackPageParams {
  ok: boolean
  profileId?: string
  message?: string
}

export function renderLoginCallbackPage(params: LoginCallbackPageParams): string {
  const title = params.ok ? "Signed in" : "Login failed"
  const detail = params.ok
    ? `Profile <strong>${escapeHtml(params.profileId ?? "")}</strong> is authenticated. You can close this tab — the Profiles page has already updated.`
    : escapeHtml(params.message ?? "The login could not be completed.")

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — ${escapeHtml(title)}</title>
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); line-height: 1.5; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 28px 32px; max-width: 520px; text-align: center;
  }
  .mark { font-size: 28px; line-height: 1; margin-bottom: 12px; }
  .mark.ok { color: var(--green); }
  .mark.err { color: var(--red); }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  p { font-size: 13px; color: var(--muted); }
  a { color: var(--accent); text-decoration: none; font-size: 13px; }
  a:hover { text-decoration: underline; }
  .back { margin-top: 18px; display: inline-block; }
</style>
</head>
<body>
<div class="card">
  <div class="mark ${params.ok ? "ok" : "err"}">${params.ok ? "\u2713" : "\u2717"}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${detail}</p>
  <a class="back" href="/profiles">Back to Profiles</a>
</div>
</body>
</html>`
}
