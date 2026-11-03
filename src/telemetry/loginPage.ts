/**
 * Sign-in page for the admin UI when `MERIDIAN_API_KEY` is set (`GET /login`).
 *
 * Like `loginCallbackPage.ts`, deliberately without the shared site header:
 * the header polls `/health` and `/profiles/list`, and the second is gated,
 * so embedding it here would render a broken "offline" chrome on the one page
 * a signed-out user sees. Theme tokens only, per DESIGN.md.
 *
 * The form posts the key once; the server answers with an HttpOnly cookie that
 * carries a MAC of the key (see proxy/auth.ts), never the key itself.
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

export interface LoginPageParams {
  /** Same-origin path to return to after sign-in. Already validated by the route. */
  next: string
  /** Shown above the form after a refused key. */
  error?: string
}

export function renderLoginPage(params: LoginPageParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Sign in</title>
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); line-height: 1.5; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 28px 32px; width: 100%; max-width: 420px;
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  p { font-size: 13px; color: var(--muted); margin-bottom: 18px; }
  .error { color: var(--red); margin-bottom: 14px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  input[type=password] {
    width: 100%; font: inherit; font-size: 14px; color: var(--text);
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px;
  }
  input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    margin-top: 14px; width: 100%; font: inherit; font-size: 14px; font-weight: 600;
    color: var(--bg); background: var(--accent); border: 0; border-radius: 8px; padding: 10px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
</style>
</head>
<body>
<div class="card">
  <h1>Sign in to Meridian</h1>
  <p>This instance requires its API key (<code>MERIDIAN_API_KEY</code>) to open the admin pages. The key is sent once; the browser then keeps a session cookie, not the key.</p>
  ${params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : ""}
  <form method="post" action="/login" autocomplete="off">
    <input type="hidden" name="next" value="${escapeHtml(params.next)}">
    <label for="key">API key</label>
    <input id="key" name="key" type="password" autofocus required autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`
}
