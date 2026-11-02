/**
 * Profile management page.
 * Shows all configured profiles, their auth status, and setup instructions.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"
import { profileFactsJs } from "./profileFacts"
import { profileFindJs } from "./profileFind"
import { reorderClientJs, reorderCss, reorderLiveRegionHtml } from "./profileOrder"
import { PROVIDERS_NONE_SHOWN_HTML, profileProvidersCss, profileProvidersJs } from "./profileProviders"
import { isUnusableJs } from "./profileSpent"
import { WINDOW_LABELS } from "./profileUsage"
import { domPatchJs } from "./domPatch"
import { profileCardStatusCss, profileCardStatusJs } from "./profileCardStatus"


export const profilePageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Profiles</title>
<link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); padding: 0; line-height: 1.5; }
  .container { max-width: 800px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;
                   letter-spacing: 0.5px; margin-bottom: 12px; }

  .profile-search { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .profile-search[hidden] { display: none; }
  .profile-search input {
    flex: 1 1 260px; min-width: 0; padding: 8px 12px; border-radius: 8px;
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    font-family: inherit; font-size: 13px;
  }
  .profile-search input::placeholder { color: var(--muted); }
  .profile-search input:focus { outline: none; border-color: var(--accent); }
  .profile-search-count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .profile-no-match { padding: 32px; }
  .profile-no-match[hidden] { display: none; }
  .link-btn {
    background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer;
  }
  .link-btn:hover { text-decoration: underline; }
  /* Reordering a filtered list would move cards past ones nobody can see. */
  .filtering .drag-handle, .filtering .order-index, .filtering .order-note { display: none; }

  .profile-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px; margin-bottom: 12px; transition: border-color 0.2s; position: relative;
  }
  .profile-card[hidden] { display: none; }
  /* --brand and its relatives come from the card's .provider-<id> class
     (profileProviders.ts): each provider's active account, and the button
     that switches to one, are in that provider's brand. */
  .profile-card.active { border-color: var(--brand, var(--accent)); box-shadow: 0 0 0 1px var(--brand, var(--accent)); }
  #content .provider-group-head { margin-bottom: 10px; }
  #content .provider-group-head:not([hidden]) ~ .provider-group-head { margin-top: 24px; }
  /* Wide layout: the stack becomes a grid of larger cards, two to four to a
     row on a desktop monitor. The order note, the empty state and the loading
     line take a whole row rather than a card's slot. */
  html[data-layout="wide"] #content {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(min(560px, 100%), 1fr)); gap: 16px;
  }
  html[data-layout="wide"] #content > :not(.profile-card) { grid-column: 1 / -1; }
  html[data-layout="wide"] #content > .profile-card { margin-bottom: 0; }
  html[data-layout="wide"] #content > .provider-group-head { margin-bottom: 0; }
  /* Arriving from a /profiles#<name> link: one short pulse says which card. */
  .profile-card.anchor-flash { animation: profile-anchor-flash 0.5s ease-out; }
  @keyframes profile-anchor-flash {
    0% { box-shadow: 0 0 0 0 rgba(88,166,255,0); background: var(--surface); }
    35% { box-shadow: 0 0 0 4px rgba(88,166,255,0.35); background: rgba(88,166,255,0.12); }
    100% { box-shadow: 0 0 0 0 rgba(88,166,255,0); background: var(--surface); }
  }
  @media (prefers-reduced-motion: reduce) {
    .profile-card.anchor-flash { animation: none; }
  }
  /* The name links to its own card. */
  a.profile-name { color: inherit; text-decoration: none; }
  a.profile-name:hover { color: var(--accent); }
  /* The same mark / gives an account that cannot serve requests. The red
     border replaces an active card's brand border, and its brand ring stays
     outside the red, so the two still tell apart. */
  .profile-card.needs-login { border-color: var(--red); }
  /* The header row carries the reorder handle, the name, every badge the
     card can earn - active, the type, out of a limit - and the actions. On a
     phone they do not fit on one line, and a row that cannot wrap pushed the
     actions past the card's edge and scrolled the whole page sideways. The
     row wraps, a long name may break anywhere, and the actions stay
     right-aligned, on their own line once nothing else fits beside them.
     When everything fits on one line, as on a desktop, none of this changes
     the layout. */
  .profile-card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; }
  ${reorderCss}
  ${profileProvidersCss}
  ${profileCardStatusCss}
  .profile-name { font-size: 16px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .profile-card-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon-btn {
    background: var(--bg); color: var(--muted); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; cursor: pointer; display: inline-flex;
    align-items: center; transition: all 0.15s; flex-shrink: 0;
  }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
  .icon-btn.danger:hover { border-color: var(--red); color: var(--red); }
  .remove-confirm {
    margin-bottom: 12px; padding: 12px 14px; border-radius: 8px;
    background: rgba(248,81,73,0.08); border: 1px solid rgba(248,81,73,0.35);
  }
  .remove-confirm-text { font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
  .remove-confirm-actions { margin-top: 10px; display: flex; gap: 8px; }
  .confirm-btn {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
    transition: all 0.15s;
  }
  .confirm-btn:hover { border-color: var(--accent); color: var(--accent); }
  .confirm-btn.danger { color: var(--red); border-color: rgba(248,81,73,0.5); }
  .confirm-btn.danger:hover { background: var(--red); color: var(--bg); border-color: var(--red); }
  .rename-input {
    background: var(--surface2); color: var(--text); border: 1px solid var(--accent);
    border-radius: 6px; padding: 4px 8px; font-size: 14px; font-weight: 600;
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; width: 200px; max-width: 100%;
  }
  .rename-input:focus { outline: none; }
  .rename-hint { font-size: 11px; color: var(--muted); }
  .rename-error { font-size: 12px; color: var(--red); margin-bottom: 12px; }
  .profile-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase;
    letter-spacing: 0.5px; font-weight: 500; min-width: 0; overflow-wrap: anywhere;
  }
  .badge-active { background: rgba(var(--brand-rgb, 88,166,255),0.15); color: var(--brand-bright, var(--accent)); }
  .badge-type { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
  .badge-needs-login { background: rgba(248,81,73,0.12); color: var(--red); border: 1px solid rgba(248,81,73,0.35); }
  .badge-spent { background: rgba(248,81,73,0.15); color: var(--red); border: 1px solid rgba(248,81,73,0.35); }
  .spent-note { margin: 10px 0; padding: 10px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5;
    background: rgba(248,81,73,0.08); border: 1px solid rgba(248,81,73,0.3); color: var(--text);
    overflow-wrap: anywhere; }
  .spent-note .spent-why { color: var(--muted); }
  /* minmax(0, 1fr), not 1fr: a bare fr track is at least as wide as its
     longest unbreakable value, so an email address widened the grid past
     the card instead of wrapping. */
  .profile-details {
    display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 16px; font-size: 13px;
  }
  .detail-label { color: var(--muted); }
  .detail-value { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
  .cached-tag { color: var(--muted); font-size: 10px; font-style: italic; margin-left: 6px; white-space: nowrap; }
  .detail-unknown { color: var(--muted); font-style: italic; }
  .status-ok { color: var(--green); }
  .status-err { color: var(--red); }
  .detail-value.status-warn { color: var(--yellow); }
  .detail-value[tabindex]:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .detail-value .fact-explanation { display: none; margin-top: 4px; color: var(--muted); font-family: inherit; line-height: 1.4; }
  .detail-value:focus > .fact-explanation { display: block; }
  .switch-btn {
    margin-top: 12px; padding: 6px 16px; font-size: 12px; font-weight: 500;
    background: var(--bg); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 6px; cursor: pointer; transition: all 0.15s; max-width: 100%; overflow-wrap: anywhere;
  }
  .switch-btn:hover { background: rgba(88,166,255,0.1); }
  .switch-btn:disabled { opacity: 0.4; cursor: default; }
  .switch-btn.current { border-color: var(--border); color: var(--muted); cursor: default; }
  .switch-btn.switch-to { color: var(--brand-bright, var(--accent)); border-color: var(--brand, var(--accent)); }
  .switch-btn.switch-to:hover { background: rgba(var(--brand-rgb, 88,166,255),0.12); border-color: var(--brand-bright, var(--accent)); }

  .empty-state {
    text-align: center; padding: 48px; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  }
  .empty-state h2 { font-size: 16px; margin-bottom: 8px; color: var(--text); }
  .empty-state code { max-width: 100%; overflow-wrap: anywhere; }

  .guide {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px;
  }
  .guide h3 { font-size: 14px; margin-bottom: 12px; }
  .guide ol { padding-left: 20px; font-size: 13px; }
  .guide li { margin-bottom: 8px; }
  .guide code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
    background: var(--bg); padding: 2px 6px; border-radius: 4px; color: var(--accent2);
  }
  .guide .warn {
    margin-top: 12px; padding: 12px 16px; background: rgba(210,153,34,0.1);
    border: 1px solid rgba(210,153,34,0.3); border-radius: 8px; font-size: 12px;
  }
  .guide .warn strong { color: var(--yellow); }

  /* Browser login — the paste box that replaces a terminal round trip. */
  .login-btn {
    padding: 6px 12px; font-size: 12px; font-weight: 500;
    background: var(--surface2); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 6px; cursor: pointer; transition: all 0.15s;
  }
  .login-btn:hover { background: rgba(88,166,255,0.12); }
  .login-btn:disabled { opacity: 0.4; cursor: default; }
  /* The sign-in control is an <a>, so it needs a button's box back. */
  a.login-btn { display: inline-block; text-decoration: none; line-height: normal; }
  a.login-btn[aria-disabled="true"] { opacity: 0.5; cursor: default; }
  .login-panel {
    margin-top: 12px; padding: 14px 16px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 8px;
  }
  .login-panel-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .login-note {
    font-size: 12px; color: var(--muted); margin-bottom: 8px; padding: 8px 10px;
    background: rgba(210,153,34,0.1); border: 1px solid rgba(210,153,34,0.3); border-radius: 6px;
  }
  .login-steps { font-size: 12px; color: var(--muted); padding-left: 18px; margin-bottom: 10px; }
  .login-steps li { margin-bottom: 4px; }
  .login-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .login-input {
    flex: 1 1 260px; min-width: 0; padding: 7px 10px; border-radius: 6px;
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
  }
  .login-input:focus { outline: none; border-color: var(--accent); }
  .login-msg { margin-top: 10px; font-size: 12px; }
  .login-msg.err { color: var(--red); }
  .login-msg.busy { color: var(--muted); }
  .login-reopen { color: var(--accent); font-size: 11px; text-decoration: none; }
  .login-reopen:hover { text-decoration: underline; }
  .add-intro { font-size: 13px; color: var(--muted); margin-bottom: 10px; }
  .add-actions { margin-top: 8px; }
  .add-flow:empty { display: none; }
  .device-code { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0; }
  .device-code code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 22px; font-weight: 600;
    letter-spacing: 2px; color: var(--accent2); background: var(--bg); padding: 6px 14px;
    border: 1px solid var(--border); border-radius: 6px; overflow-wrap: anywhere;
  }
  .paste-label { display: block; font-size: 12px; color: var(--text); margin: 10px 0 6px; }
  .cmd-row { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cmd-label { font-size: 11px; color: var(--muted); }
  .cmd-note { font-size: 11px; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
  .access-note {
    margin-top: 12px; padding: 10px 14px; background: rgba(210,153,34,0.1);
    border: 1px solid rgba(210,153,34,0.3); border-radius: 8px; font-size: 12px; overflow-wrap: anywhere;
  }
  .remove-confirm-text code, .access-note code {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px;
    background: var(--bg); padding: 1px 5px; border-radius: 4px; color: var(--accent2);
  }
  .add-note { font-size: 11px; color: var(--muted); margin-top: 8px; }

  .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }
  .copy-cmd {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
    background: var(--bg); padding: 4px 10px; border-radius: 4px; color: var(--accent2);
    cursor: pointer; border: 1px solid var(--border); transition: border-color 0.15s;
    min-width: 0; overflow-wrap: anywhere;
  }
  .copy-btn {
    background: var(--bg); color: var(--muted); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; cursor: pointer; display: inline-flex;
    align-items: center; transition: all 0.15s;
  }
  .copy-btn:hover { border-color: var(--accent); color: var(--accent); }
  .copy-btn.copied { color: var(--green); border-color: var(--green); }

  /* OAuth usage panel — one block per profile, mirrors pylon's quota strip. */
  .usage-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
  .usage-section-title {
    font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  }
  .usage-as-of { font-size: 10px; color: var(--muted); text-transform: none; letter-spacing: 0; opacity: 0.7; }
  .usage-stale-note { font-size: 11px; color: var(--yellow); line-height: 1.4; margin: -2px 0 10px; }
  .usage-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr));
    gap: 8px;
  }
  .usage-card {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; min-width: 0;
  }
  .usage-row {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 11px; gap: 8px; margin-bottom: 6px;
  }
  .usage-label { color: var(--muted); font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
  .usage-pct { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-weight: 600; font-size: 12px; }
  .usage-bar {
    height: 4px; background: rgba(127,127,127,0.18); border-radius: 2px; overflow: hidden;
    margin-bottom: 4px;
  }
  .usage-fill { height: 100%; transition: width 0.4s ease; background: var(--green); }
  .usage-card.status-warn .usage-fill,
  .usage-card.status-warn .usage-pct { color: var(--yellow); }
  .usage-card.status-warn .usage-fill { background: var(--yellow); }
  .usage-card.status-high .usage-fill,
  .usage-card.status-high .usage-pct { color: var(--red); }
  .usage-card.status-high .usage-fill { background: var(--red); }
  .usage-reset { font-size: 10px; color: var(--muted); white-space: nowrap; }
  .usage-extra {
    margin-top: 8px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; font-size: 11px;
  }
  .usage-extra-row { display: flex; justify-content: space-between; gap: 8px; }
  .usage-extra.status-warn { border-color: var(--yellow); }
  .usage-extra.status-warn .usage-pct { color: var(--yellow); }
  .usage-extra.status-high .usage-pct { color: var(--red); }
  .usage-extra .usage-note { font-size: 10px; color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; min-width: 0; }
  .badge-credits { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .usage-empty {
    font-size: 11px; color: var(--muted); padding: 6px 0; font-style: italic;
  }
  /* A phone leaves a card about 230px inside: beside a 120px label column an
     email would wrap every few characters, so each label sits above its
     value instead. */
  @media (max-width: 480px) {
    .profile-details { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
    .detail-value { margin-bottom: 6px; }
    .empty-state { padding: 32px 16px; }
    /* Tap targets: every control on this page is at least 40px tall. */
    .login-btn, .switch-btn, .confirm-btn, .icon-btn, .copy-btn, .link-btn, .login-input { min-height: 40px; }
    .icon-btn, .copy-btn { min-width: 40px; justify-content: center; }
  }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
<h1>Profiles</h1>
<div class="subtitle" id="profiles-subtitle">Manage Claude account profiles</div>


<!-- The heading and search box sit outside #content, which render() rebuilds
     on every poll: a box inside it would lose its text every ten seconds. -->
<div class="section" id="profiles-section">
  <h2 class="section-title">Configured Profiles</h2>
  <div id="profiles-provider-chips"></div>
  <div class="profile-search" id="profiles-filter-bar" hidden>
    <input type="search" id="profiles-filter" autocomplete="off" spellcheck="false"
      aria-label="Filter profiles" aria-controls="content"
      placeholder="Filter by name, email, organization, plan (5x, 20x, max) or former name">
    <span class="profile-search-count" id="profiles-filter-count" aria-live="polite"></span>
  </div>
  <div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading\u2026</div></div>
  <div class="empty-state profile-no-match" id="profiles-no-match" hidden>
    No profile matches <strong id="profiles-no-match-query"></strong>.
    <button type="button" class="link-btn" onclick="setProfileQuery('')">Clear the search</button>
  </div>
  <div class="provider-none" id="profiles-provider-none" hidden>${PROVIDERS_NONE_SHOWN_HTML}</div>
</div>
${reorderLiveRegionHtml}

<!-- Outside #content on purpose: render() rebuilds that element wholesale on
     every poll, which would destroy a half-typed name or a pasted code. -->
<div class="section">
  <div class="section-title">Add a profile</div>
  <div class="profile-card"><div id="add-slot"></div></div>
</div>

<div class="section" style="margin-top:32px">
  <h2 class="section-title">Setup Guide</h2>
  <div class="guide">
    <!-- Claude-only text, hidden on an instance that serves ChatGPT alone. -->
    <div id="claude-guide">
    <h3>How profiles work</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
      Each profile is a separate Claude account with its own login credentials.
      Meridian stores them in isolated config directories and switches between them instantly.
    </p>

    <h3 style="margin-top:16px">Adding a new profile</h3>
    <ol>
      <li><strong>UI:</strong> Name it under <strong>Add a profile</strong> above, sign in, then paste
          the code Claude shows you \u2014 the whole callback URL works too</li>
      <li><strong>CLI:</strong> <code>meridian profile add &lt;name&gt;</code></li>
    </ol>
    <p style="font-size:12px;color:var(--muted);margin-top:8px">
      Either way the profile gets its own config directory and is ready to use immediately.
      Only the CLI offers to adopt existing <code>~/.claude</code> credentials as a profile;
      the UI always signs in fresh, so clicking Add can never quietly claim the account
      you are already logged in as on this machine.
    </p>

    <div class="warn">
      <strong>\u26a0 Important for adding a second account:</strong> Before adding a different
      account, sign out of claude.ai in your browser first, then sign in with the other
      account. Claude\u2019s OAuth reuses your browser session \u2014 if you\u2019re already signed
      in, the login will silently use the same account.
    </div>

    <h3 style="margin-top:16px">Switching profiles</h3>
    <ol>
      <li><strong>UI:</strong> Click an account card on the <a href="/" style="color:var(--accent)">home page</a>, or the Switch button on this page</li>
      <li><strong>CLI:</strong> <code>meridian profile switch &lt;name&gt;</code></li>
      <li><strong>Per-request:</strong> Send <code>x-meridian-profile: &lt;name&gt;</code> header</li>
    </ol>

    <h3 style="margin-top:16px">Re-authenticating a profile</h3>
    <ol>
      <li><strong>UI:</strong> Click <strong>Log in from browser</strong> on the profile card and sign in.
          Claude sends you back here and the login finishes itself. It is an ordinary link, so
          right-click it to open the sign-in in a private window or copy it into another browser
          \u2014 useful when this browser is already signed into a different Claude account.</li>
      <li><strong>CLI:</strong> <code>meridian profile login &lt;name&gt;</code></li>
    </ol>
    <p style="font-size:12px;color:var(--muted);margin-top:8px">
      Claude will only redirect back to <code>localhost</code> or <code>127.0.0.1</code> \u2014 those are the
      addresses registered for this client. Browsing Meridian on any other hostname, the panel
      asks for the code instead; the bare code or the whole callback URL both work.
    </p>

    <h3 style="margin-top:16px">Other commands</h3>
    <div style="font-size:13px;margin-top:8px">
      <code>meridian profile list</code> \u2014 show all profiles and auth status<br>
      <code>meridian profile login &lt;name&gt;</code> \u2014 re-authenticate an expired profile<br>
      <code>meridian profile rename &lt;old&gt; &lt;new&gt;</code> \u2014 rename a profile (or use the pencil above)<br>
      <code>meridian profile remove &lt;name&gt;</code> \u2014 remove a profile
    </div>
    <p style="font-size:13px;color:var(--muted);margin-top:12px">
      Renaming keeps the old name working: requests still naming it are served by
      the renamed profile, so nothing breaks mid-flight. That redirect is dropped
      as soon as the old name is taken again by a new profile.
    </p>
    </div>
    <!-- Filled in once /profiles/list says this instance serves ChatGPT. -->
    <div id="chatgpt-guide" hidden></div>
  </div>
</div>
</div>

<script>
` + profileFactsJs + profileFindJs + `
// Inlined from src/telemetry/profileUsage.ts. The TS source is unit-tested
// (see profile-usage.test.ts) and the labels object is interpolated here so
// the browser script and TS module share their data.
var WINDOW_LABELS = ${JSON.stringify(WINDOW_LABELS)};

function labelForWindow(type) {
  if (WINDOW_LABELS[type]) return WINDOW_LABELS[type];
  return String(type || '').split('_').map(function (p) {
    return p.length > 0 ? p[0].toUpperCase() + p.slice(1) : p;
  }).join(' ');
}

function classifyUtilization(u) {
  if (u == null || !isFinite(u)) return 'ok';
  if (u >= 0.85) return 'high';
  if (u >= 0.6) return 'warn';
  return 'ok';
}

function formatResetCountdown(resetsAt) {
  if (resetsAt == null || !isFinite(resetsAt)) return '';
  var ms = resetsAt - Date.now();
  if (ms <= 0) return 'resetting…';
  var minutes = Math.floor(ms / 60000);
  if (minutes < 60) return 'in ' + Math.max(1, minutes) + 'm';
  var hours = Math.floor(minutes / 60);
  var remMin = minutes % 60;
  if (hours < 24) return remMin > 0 ? 'in ' + hours + 'h ' + remMin + 'm' : 'in ' + hours + 'h';
  var days = Math.floor(hours / 24);
  var remHr = hours % 24;
  return remHr > 0 ? 'in ' + days + 'd ' + remHr + 'h' : 'in ' + days + 'd';
}

function formatExtraUsage(eu) {
  if (!eu || !eu.isEnabled) return null;
  var monthlyLimit = isFinite(eu.monthlyLimit) ? eu.monthlyLimit : 0;
  if (monthlyLimit <= 0) return null;
  var used = isFinite(eu.usedCredits) ? eu.usedCredits : 0;
  var utilization = (eu.utilization != null && isFinite(eu.utilization))
    ? Math.max(0, Math.min(1, eu.utilization))
    : (monthlyLimit > 0 ? Math.max(0, Math.min(1, used / monthlyLimit)) : 0);
  var currency = eu.currency || '';
  return {
    used: (currency + used.toFixed(2)).trim(),
    limit: (currency + monthlyLimit.toFixed(2)).trim(),
    utilizationPct: Math.round(utilization * 100),
    status: classifyUtilization(utilization),
  };
}

// Shared with / (profileSpent.ts), so both pages flag the same accounts.
${isUnusableJs}

${reorderClientJs}
${profileProvidersJs}
${domPatchJs}
${profileCardStatusJs}

var providersPresent = [];
// The chips sit outside #content, so a poll does not replace them; they are
// redrawn only when the providers or their counts change.
var providerChipsKey = null;

function renderProviderChips(groups) {
  var key = groups.map(function (g) { return g.provider + ':' + g.items.length; }).join(',');
  var slot = document.getElementById('profiles-provider-chips');
  if (key !== providerChipsKey) {
    providerChipsKey = key;
    slot.innerHTML = meridianProviders.chipsHtml(groups);
  }
  meridianProviders.syncChips(slot);
}

// Cache the last seen quota response so the /profiles/list refresh can
// keep showing usage even if a single /v1/usage/quota/all call fails.
var lastQuota = null;
// Last profile payload, so a rename can redraw from cache without refetching.
var lastProfiles = null;
// When that payload was asked for: an answer requested before a sign-in
// finished cannot know about it (see profileCardStatus.ts).
var lastProfilesRequestedAt = null;
// A quicker poll while a card is updating, so its new facts land in seconds.
var updatePollTimer = null;
// Profile whose name is being edited in place, and the error from the last
// rejected attempt. While editing, the poll is suspended — it rewrites
// innerHTML, which would blank the input mid-keystroke.
var editingProfile = null;
var renameError = null;
// A ChatGPT seat being removed: its confirm panel is open, and the poll waits.
var removingProfile = null;
var removeError = null;

var ICON_PENCIL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg>';
var ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25z"/><path d="M4.997 6.178a.75.75 0 10-1.494.144L4.462 16.5h7.076l.959-10.178a.75.75 0 00-1.494-.144l-.888 9.322H5.885l-.888-9.322z"/></svg>';
var ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>';
var ICON_X = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>';

function focusRenameInput() {
  var el = document.getElementById('rename-input');
  if (el) { el.focus(); el.select(); }
}

function redraw() {
  if (lastProfiles) render(lastProfiles, lastQuota);
}

function startRename(id) {
  editingProfile = id;
  renameError = null;
  redraw();
  focusRenameInput();
}

function cancelRename() {
  editingProfile = null;
  renameError = null;
  redraw();
}

async function commitRename(from) {
  var input = document.getElementById('rename-input');
  if (!input) return;
  var to = input.value.trim();
  if (!to || to === from) { cancelRename(); return; }
  var data;
  try {
    var res = await fetch('/profiles/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to })
    });
    data = await res.json();
  } catch (err) {
    data = { error: 'Could not reach Meridian.' };
  }
  if (data && data.success) {
    editingProfile = null;
    renameError = null;
    await refresh();
    if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
    return;
  }
  renameError = (data && data.error) || 'Rename failed.';
  redraw();
  focusRenameInput();
}

function detailFactFocused() {
  // CSS :focus stops matching when the browser loses window focus, while
  // activeElement still identifies the keyboard position to preserve.
  var active = document.activeElement;
  return !!(active && active.matches('.detail-value[tabindex]'));
}

function startRemove(id) {
  removingProfile = id;
  removeError = null;
  redraw();
}

function cancelRemove() {
  removingProfile = null;
  removeError = null;
  redraw();
}

async function commitRemove(id) {
  var data;
  try {
    var res = await fetch('/profiles/chatgpt/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: id })
    });
    data = await res.json();
  } catch (err) {
    data = { error: 'Could not reach Meridian.' };
  }
  if (data && data.success) {
    removingProfile = null;
    removeError = null;
    await refresh();
    if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
    return;
  }
  removeError = (data && data.error) || 'Remove failed.';
  redraw();
}

// Refreshes overlap (the 10s poll, the quicker one while a card updates, a
// finished sign-in), and their answers can land out of order: one asked for
// before an answer already drawn is older than the page and is dropped.
var refreshesIssued = 0;
var refreshDrawn = 0;

async function refresh() {
  if (editingProfile || removingProfile || detailFactFocused()) return;
  var requestedAt = Date.now();
  var seq = ++refreshesIssued;
  try {
    var [profilesRes, quotaRes, routingRes] = await Promise.all([
      fetch('/profiles/list'),
      fetch('/v1/usage/quota/all').catch(function () { return null; }),
      fetch('/settings/api/routing').catch(function () { return null; }),
    ]);
    var profiles = await profilesRes.json();
    var quota = null;
    if (quotaRes && quotaRes.ok) {
      try { quota = await quotaRes.json(); } catch (_) { quota = null; }
    }
    var routing = null;
    if (routingRes && routingRes.ok) {
      try { routing = await routingRes.json(); } catch (_) { routing = null; }
    }
    if (seq < refreshDrawn) return;
    refreshDrawn = seq;
    if (quota) lastQuota = quota;
    if (routing) {
      try { meridianReorder.adopt(routing); } catch (_) { /* keep the last good order */ }
    }
    lastProfiles = profiles;
    lastProfilesRequestedAt = requestedAt;
    adoptChatGpt(profiles);
    if (detailFactFocused()) return;
    render(profiles, lastQuota);
    noticeNewChatGptSeats(profiles.profiles || []);
  } catch {
    if (seq < refreshDrawn || detailFactFocused()) return;
    document.getElementById('content').innerHTML = '<div class="empty-state"><h2>Could not load profiles</h2><p>Is Meridian running?</p></div>';
  }
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// esc() goes through textContent, which leaves quotes alone: fine for text,
// not for a value inside an attribute.
function attr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

// Server-written guidance marks each command with backticks; set those as code.
function codeSpans(text) {
  return String(text || '').split('\`').map(function (part, i) {
    return i % 2 === 1 ? '<code>' + esc(part) + '</code>' : esc(part);
  }).join('');
}

var ICON_COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>';

function copyButton(cmd) {
  return '<button class="copy-btn" data-cmd="' + attr(cmd) + '" onclick="copyCmd(this)" title="Copy to clipboard">' + ICON_COPY + '</button>';
}

function commandRow(label, cmd, note, extraHtml) {
  return '<div class="cmd-row">'
    + '<span class="cmd-label">' + esc(label) + ':</span> '
    + '<code class="copy-cmd">' + esc(cmd) + '</code>' + copyButton(cmd)
    + (extraHtml || '')
    + (note ? '<span class="cmd-note">' + esc(note) + '</span>' : '')
    + '</div>';
}

// The rows that say how a profile is signed in again. A Claude profile's is
// Meridian's own command plus the browser login; a ChatGPT seat's are its
// owner's, because Meridian only follows that login.
function renderLoginRows(p) {
  if (!isChatGptProfile(p)) {
    var browserLogin = '';
    // Only claude-max profiles have an OAuth flow; api and oauth-token profiles
    // would only ever get a refusal, so they get no button.
    if ((p.type || 'claude-max') === 'claude-max') {
      // A real anchor with a real href, not a button. That is the only way the
      // browser offers "Open Link in Incognito Window" and "Copy Link Address"
      // — and someone signed into several Claude accounts needs those, because
      // the ambient session in their main browser is usually the wrong account
      // for the profile being re-authenticated. A button, or an anchor that
      // navigates from a click handler, gets no such menu.
      browserLogin = '<a class="login-btn login-link" data-profile="' + attr(p.id) + '"'
        + ' href="' + attr(loginHrefFor(p.id) || '#') + '"'
        + (loginHrefFor(p.id) ? '' : ' aria-disabled="true"')
        + ' target="_blank" rel="noopener noreferrer"'
        + ' onclick="return onLoginLinkClick(event, &quot;' + esc(p.id) + '&quot;)">Log in from browser</a>';
    }
    return commandRow('Login', 'meridian profile login ' + p.id, '', browserLogin);
  }
  var owner = p.owner || {};
  if (owner.name === 'meridian') {
    if (!owner.webSignIn) {
      return owner.importCommand ? commandRow('Import', owner.importCommand, 'Meridian holds this seat\\u2019s login') : '';
    }
    return '<div class="cmd-row"><span class="cmd-label">Login:</span> '
      + '<button class="login-btn" data-profile="' + attr(p.id) + '" onclick="startChatGptRelogin(this)">Sign in again</button> '
      + '<button class="switch-btn" style="margin-top:0" data-profile="' + attr(p.id) + '" onclick="renewChatGptSeat(this)">Renew now</button>'
      + '<span class="cmd-note">Meridian renews the token by itself before it expires. Sign in again when the seat needs a login.</span>'
      + '</div>';
  }
  var rows = commandRow('Login', owner.login, '\\u2192 ' + owner.loginMethod + ' \\u2192 ' + (p.label || p.id) + ' \\u2192 Refresh account \\u00b7 at ' + owner.name);
  if (p.tokenState === 'expired') {
    rows += commandRow('Renew', owner.refresh, 'or the ' + owner.refreshTool + ' tool in an opencode session');
  }
  return rows;
}

function renderAccessNote(p) {
  if (!isChatGptProfile(p)) {
    return '<div class="access-note"><strong style="color:var(--yellow)">\\u26a0 Needs re-authentication</strong></div>';
  }
  var help = profileAccessHelp(p);
  return '<div class="access-note"><strong style="color:var(--yellow)">\\u26a0 '
    + esc(help.pill.charAt(0).toUpperCase() + help.pill.slice(1)) + '</strong> \\u2014 ' + esc(help.reason) + '</div>';
}

// --- ChatGPT seats ---
//
// An instance that serves ChatGPT says so in /profiles/list (\`chatgpt\`),
// with who owns the seats' logins. That turns on the ChatGPT half of the add
// card and the guide; the seats themselves are ordinary profiles already.
var chatGptOwnerInfo = null;
var chatGptAddShown = false;
// 'chatgpt' only while the steps for a seat signed in elsewhere are open, so
// noticeNewChatGptSeats knows to name the seat that arrives.
var addProvider = 'claude';
// Seats present when the ChatGPT add card was opened, so one that arrives
// afterwards can be announced (and named) the moment a poll sees it.
var chatGptAddBaseline = null;

function chatGptSeatsOf(profiles) {
  var seats = {};
  for (var i = 0; i < profiles.length; i++) if (isChatGptProfile(profiles[i])) seats[profiles[i].seat] = true;
  return seats;
}

function adoptChatGpt(data) {
  if (!data || !data.chatgpt || !data.chatgpt.owner) return;
  if (!chatGptOwnerInfo) {
    chatGptOwnerInfo = data.chatgpt.owner;
    renderChatGptGuide(chatGptOwnerInfo);
  }
  var claude = (data.profiles || []).some(function (p) { return !isChatGptProfile(p); });
  document.getElementById('profiles-subtitle').textContent = claude
    ? 'Manage Claude accounts and ChatGPT seats'
    : 'Manage ChatGPT seats';
  document.getElementById('claude-guide').hidden = !claude;
  // The add form gains its ChatGPT button only once this is known, and is
  // redrawn only while untouched - a half-typed name must not vanish under a
  // poll - so a later poll retries until it can.
  if (chatGptAddShown) return;
  var input = addSlot() && addSlot().querySelector('.add-input');
  if (activeAdd || activeChatGptConnect || (input && (input.value || document.activeElement === input))) return;
  chatGptAddShown = true;
  resetAddForm('');
}

function renderChatGptGuide(owner) {
  var guide = document.getElementById('chatgpt-guide');
  if (owner.name === 'meridian') {
    guide.innerHTML = '<h3 style="margin-top:16px">ChatGPT seats</h3>'
      + '<p style="font-size:13px;color:var(--muted);margin-bottom:8px">Meridian holds these seats\\u2019 logins and renews their tokens itself. '
      + (owner.webSignIn
        ? 'Connect a seat under <strong>Add a profile</strong>: type its name, then <strong>Connect with ChatGPT</strong>. '
          + 'From a browser on another machine Meridian shows a one-time code to enter at auth.openai.com; on this machine it opens the ChatGPT sign-in. '
          + '<strong>Sign in again</strong> on a seat\\u2019s card signs that seat in again under the same name, and <strong>Renew now</strong> renews its token on the spot.</p>'
        : 'Bring a seat signed in elsewhere into its store with <code>' + esc(owner.importCommand) + '</code>.</p>');
    guide.hidden = false;
    return;
  }
  guide.innerHTML = '<h3 style="margin-top:16px">ChatGPT seats</h3>'
    + '<p style="font-size:13px;color:var(--muted);margin-bottom:8px">Each ChatGPT seat is a profile like any other here: switch to it, rename it, '
    + 'reorder it, search for it and link to it. Its login belongs to <strong>' + esc(owner.name) + '</strong>, which Meridian follows read-only: '
    + 'Meridian never signs a seat in, renews its token or deletes it. Those happen there:</p>'
    + '<ol>'
    +   '<li><strong>Add a seat:</strong> <code>' + esc(owner.login) + '</code> \\u2192 ' + esc(owner.loginMethod) + ' \\u2192 Add account. '
    +     'The seat appears here within ten seconds.</li>'
    +   '<li><strong>Sign a seat in again:</strong> the same menu \\u2192 pick the seat \\u2192 Refresh account</li>'
    +   '<li><strong>Renew an expired access token:</strong> <code>' + esc(owner.refresh) + '</code>, or the <code>' + esc(owner.refreshTool) + '</code> tool in an opencode session</li>'
    +   '<li><strong>Remove a seat:</strong> the same menu \\u2192 pick the seat \\u2192 Delete this account</li>'
    + '</ol>'
    + '<p style="font-size:13px;color:var(--muted);margin-top:8px">A turn for a ChatGPT model goes to the active seat first, then to the others '
    + 'in the order above. Renaming a seat keeps its old name working, as for a Claude profile. Resets are the banked rate-limit resets '
    + 'chatgpt.com lists for the seat; ' + esc(owner.name) + '\\u2019s <code>codex-reset</code> tool redeems one, and Meridian only reads them.</p>';
  guide.hidden = false;
}

// A seat that was not there when the ChatGPT add card opened has been signed
// in at its owner. Say so, give it the name typed for it, and go to its card.
async function noticeNewChatGptSeats(profiles) {
  if (addProvider !== 'chatgpt' || !chatGptOwnerInfo) return;
  if (!chatGptAddBaseline) { chatGptAddBaseline = chatGptSeatsOf(profiles); return; }
  var fresh = profiles.filter(function (p) { return isChatGptProfile(p) && !chatGptAddBaseline[p.seat]; });
  if (fresh.length === 0) return;
  for (var i = 0; i < fresh.length; i++) chatGptAddBaseline[fresh[i].seat] = true;
  var slot = addSlot();
  var input = slot ? slot.querySelector('.add-input') : null;
  var wanted = input ? input.value.trim() : '';
  var id = fresh[0].id;
  var note = '';
  if (wanted && fresh.length === 1 && wanted !== id) {
    var data;
    try {
      var res = await fetch('/profiles/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: id, to: wanted })
      });
      data = await res.json();
    } catch (err) {
      data = { error: 'Could not reach Meridian.' };
    }
    if (data && data.success) { id = data.to; if (input) input.value = ''; }
    else note = ' It keeps the name ' + id + ': ' + ((data && data.error) || 'the rename failed') + '.';
  }
  var added = fresh.length === 1
    ? 'Added ' + (fresh[0].label || fresh[0].id) + ' as ' + id + '.'
    : 'Added ' + fresh.length + ' seats: ' + fresh.map(function (p) { return p.id; }).join(', ') + '.';
  setPanelMsg(slot, added + note, note ? 'err' : '');
  await refresh();
  location.hash = encodeURIComponent(id);
}

function factRows(facts) {
  return facts.map(function (f) {
    var tone = f.tone === 'ok' ? ' status-ok' : f.tone === 'err' ? ' status-err' : f.tone === 'warn' ? ' status-warn' : '';
    var title = f.title ? ' title="' + esc(f.title).replace(/"/g, '&quot;')
      + '" tabindex="0" aria-label="' + esc(f.label + ': ' + f.value + '. ' + f.title).replace(/"/g, '&quot;') + '"' : '';
    var cached = f.cached ? ' <span class="cached-tag">(cached)</span>' : '';
    var explanation = f.title ? '<span class="fact-explanation" aria-hidden="true">' + esc(f.title) + '</span>' : '';
    return '<span class="detail-label">' + esc(f.label) + '</span>'
      + '<span class="detail-value' + tone + '"' + title + '>' + esc(f.value) + cached + explanation + '</span>';
  }).join('');
}

// Mirrors src/telemetry/cachedFacts.ts (unit-tested there). Marked per value
// rather than per card: a card mixes a live status with a remembered email, so
// one banner across it would mislabel whichever half it doesn't apply to.
function factProvenance(value, stale) {
  if (value == null || value === '') return 'never';
  return stale ? 'cached' : 'live';
}
function cachedTag(provenance) {
  return provenance === 'cached' ? '<span class="cached-tag">(cached)</span>' : '';
}
function renderFactValue(value, stale, extraClass) {
  var provenance = factProvenance(value, stale);
  if (provenance === 'never' && !stale) return null;
  var classes = 'detail-value' + (extraClass ? ' ' + extraClass : '');
  if (provenance === 'never') {
    return '<span class="' + classes + ' detail-unknown">never read</span>';
  }
  return '<span class="' + classes + '">' + esc(String(value)) + cachedTag(provenance) + '</span>';
}

// "last 4 checks failed (rate limited upstream)" — the run of failed checks
// since the last good reading, or '' when the last check succeeded. Reasons map
// through a fixed vocabulary rather than being echoed, so nothing the server
// sends reaches the DOM.
function describeFailedRun(failure) {
  if (!failure) return '';
  var why = failure.reason === 'rate_limited' ? 'rate limited upstream'
    : failure.reason === 'no_token' ? 'no credentials readable'
    : failure.reason === 'token_expired' ? 'access token expired'
    : failure.reason === 'unauthorized' ? 'access token refused'
    : failure.reason === 'invalid_token' ? 'access token unreadable'
    : failure.reason === 'identity_mismatch' ? 'token filed under another account'
    : failure.reason === 'invalid_response' ? 'unreadable answer from the usage endpoint'
    : 'usage endpoint unavailable';
  var n = Math.floor(Number(failure.consecutiveFailures));
  if (!isFinite(n) || n < 1) n = 1;
  return (n > 1 ? 'last ' + n + ' checks failed' : 'last check failed') + ' (' + why + ')';
}

// A refusal and the cached percentages are different kinds of fact, so they
// are rendered as different things: the badge states what the API is doing
// now, the bars below stay as the last successful read. Measured: an account
// showed 5h 67% / 7d 7% while every request through it was refused.
function spentSummary(spent) {
  if (!spent) return null;
  var bucket = spent.diagnosis && spent.diagnosis.bucket
    ? labelForWindow(spent.diagnosis.bucket)
    : 'unknown limit';
  var reported = !!(spent.diagnosis && spent.diagnosis.reported);
  var reset = formatResetCountdown(spent.until);
  return {
    bucket: bucket,
    reported: reported,
    label: bucket + (reported ? '' : ' (guess)'),
    reset: reset,
    why: (spent.diagnosis && spent.diagnosis.rationale) || '',
    at: spent.at,
  };
}

function renderSpentBadge(spent) {
  var s = spentSummary(spent);
  if (!s) return '';
  return '<span class="profile-badge badge-spent" title="' + esc(s.why) + '">out of ' + esc(s.label) + '</span>';
}

function renderSpentNote(spent, p) {
  var s = spentSummary(spent);
  if (!s) return '';
  var refused = refusalSubject(p);
  return '<div class="spent-note">'
    + '<strong style="color:var(--red)">\u26a0 ' + refused.vendor + ' is refusing this ' + refused.noun + '</strong> - '
    + 'out of <strong>' + esc(s.label) + '</strong>'
    + (s.reset ? ', expected back ' + esc(s.reset) : '')
    + '. Refused ' + esc(timeAgo(s.at)) + '.'
    + '<div class="spent-why">' + esc(s.why) + '. The percentages below are the last successful read, not live.</div>'
    + '</div>';
}

function renderUsageSection(profileQuota, p) {
  // No quota data for this profile yet (cold start or fetch failed) — hide
  // entirely so we don't render an empty box.
  if (!profileQuota) return '';
  // API-key profiles cannot use OAuth usage — silently omit.
  if (profileQuota.error === 'not_oauth') return '';

  var windows = (profileQuota.windows || []).filter(function (w) {
    return typeof w.utilization === 'number';
  });
  var extra = formatExtraUsage(profileQuota.extraUsage);

  var failedRun = describeFailedRun(profileQuota.failure);
  var usageTag = cachedTag(profileQuota.stale ? 'cached' : 'live');
  var chatgpt = isChatGptProfile(p);
  var credits = chatgpt ? codexCreditsView(profileQuota.credits, profileQuota) : null;

  // No figures at all means this profile has never been read successfully —
  // the route serves the last good reading at any age, so an empty windows
  // array is no longer "the stale window lapsed". Saying so keeps it distinct
  // from a profile genuinely sitting at 0%.
  if (windows.length === 0 && !extra && !credits) {
    if (chatgpt) {
      var gap = chatGptUsageGap(profileQuota.error);
      return gap
        ? '<div class="usage-section"><div class="usage-section-title">Usage</div><div class="usage-empty">No reading: ' + esc(gap) + '.</div></div>'
        : '';
    }
    if (profileQuota.error === 'no_token') {
      return '<div class="usage-section">'
        + '<div class="usage-section-title">Usage</div>'
        + '<div class="usage-empty">Run <code style="background:var(--bg);padding:1px 5px;border-radius:3px">claude login</code> to see usage.</div>'
        + '</div>';
    }
    // Credentials are fine here — Anthropic is throttling the usage endpoint
    // and there has never been a reading to fall back on. Saying "run claude
    // login" would send the user chasing a problem they don't have.
    if (profileQuota.error === 'rate_limited') {
      return '<div class="usage-section">'
        + '<div class="usage-section-title">Usage</div>'
        + '<div class="usage-empty">No reading yet — '
        +   esc(failedRun || 'rate limited upstream') + ', retrying.</div>'
        + '</div>';
    }
    return ''; // nothing fetched yet
  }

  // A seat's windows come from its usage endpoint or, when newer, from the
  // headers of the last response it served; the second is worth naming.
  var asOf = profileQuota.fetchedAt
    ? '<span class="usage-as-of">updated ' + timeAgo(profileQuota.fetchedAt)
      + (chatgpt && profileQuota.windowSource === 'headers' ? ' \u00b7 from its last response' : '') + '</span>'
    : '';

  // Figures are only ever this old because a later check failed, so the note
  // and the "updated Xm ago" beside the title answer the two halves of the
  // same question: how old these numbers are, and why they haven't moved.
  var staleNote = failedRun
    ? '<div class="usage-stale-note">'
      + esc(failedRun.charAt(0).toUpperCase() + failedRun.slice(1))
      + ' — figures below are the last successful read.</div>'
    : '';

  var cards = windows.map(function (w) {
    var pct = Math.max(0, Math.min(1, w.utilization));
    var pctRound = Math.round(pct * 100);
    var status = classifyUtilization(pct);
    var label = labelForWindow(w.type);
    var reset = formatResetCountdown(w.resetsAt);
    var tip = label + ' — ' + pctRound + '%' + (reset ? ' (resets ' + reset + ')' : '');
    return '<div class="usage-card status-' + esc(status) + '" title="' + esc(tip) + '">'
      + '<div class="usage-row">'
      +   '<span class="usage-label">' + esc(label) + '</span>'
      +   '<span class="usage-pct">' + pctRound + '%' + usageTag + '</span>'
      + '</div>'
      + '<div class="usage-bar"><div class="usage-fill" style="width:' + (pct * 100).toFixed(1) + '%"></div></div>'
      + (reset ? '<div class="usage-reset">' + esc(reset) + '</div>' : '')
    + '</div>';
  }).join('');

  var extraBlock = '';
  if (extra) {
    extraBlock = '<div class="usage-extra status-' + esc(extra.status) + '">'
      +   '<div class="usage-extra-row">'
      +     '<span class="usage-label">Extra usage</span>'
      +     '<span class="usage-pct">' + extra.utilizationPct + '%' + usageTag + '</span>'
      +   '</div>'
      +   '<div class="usage-bar"><div class="usage-fill" style="width:' + extra.utilizationPct + '%"></div></div>'
      +   '<div class="usage-extra-row" style="margin-top:4px">'
      +     '<span class="usage-reset">' + esc(extra.used) + ' / ' + esc(extra.limit) + '</span>'
      +   '</div>'
      + '</div>';
  } else if (credits) {
    // A balance has no limit to be a percentage of, so this block has no bar.
    extraBlock = '<div class="usage-extra status-' + esc(credits.status) + '">'
      +   '<div class="usage-extra-row">'
      +     '<span class="usage-label">Codex credits</span>'
      +     '<span class="usage-pct">' + esc(credits.value) + usageTag + '</span>'
      +   '</div>'
      +   '<div class="usage-extra-row" style="margin-top:4px">'
      +     '<span class="usage-note">' + esc(credits.note) + '</span>'
      +     (credits.policy ? '<span class="usage-note" style="text-align:right">' + esc(credits.policy) + '</span>' : '')
      +   '</div>'
      +   (credits.pace ? '<div class="usage-extra-row" style="margin-top:4px">'
      +     '<span class="usage-note credits-pace" title="' + attr(credits.pace.title) + '">' + esc(credits.pace.text) + '</span>'
      +   '</div>' : '')
      + '</div>';
  }

  return '<div class="usage-section">'
    + '<div class="usage-section-title">Usage' + asOf + '</div>'
    + staleNote
    + (cards ? '<div class="usage-grid">' + cards + '</div>' : '')
    + extraBlock
    + '</div>';
}

function render(data, quotaData) {
  const profiles = meridianReorder.sortProfiles(data.profiles || []);
  const refocusId = meridianReorder.focusAnchor();
  // Build quick lookup: profileId -> per-profile quota entry from
  // /v1/usage/quota/all. Endpoint may be unavailable (older Meridian)
  // or have errored — in that case quotaById is empty and the per-card
  // renderer simply hides its usage section.
  const quotaProfiles = (quotaData && Array.isArray(quotaData.profiles)) ? quotaData.profiles : [];
  const quotaById = Object.create(null);
  for (var qi = 0; qi < quotaProfiles.length; qi++) {
    quotaById[quotaProfiles[qi].id] = quotaProfiles[qi];
  }

  // One list, a group per provider; grouping keeps the saved order within each.
  const groups = meridianProviders.group(profiles, meridianProviders.providerOf);
  const slots = meridianProviders.slots(groups);
  const grouped = groups.length > 1;
  providersPresent = groups.map(function (g) { return g.provider; });
  renderProviderChips(groups);

  if (profiles.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty-state">'
      + '<h2>No profiles configured</h2>'
      + (chatGptOwnerInfo
        ? '<p style="margin-top:8px">Add your first one above: type a name, then <strong>Connect with ChatGPT</strong>'
          + ' (or <strong>Connect with Claude</strong> for a Claude account).</p>'
        : '<p style="margin-top:8px">Add your first one above, or from a terminal:</p>'
          + '<p style="margin-top:8px"><code class="mono" style="background:var(--bg);padding:8px 16px;border-radius:6px;display:inline-block">meridian profile add personal</code></p>')
      + '</div>';
    afterRender();
    return;
  }

  const reorderable = profiles.length > 1 && !meridianReorder.envPinned();

  let html = '';
  let anyUpdating = false;
  if (profiles.length > 1) html += meridianReorder.noteHtml(reorderable, profiles.some(isChatGptProfile), grouped);

  for (let idx = 0; idx < slots.length; idx++) {
    const slot = slots[idx];
    const p = slot.item;
    if (grouped && slot.place === 0) html += meridianProviders.headingHtml(slot.group, false);
    // Per profile rather than against data.activeProfile: an instance serving
    // both providers has an active Claude account AND an active ChatGPT seat.
    const isActive = !!p.isActive;
    const needsLogin = isUnusable({ loggedIn: p.loggedIn, error: (quotaById[p.id] || {}).error });
    const update = meridianCardStatus.updateOf(p, lastProfilesRequestedAt);
    if (update && update.state === 'updating') anyUpdating = true;
    html += '<div class="profile-card provider-' + esc(slot.provider) + (isActive ? ' active' : '') + (needsLogin ? ' needs-login' : '') + (update && update.state === 'updating' ? ' updating" aria-busy="true' : '') + '" id="' + esc(profileAnchorElementId(p.id)) + '" data-id="' + esc(p.id) + '" data-index="' + idx + '" data-group="' + esc(slot.provider) + '">';
    html += '<div class="profile-card-header">';
    if (editingProfile === p.id) {
      html += "<input class=\\"rename-input\\" id=\\"rename-input\\" value=\\"" + esc(p.id) + "\\" spellcheck=\\"false\\" autocomplete=\\"off\\""
        + " onkeydown=\\"if(event.key===&quot;Enter&quot;){event.preventDefault();commitRename(&quot;" + esc(p.id) + "&quot;)}"
        + "else if(event.key===&quot;Escape&quot;){cancelRename()}\\">";
      html += "<span class=\\"rename-hint\\">Enter to save \u00b7 Esc to cancel</span>";
      html += "<span class=\\"profile-card-actions\\">";
      html += "<button class=\\"icon-btn\\" title=\\"Save new name\\" onclick=\\"commitRename(&quot;"+esc(p.id)+"&quot;)\\">" + ICON_CHECK + "</button>";
      html += "<button class=\\"icon-btn\\" title=\\"Cancel\\" onclick=\\"cancelRename()\\">" + ICON_X + "</button>";
      html += "</span>";
    } else {
      if (reorderable && slot.size > 1) html += meridianReorder.handleHtml(p.id, idx, slot.place, slot.size);
      html += "<a class=\\"profile-name\\" href=\\"#" + esc(encodeURIComponent(p.id)) + "\\" title=\\"Link to this profile\\">" + esc(p.id) + "</a>";
      if (isActive) html += "<span class=\\"profile-badge badge-active\\">active</span>";
      html += meridianProviders.badgeHtml(slot.provider, "profile-badge");
      // A seat's type is its provider's name, which the badge before it says.
      if ((p.type || "claude-max") !== slot.provider) html += "<span class=\\"profile-badge badge-type\\">" + esc(p.type || "claude-max") + "</span>";
      // A seat's pill says what to do in the words of whoever holds its login.
      if (needsLogin && isChatGptProfile(p)) {
        var access = profileAccessHelp(p);
        html += '<span class="profile-badge badge-needs-login" title="' + esc(access.summary) + '">' + esc(access.pill) + '</span>';
      } else if (needsLogin) html += "<span class=\\"profile-badge badge-needs-login\\" title=\\"Cannot serve requests. Log in again below.\\">needs login</span>";
      html += meridianCardStatus.duplicateBadgeHtml(p, 'profile-badge');
      html += renderSpentBadge((quotaById[p.id] || {}).spent);
      if ((quotaById[p.id] || {}).servingOnCredits) html += '<span class="profile-badge badge-credits" title="This seat\u2019s plan usage is spent; its turns are paid with Codex credits">on credits</span>';
      html += "<span class=\\"profile-card-actions\\">";
      html += "<button class=\\"icon-btn\\" title=\\"Rename profile\\" onclick=\\"startRename(&quot;"+esc(p.id)+"&quot;)\\">" + ICON_PENCIL + "</button>";
      if (isChatGptProfile(p)) html += "<button class=\\"icon-btn danger\\" title=\\"Remove seat\\" onclick=\\"startRemove(&quot;"+esc(p.id)+"&quot;)\\">" + ICON_TRASH + "</button>";
      html += "</span>";
    }
    html += '</div>';
    html += meridianCardStatus.updateHtml(update);
    html += renderSpentNote((quotaById[p.id] || {}).spent, p);

    if (editingProfile === p.id && renameError) {
      html += '<div class="rename-error">' + esc(renameError) + '</div>';
    }

    if (removingProfile === p.id && isChatGptProfile(p) && p.removal) {
      // A followed seat's owner, not Meridian, deletes it: the panel says
      // where, instead of offering a Remove that could only be refused.
      html += '<div class="remove-confirm">';
      html += '<div class="remove-confirm-text">' + codeSpans(p.removal || '') + '</div>';
      html += '<div class="remove-confirm-actions">';
      html += '<button class="confirm-btn" onclick="cancelRemove()">Close</button>';
      html += '</div></div>';
    } else if (removingProfile === p.id) {
      html += '<div class="remove-confirm">';
      html += '<div class="remove-confirm-text">Remove <strong>' + esc(p.id) + '</strong>? Its stored credentials are deleted with it, so putting it back means logging in again.</div>';
      if (removeError) html += '<div class="rename-error">' + esc(removeError) + '</div>';
      html += '<div class="remove-confirm-actions">';
      html += '<button class="confirm-btn danger" onclick="commitRemove(&quot;'+esc(p.id)+'&quot;)">Remove</button>';
      html += '<button class="confirm-btn" onclick="cancelRemove()">Cancel</button>';
      html += '</div></div>';
    }

    html += '<div class="profile-details">' + factRows(profileFacts(p)) + '</div>';

    if (!p.loggedIn) html += renderAccessNote(p);

    html += renderLoginRows(p);

    // An open sign-in panel is the script's, not the render's: the refresh
    // leaves it, and the code being pasted into it, alone.
    html += '<div class="login-slot" id="login-slot-' + esc(p.id) + '"' + (loginPanelOpen(p.id) ? ' data-patch-own' : '') + '></div>';

    html += renderUsageSection(quotaById[p.id], p);

    if (!isActive) {
      html += '<button class="switch-btn switch-to" onclick="switchProfile(&quot;'+esc(p.id)+'&quot;)">Switch to ' + esc(p.id) + '</button>';
    } else {
      html += '<button class="switch-btn current" disabled>Currently active</button>';
    }

    html += '</div>';
  }

  // Patched in place, not replaced: unchanged nodes stay the same nodes, so a
  // find-in-page highlight, a selection, focus and scroll survive a refresh.
  meridianPatch.html(document.getElementById('content'), html);
  meridianReorder.restoreFocus(refocusId);
  if (anyUpdating && !updatePollTimer) {
    updatePollTimer = setTimeout(pollUpdate, 1500);
  }
  // The markup carries placeholder hrefs. Restore them from the cache, then top
  // up anything missing or near expiry in the background.
  applyLoginHrefs();
  ensureLoginLinks(profiles);
  afterRender();
}

// The search and the #anchor both act on the cards render() just drew, so
// they run after every render. Both change only visibility and scroll, never
// the markup, so they cannot wipe a panel or input the poll is protecting.
function afterRender() {
  applyProfileFilter();
  if (anchorPending && lastProfiles) {
    anchorPending = false;
    jumpToProfileAnchor();
  }
}

var profileQuery = '';
// Set on load and on hashchange; consumed by the first render with data, so
// the 10s poll never yanks the page back to the card after someone scrolls.
var anchorPending = !!location.hash;

function profilesForFind() {
  return (lastProfiles && Array.isArray(lastProfiles.profiles)) ? lastProfiles.profiles : [];
}

function writeProfilesUrl(hashId) {
  var url = new URL(location.href);
  if (profileQueryTerms(profileQuery).length > 0) url.searchParams.set('q', profileQuery);
  else url.searchParams.delete('q');
  if (hashId) url.hash = encodeURIComponent(hashId);
  if (url.toString() !== location.href) history.replaceState(history.state, '', url.toString());
}

// A card shows when its provider's chip is on AND it matches the search, or
// is updating after a sign-in (see profileCardStatus.ts); a provider's heading
// shows while any of its cards does. The count and the no-match message count
// only the providers on screen.
function applyProfileFilter() {
  var profiles = profilesForFind();
  var byId = Object.create(null);
  for (var i = 0; i < profiles.length; i++) byId[profiles[i].id] = profiles[i];
  var cards = document.querySelectorAll('#content .profile-card[data-id]');
  var shown = 0;
  var inView = 0;
  var groupShown = Object.create(null);
  for (var c = 0; c < cards.length; c++) {
    var group = cards[c].getAttribute('data-group');
    var providerOn = meridianProviders.visible(group, providersPresent);
    var cardProfile = byId[cards[c].getAttribute('data-id')];
    var match = providerOn && (profileMatchesQuery(cardProfile, profileQuery) || meridianCardStatus.isUpdating(cardProfile));
    cards[c].hidden = !match;
    if (providerOn) inView++;
    if (match) { shown++; groupShown[group] = true; }
  }
  var heads = document.querySelectorAll('#content .provider-group-head');
  for (var h = 0; h < heads.length; h++) heads[h].hidden = !groupShown[heads[h].getAttribute('data-group')];
  meridianProviders.syncChips(document.getElementById('profiles-provider-chips'));
  document.getElementById('profiles-provider-none').hidden = meridianProviders.anyShown(providersPresent);
  var filtering = profileQueryTerms(profileQuery).length > 0;
  document.getElementById('profiles-section').classList.toggle('filtering', filtering);
  document.getElementById('profiles-filter-bar').hidden = cards.length === 0 && !filtering;
  var paused = filtering && document.querySelector('#content .drag-handle') ? ' \u00b7 clear to reorder' : '';
  document.getElementById('profiles-filter-count').textContent = filtering
    ? shown + ' of ' + inView + paused
    : '';
  document.getElementById('profiles-no-match-query').textContent = profileQuery.trim();
  document.getElementById('profiles-no-match').hidden = !(filtering && inView > 0 && shown === 0);
}

function setProfileQuery(query) {
  profileQuery = String(query || '');
  var input = document.getElementById('profiles-filter');
  if (input.value !== profileQuery) input.value = profileQuery;
  applyProfileFilter();
  writeProfilesUrl(null);
}

// Scrolls under the sticky header rather than behind it; the header wraps to
// several rows on a phone, so its height is measured, not assumed.
function alignProfileCard(card) {
  var header = document.querySelector('.meridian-header');
  var offset = (header ? header.getBoundingClientRect().height : 0) + 12;
  window.scrollTo({ top: Math.max(0, card.getBoundingClientRect().top + window.scrollY - offset) });
}

// The header can still grow after the jump - its chips load on their own
// fetches and wrap to another row on a phone - and scroll anchoring then keeps
// the card where it was, now underneath. So a resize shortly after a jump
// re-aligns, until the reader scrolls on their own.
var anchorHold = null;
function releaseAnchorHold() { anchorHold = null; }
['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
  window.addEventListener(type, releaseAnchorHold, { passive: true });
});
if (window.ResizeObserver) {
  var profilesHeader = document.querySelector('.meridian-header');
  if (profilesHeader) new ResizeObserver(function () {
    if (!anchorHold || Date.now() > anchorHold.until || !anchorHold.card.isConnected) return;
    alignProfileCard(anchorHold.card);
  }).observe(profilesHeader);
}

function jumpToProfileAnchor() {
  var id = resolveProfileAnchor(location.hash, profilesForFind());
  if (!id) return;
  var card = document.getElementById(profileAnchorElementId(id));
  if (!card) return;
  // Following a link to one profile outranks a filter that hides it, the
  // provider chip included.
  var group = card.getAttribute('data-group');
  if (group && !meridianProviders.visible(group, providersPresent)) {
    meridianProviders.setHidden(group, false);
    applyProfileFilter();
  }
  if (card.hidden) setProfileQuery('');
  // A former name, or different casing, becomes the name the card shows.
  if (profileIdFromHash(location.hash) !== id) writeProfilesUrl(id);
  alignProfileCard(card);
  anchorHold = { card: card, until: Date.now() + 5000 };
  card.classList.remove('anchor-flash');
  void card.offsetWidth;
  card.classList.add('anchor-flash');
  card.addEventListener('animationend', function () { card.classList.remove('anchor-flash'); }, { once: true });
}

(function initProfileFind() {
  var input = document.getElementById('profiles-filter');
  profileQuery = new URL(location.href).searchParams.get('q') || '';
  input.value = profileQuery;
  input.addEventListener('input', function () { setProfileQuery(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); setProfileQuery(''); }
  });
  window.addEventListener('hashchange', function () {
    anchorPending = true;
    if (lastProfiles) afterRender();
  });
  // A chip click rewrites only the current history entry, so going back to
  // an earlier one can bring a different ?provider= with it.
  window.addEventListener('popstate', function () {
    meridianProviders.fromLocation();
    applyProfileFilter();
  });
  // The chips and "Show all" act on cards that are already drawn, so a toggle
  // never re-renders and never interrupts a rename, a login or a drag.
  document.getElementById('profiles-section').addEventListener('click', function (e) {
    var id = meridianProviders.onClick(e.target);
    if (!id) return;
    applyProfileFilter();
    if (id === '*') {
      var first = document.querySelector('#profiles-provider-chips .provider-chip');
      if (first) first.focus();
    }
  });
})();

function copyCmd(btn) {
  var cmd = btn.getAttribute('data-cmd');
  navigator.clipboard.writeText(cmd);
  btn.classList.add('copied');
  btn.innerHTML = '\u2713';
  setTimeout(function() {
    btn.classList.remove('copied');
    btn.innerHTML = ICON_COPY;
  }, 1500);
}

async function switchProfile(id) {
  const res = await fetch('/profiles/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: id })
  });
  const data = await res.json();
  if (data.success) refresh();
  else if (data.error) alert(data.error);
}

// --- Browser login ---
//
// The open login is held here rather than in the DOM because render() rebuilds
// #content wholesale on every poll — a panel written into a card would be
// destroyed mid-typing. While a login is open the card poll is paused, so the
// panel and whatever is half-pasted into it survive.
var activeLogin = null;
var loginPollTimer = null;

function loginSlot(id) { return document.getElementById('login-slot-' + id); }

function loginPanelOpen(id) {
  return !!((activeLogin && activeLogin.profile === id) || (activeChatGptRelogin && activeChatGptRelogin.profile === id));
}

function setPanelMsg(slot, text, kind) {
  if (!slot) return;
  var msg = slot.querySelector('.login-msg');
  if (!msg) return;
  msg.className = 'login-msg' + (kind ? ' ' + kind : '');
  msg.textContent = text || '';
}

function setLoginMsg(text, kind) {
  setPanelMsg(activeLogin ? loginSlot(activeLogin.profile) : null, text, kind);
}

// Sign-in links, minted server-side and held per profile so the anchor has a
// real href before anyone clicks it. Nothing secret lives here: the authorize
// URL is public by design, and the PKCE verifier never leaves the server.
var loginLinks = Object.create(null);
// Whether this browser can reach Meridian on loopback. A fact about the
// BROWSER, not about any one profile, so it is answered once for the page.
var loopbackOk = null;
// Set when the refusal is about the instance rather than a profile.
var loginBlocked = null;
// Cards whose link is being minted right now, so a render landing mid-mint
// does not start a second login for the same card.
var mintingLinks = Object.create(null);

// A card's link names ONE pending login. Once a panel has opened it, that
// login may be spent - completed, failed, or finished in the sign-in tab
// before the poll noticed - and its state will not be honoured again. Drop it
// so the card mints a fresh one rather than sending the next sign-in to a dead
// state. A link already re-minted underneath the panel is left alone.
function retireLoginLink(login) {
  var link = loginLinks[login.profile];
  if (link && link.loginId === login.loginId) delete loginLinks[login.profile];
  applyLoginHrefs();
  if (lastProfiles) ensureLoginLinks(lastProfiles.profiles || []);
}

function loginHrefFor(id) {
  var link = loginLinks[id];
  if (!link) return '';
  return (loopbackOk && link.loopback) ? link.loopback : link.hosted;
}

function applyLoginHrefs() {
  var els = document.querySelectorAll('.login-link');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var href = loginHrefFor(el.getAttribute('data-profile'));
    if (href) {
      el.setAttribute('href', href);
      el.removeAttribute('aria-disabled');
    } else {
      el.setAttribute('href', '#');
      el.setAttribute('aria-disabled', 'true');
    }
    if (loginBlocked) el.setAttribute('title', loginBlocked);
  }
}

async function mintLoginLink(id) {
  var res, data;
  try {
    res = await fetch('/profiles/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: id })
    });
    data = await res.json();
  } catch (err) {
    return 'error';
  }
  if (!res.ok) {
    if (data.code === 'credentials_readonly' || data.code === 'no_profiles') {
      loginBlocked = data.error || 'Login unavailable on this instance.';
      return 'blocked';
    }
    return 'error';
  }
  if (data.mode === 'redirect') loopbackOk = true;
  loginLinks[id] = {
    loginId: data.loginId,
    hosted: data.pasteAuthorizeUrl,
    loopback: data.loopbackAuthorizeUrl || null,
    probeUrl: data.loopbackProbeUrl || null,
    expiresAt: data.expiresAt
  };
  return 'ok';
}

// Keep every claude-max card's href live. Re-minted before the pending login
// expires, so a link that has sat on screen for a while still works when it is
// finally clicked — or when it is opened in another browser minutes later.
async function ensureLoginLinks(profiles) {
  if (loginBlocked) return;
  var due = [];
  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    if ((p.type || 'claude-max') !== 'claude-max' || mintingLinks[p.id]) continue;
    var link = loginLinks[p.id];
    if (!link || link.expiresAt - Date.now() < 120000) due.push(p.id);
  }
  if (due.length === 0) return;
  for (var m = 0; m < due.length; m++) mintingLinks[due[m]] = true;

  try {
    // The first alone: a refusal about the INSTANCE (a read-only standby, no
    // profiles at all) would otherwise repeat once per card, and each one is a
    // logged refusal on the server.
    if (await mintLoginLink(due[0]) === 'blocked') { applyLoginHrefs(); return; }
    await Promise.all(due.slice(1).map(mintLoginLink));
  } finally {
    for (var n = 0; n < due.length; n++) delete mintingLinks[due[n]];
  }

  if (loopbackOk === null) {
    var probe = null;
    for (var id in loginLinks) {
      if (loginLinks[id].probeUrl) { probe = loginLinks[id].probeUrl; break; }
    }
    loopbackOk = probe ? await loopbackReachable(probe) : false;
  }
  applyLoginHrefs();
}

function showLoginMessage(id, text, kind) {
  var slot = loginSlot(id);
  if (!slot) return;
  slot.innerHTML = '<div class="login-panel"><div class="login-msg ' + esc(kind) + '"></div></div>';
  var msg = slot.querySelector('.login-msg');
  if (msg) msg.textContent = text;
}

function onLoginLinkClick(ev, id) {
  if (loginBlocked) {
    ev.preventDefault();
    showLoginMessage(id, loginBlocked, 'err');
    return false;
  }
  var link = loginLinks[id];
  if (!link) {
    ev.preventDefault();
    showLoginMessage(id, 'Preparing the sign-in link\\u2026', 'busy');
    return false;
  }
  openLoginPanel(id, link);
  // Returning true lets the BROWSER follow the href. Nothing here opens a
  // window, so ctrl-click, middle-click and "open in incognito" all behave as
  // the user asked instead of being second-guessed by script.
  return true;
}

function openLoginPanel(id, link) {
  if (activeLogin && activeLogin.profile !== id) cancelLogin();
  var slot = loginSlot(id);
  if (!slot) return;
  activeLogin = { profile: id, loginId: link.loginId, pasteUrl: link.hosted };
  if (loopbackOk && link.loopback) {
    slot.innerHTML = renderWaitingPanel(id, link.loopback, link.hosted);
  } else {
    slot.innerHTML = renderPastePanel(id, link.hosted,
      'This browser cannot be redirected back to Meridian, so paste the code instead.');
    bindPasteInput(slot);
  }
  // Poll either way: the login can also be finished in another browser, and
  // then this panel should get out of the way.
  scheduleLoginPoll();
}

// Can this browser reach the instance that served this page on loopback?
//
// The probe is that login's own status route, so a 200 proves both that
// loopback is reachable AND that what answered holds this login — something
// else listening on the port answers 410. Any failure keeps the paste flow,
// so a wrong guess costs nothing.
async function loopbackReachable(probeUrl) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 2000);
  try {
    var res = await fetch(probeUrl, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return false;
    var body = await res.json();
    return body.status === 'waiting';
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The redirect flow's panel. It has no paste box on purpose — Claude comes
// back to Meridian by itself — so it does not share renderOauthPanel's shape.
function renderWaitingPanel(id, authorizeUrl, pasteUrl) {
  return '<div class="login-panel">'
    + '<div class="login-panel-title">Sign in as ' + esc(id) + '</div>'
    + '<ol class="login-steps">'
    +   '<li>A Claude sign-in tab just opened — '
    +     '<a class="login-reopen" href="' + esc(authorizeUrl) + '" target="_blank" rel="noopener noreferrer">open it again</a>'
    +     ' if it was blocked. Right-click either link to sign in from a private window or another browser.</li>'
    +   '<li>Make sure you are signed into the right Claude account for this profile.</li>'
    +   '<li>That is all — Claude sends you back here and this page finishes the login itself.</li>'
    + '</ol>'
    + '<div class="login-row">'
    +   '<button class="switch-btn current login-cancel" style="margin-top:0" onclick="cancelLogin()">Cancel</button>'
    // Also a real link, and pointed at the hosted code page on purpose: it is
    // the one that still works from a browser on ANOTHER machine, where a
    // loopback redirect has nowhere to come back to.
    +   '<a class="login-reopen" href="' + esc(pasteUrl || authorizeUrl) + '" target="_blank" rel="noopener noreferrer" onclick="switchToPaste();return true;">Paste a code instead</a>'
    + '</div>'
    + '<div class="login-msg busy">Waiting for you to finish signing in\\u2026</div>'
    + '</div>';
}

// One panel for both paste flows. Signing a profile in and creating one differ
// in their wording and their handlers, not in their shape — two copies of this
// markup would drift the moment either is touched.
function renderOauthPanel(o) {
  return '<div class="login-panel">'
    + '<div class="login-panel-title">' + o.title + '</div>'
    + (o.note ? '<div class="login-note">' + esc(o.note) + '</div>' : '')
    + '<ol class="login-steps">'
    +   '<li>A Claude sign-in tab just opened — '
    +     '<a class="login-reopen" href="' + esc(o.authorizeUrl) + '" target="_blank" rel="noopener noreferrer">open it again</a>'
    +     ' if it was blocked.</li>'
    +   '<li>' + o.accountStep + '</li>'
    +   '<li>Paste the code Claude shows you below — or the whole callback URL from the address bar.</li>'
    + '</ol>'
    + '<div class="login-row">'
    +   '<input class="login-input" type="text" autocomplete="off" spellcheck="false" placeholder="code, or https://platform.claude.com/oauth/code/callback?code=…">'
    +   '<button class="login-btn login-submit" onclick="' + o.onSubmit + '">' + o.submitLabel + '</button>'
    +   '<button class="switch-btn current login-cancel" style="margin-top:0" onclick="' + o.onCancel + '">Cancel</button>'
    + '</div>'
    + '<div class="login-msg"></div>'
    + '</div>';
}

function renderPastePanel(id, authorizeUrl, note) {
  return renderOauthPanel({
    title: 'Sign in as ' + esc(id),
    authorizeUrl: authorizeUrl,
    note: note,
    accountStep: 'Make sure you are signed into the right Claude account for this profile.',
    submitLabel: 'Complete login',
    onSubmit: 'submitLogin()',
    onCancel: 'cancelLogin()',
  });
}

function bindPasteInput(slot) {
  var input = slot.querySelector('.login-input');
  if (!input) return;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitLogin(); });
  input.focus();
}

// Falls back WITHOUT restarting the login: both authorize URLs were minted from
// the same challenge, so the one that shows a code completes the login already
// in progress.
function switchToPaste() {
  if (!activeLogin) return;
  var slot = loginSlot(activeLogin.profile);
  if (!slot || !activeLogin.pasteUrl) return;
  slot.innerHTML = renderPastePanel(activeLogin.profile, activeLogin.pasteUrl,
    'Opened a second sign-in that ends on a page showing the code.');
  bindPasteInput(slot);
}

function scheduleLoginPoll() {
  stopLoginPoll();
  loginPollTimer = setTimeout(checkLoginStatus, 1500);
}

function stopLoginPoll() {
  if (loginPollTimer) clearTimeout(loginPollTimer);
  loginPollTimer = null;
}

async function checkLoginStatus() {
  if (!activeLogin || activeLogin.spent) return;
  var loginId = activeLogin.loginId;

  var res, data;
  try {
    res = await fetch('/profiles/login/status?loginId=' + encodeURIComponent(loginId));
    data = await res.json();
  } catch (err) {
    scheduleLoginPoll();
    return;
  }

  // The login may have been cancelled or replaced while this was in flight.
  if (!activeLogin || activeLogin.loginId !== loginId) return;

  if (res.ok && data.status === 'waiting') { scheduleLoginPoll(); return; }
  if (res.ok && data.status === 'completed') { finishLogin(); return; }

  setLoginMsg(data.error || 'Login failed.', 'err');
  activeLogin.spent = true;
  stopLoginPoll();
}

function finishLogin() {
  stopLoginPoll();
  var finished = activeLogin;
  activeLogin = null;
  if (finished) {
    meridianCardStatus.beginUpdate(finished.profile);
    retireLoginLink(finished);
  }
  if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
  refresh();
}

async function submitLogin() {
  if (!activeLogin || activeLogin.spent) return;
  var slot = loginSlot(activeLogin.profile);
  var input = slot ? slot.querySelector('.login-input') : null;
  var value = input ? input.value.trim() : '';
  if (!value) { setLoginMsg('Paste the code first.', 'err'); return; }

  var buttons = slot ? slot.querySelectorAll('button') : [];
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  setLoginMsg('Exchanging…', 'busy');

  var res, data;
  try {
    res = await fetch('/profiles/login/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: activeLogin.loginId, code: value })
    });
    data = await res.json();
  } catch (err) {
    setLoginMsg('Could not reach Meridian.', 'err');
    for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    return;
  }

  if (!res.ok) {
    setLoginMsg(data.error || 'Login failed.', 'err');
    var cancelBtn = slot ? slot.querySelector('.login-cancel') : null;
    if (cancelBtn) cancelBtn.disabled = false;
    // The server says whether the login survived: it does when the paste was
    // rejected before any code reached Anthropic. Otherwise the code is spent
    // and this panel cannot retry it.
    if (data.retryable) {
      var submitBtn = slot ? slot.querySelector('.login-submit') : null;
      if (submitBtn) submitBtn.disabled = false;
      if (input) input.focus();
    } else {
      // Keep the panel — and with it the paused poll — so the reason stays
      // readable. render() rebuilds #content wholesale, so resuming here would
      // erase the very message telling the user their code was spent. Cancel
      // is the way out.
      activeLogin.spent = true;
    }
    return;
  }

  finishLogin();
}

function cancelLogin() {
  var previous = activeLogin;
  stopLoginPoll();
  activeLogin = null;
  if (previous) {
    var slot = loginSlot(previous.profile);
    if (slot) slot.innerHTML = '';
    retireLoginLink(previous);
  }
}

// --- Add a profile ---
//
// The same two steps against its own routes. Creating an account is a
// different act from re-authenticating one, and /profiles/login/start refuses
// an unknown name precisely so a typo there cannot create one.
//
// #add-slot sits outside #content, so this panel survives the poll on its own
// and — unlike the login panels — does not have to pause it.
var activeAdd = null;

function addSlot() { return document.getElementById('add-slot'); }

// One form for every kind of profile: a name, then the account it connects
// to. The flow a button starts renders below the form, in .add-flow, and the
// form stays on screen - disabled - so the name being used stays visible.
function addFlow() { var slot = addSlot(); return slot ? slot.querySelector('.add-flow') : null; }

function addName() {
  var slot = addSlot();
  var input = slot ? slot.querySelector('.add-input') : null;
  return input ? input.value.trim() : '';
}

function addForm() { var slot = addSlot(); return slot ? slot.querySelector('.add-form') : null; }

function setAddFormMsg(text, kind) { setPanelMsg(addForm(), text, kind); }

function setAddFormLocked(locked) {
  var form = addForm();
  if (!form) return;
  var els = form.querySelectorAll('input, button');
  for (var i = 0; i < els.length; i++) els[i].disabled = locked;
}

// Returning from the provider may reload this page. Retain only the pending
// handle and public authorize URL in this tab, never the pasted code or tokens.
function savePendingAdd(add) {
  try {
    if (add) sessionStorage.setItem('meridian.pendingAdd', JSON.stringify(add));
    else sessionStorage.removeItem('meridian.pendingAdd');
    return true;
  } catch (error) {
    // Storage can be disabled; the live form still works while it stays open.
    return false;
  }
}

function restorePendingAdd() {
  try {
    var raw = sessionStorage.getItem('meridian.pendingAdd');
    if (!raw) return false;
    if (raw.length > 8192) throw new Error('Invalid pending sign-in');
    var add = JSON.parse(raw);
    if (!add || typeof add.profile !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(add.profile)
      || typeof add.addId !== 'string' || !add.addId || typeof add.authorizeUrl !== 'string'
      || typeof add.expiresAt !== 'number' || !Number.isFinite(add.expiresAt)
      || add.expiresAt <= Date.now()) throw new Error('Invalid pending sign-in');
    var url = new URL(add.authorizeUrl);
    if (url.origin !== 'https://claude.com' || url.pathname !== '/cai/oauth/authorize')
      throw new Error('Invalid authorization URL');
    if (!addSlot()) return false;
    resetAddForm(add.profile);
    activeAdd = { profile: add.profile, addId: add.addId, authorizeUrl: add.authorizeUrl, expiresAt: add.expiresAt };
    savePendingAdd(activeAdd);
    setAddFormLocked(true);
    var flow = addFlow();
    flow.innerHTML = renderAddPanel(activeAdd.profile, activeAdd.authorizeUrl);
    var input = flow.querySelector('.login-input');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAdd(); });
    return true;
  } catch (error) {
    savePendingAdd(null);
    return false;
  }
}

function renderAddForm(prefill) {
  var chatgpt = !!chatGptOwnerInfo;
  return '<div class="add-form">'
    + '<div class="add-intro">' + (chatgpt
      ? 'Name the profile, then connect it to a Claude account or a ChatGPT seat.'
      : 'Sign in to another Claude account and keep it here alongside the others.') + '</div>'
    + '<div class="login-row">'
    +   '<input class="login-input add-input" type="text" autocomplete="off" spellcheck="false"'
    +     ' aria-label="New profile name" placeholder="new profile name" value="' + attr(prefill || '') + '">'
    + '</div>'
    + '<div class="login-row add-actions">'
    +   '<button class="login-btn" onclick="startAdd()">Connect with Claude</button>'
    +   (chatgpt ? '<button class="login-btn" onclick="startChatGptAdd()">Connect with ChatGPT</button>' : '')
    + '</div>'
    + '<div class="add-note">Letters, numbers, hyphens and underscores.'
    +   (chatgpt ? ' A ChatGPT seat\\u2019s name is lowercase and may also use dots; left empty, the seat is named after its email.' : '')
    + '</div>'
    + '<div class="login-msg"></div>'
    + '</div>'
    + '<div class="add-flow"></div>';
}

function resetAddForm(prefill) {
  stopChatGptConnectPoll();
  activeAdd = null;
  activeChatGptConnect = null;
  addProvider = 'claude';
  chatGptAddBaseline = null;
  savePendingAdd(null);
  var slot = addSlot();
  if (!slot) return;
  slot.innerHTML = renderAddForm(prefill);
  // Enter means something only while there is one button to mean.
  var input = slot.querySelector('.add-input');
  var buttons = slot.querySelectorAll('.add-actions button');
  if (input && buttons.length === 1) {
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') buttons[0].click(); });
  }
}

function renderAddPanel(id, authorizeUrl) {
  return renderOauthPanel({
    title: 'Create ' + esc(id),
    authorizeUrl: authorizeUrl,
    accountStep: 'Sign in with the Claude account this profile should use \\u2014 if a different account is already '
      + 'signed in at claude.ai, sign out there first, or Claude will reuse it without asking.',
    submitLabel: 'Create profile',
    onSubmit: 'submitAdd()',
    onCancel: 'cancelAdd()',
  });
}

async function startAdd() {
  var name = addName();
  if (!name) { setAddFormMsg('Name the profile first.', 'err'); return; }
  setAddFormMsg('Starting\\u2026', 'busy');

  var res, data;
  try {
    res = await fetch('/profiles/add/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: name })
    });
    data = await res.json();
  } catch (err) {
    setAddFormMsg('Could not reach Meridian.', 'err');
    return;
  }

  // The form is left standing on a refusal, name and all: every refusal here
  // is about the name, and retyping it to fix a typo is the wrong ask.
  if (!res.ok) { setAddFormMsg(data.error || 'Could not start.', 'err'); return; }

  setAddFormMsg('', '');
  setAddFormLocked(true);
  activeAdd = { profile: name, addId: data.addId, authorizeUrl: data.authorizeUrl, expiresAt: data.expiresAt };
  var retained = savePendingAdd(activeAdd);
  var flow = addFlow();
  flow.innerHTML = renderAddPanel(name, data.authorizeUrl);
  if (!retained) setPanelMsg(flow, 'Keep this page open while signing in; this browser cannot retain the pending form.', 'err');
  var codeInput = flow.querySelector('.login-input');
  if (codeInput) {
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAdd(); });
    codeInput.focus();
  }
  window.open(data.authorizeUrl, '_blank', 'noopener');
}

async function submitAdd() {
  if (!activeAdd || activeAdd.spent) return;
  var flow = addFlow();
  var input = flow ? flow.querySelector('.login-input') : null;
  var value = input ? input.value.trim() : '';
  if (!value) { setPanelMsg(flow, 'Paste the code first.', 'err'); return; }

  var buttons = flow ? flow.querySelectorAll('button') : [];
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  setPanelMsg(flow, 'Creating\\u2026', 'busy');

  var res, data;
  try {
    res = await fetch('/profiles/add/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addId: activeAdd.addId, code: value })
    });
    data = await res.json();
  } catch (err) {
    setPanelMsg(flow, 'Could not reach Meridian.', 'err');
    for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    return;
  }

  if (!res.ok) {
    setPanelMsg(flow, data.error || 'Could not create the profile.', 'err');
    var cancelBtn = flow ? flow.querySelector('.login-cancel') : null;
    if (cancelBtn) cancelBtn.disabled = false;
    if (data.retryable) {
      var submitBtn = flow ? flow.querySelector('.login-submit') : null;
      if (submitBtn) submitBtn.disabled = false;
      if (input) input.focus();
    } else {
      // The code is spent. Keep the panel so the reason stays readable —
      // Cancel is the way back to the form.
      activeAdd.spent = true;
      savePendingAdd(null);
    }
    return;
  }

  var created = activeAdd ? activeAdd.profile : null;
  resetAddForm('');
  if (created) meridianCardStatus.beginUpdate(created);
  if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
  refresh();
}

function cancelAdd() {
  // Keeps the name. Abandoning a sign-in almost always means the wrong Claude
  // account was signed in, not that the name was wrong.
  resetAddForm(activeAdd ? activeAdd.profile : '');
}

// --- Connect with ChatGPT ---
//
// A seat Meridian owns is signed in with the Codex CLI's own two flows. A
// browser that is not on this host - the usual case behind a vhost - gets the
// device code: the page shows a one-time code to enter at auth.openai.com, and
// Meridian finishes once it has been. A browser on this host gets the CLI's
// browser sign-in, whose redirect to 127.0.0.1:1455 finishes by itself; from
// anywhere else that tab ends on an address that does not load, which is
// pasted into the field the panel puts right under the steps.
var activeChatGptConnect = null;
var chatGptConnectTimer = null;

function browserOnThisHost() {
  var host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function startChatGptAdd() {
  var owner = chatGptOwnerInfo || {};
  if (owner.name === 'meridian' && owner.webSignIn) {
    if (browserOnThisHost()) startChatGptRedirect('');
    else startChatGptDevice();
    return;
  }
  // Meridian cannot sign in a seat it only follows - its owner does - so the
  // panel gives the owner's steps, and noticeNewChatGptSeats names the seat
  // after the name typed above once a poll sees it arrive.
  addProvider = 'chatgpt';
  chatGptAddBaseline = lastProfiles ? chatGptSeatsOf(lastProfiles.profiles || []) : null;
  var flow = addFlow();
  if (flow) flow.innerHTML = renderChatGptOwnerSteps(owner);
}

function renderChatGptOwnerSteps(owner) {
  var close = '<div class="login-row" style="margin-top:10px">'
    + '<button class="switch-btn current" style="margin-top:0" onclick="resetAddForm(addName())">Close</button></div>';
  if (owner.name === 'meridian') {
    return '<div class="login-panel">'
      + '<div class="add-intro">Meridian holds the ChatGPT logins on this instance. Sign the account in with opencode first, then bring it into Meridian\\u2019s store:</div>'
      + commandRow('Import', owner.importCommand, '')
      + '<div class="add-note">The seat appears in the list below once the import has finished.</div>'
      + close + '</div>';
  }
  return '<div class="login-panel">'
    + '<div class="add-intro">' + esc(owner.name) + ' owns the ChatGPT logins this Meridian serves. Sign the account in there, and Meridian '
    + 'picks the new seat up from its store by itself.</div>'
    + '<ol class="login-steps">'
    +   '<li>In a terminal on the machine running this Meridian:</li>'
    + '</ol>'
    + commandRow('Run', owner.login, '')
    + '<ol class="login-steps" start="2" style="margin-top:10px">'
    +   '<li>Choose <strong>' + esc(owner.loginMethod) + '</strong>, then <strong>Add account</strong> if it asks, and sign in. '
    +     'For a second ChatGPT account, sign in from a private browser window.</li>'
    +   '<li>The seat appears in the list below within ten seconds, under the name typed above if there is one.</li>'
    + '</ol>'
    + close + '</div>';
}

var CHATGPT_ADD_PANEL = {
  title: 'Connect with ChatGPT',
  account: 'the ChatGPT account this seat should use',
  inputId: 'chatgpt-paste',
  submitLabel: 'Connect',
  onSubmit: 'submitChatGptConnect()',
  onCancel: 'cancelChatGptConnect()',
  onSwitch: 'switchChatGptToRedirect()'
};

function renderChatGptDevicePanel(data, o) {
  var shown = String(data.verificationUrl || '').replace('https://', '');
  return '<div class="login-panel">'
    + '<div class="login-panel-title">' + esc(o.title) + '</div>'
    + (o.note ? '<div class="login-note">' + esc(o.note) + '</div>' : '')
    + '<ol class="login-steps">'
    +   '<li>Open <a class="login-reopen" href="' + attr(data.verificationUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(shown) + '</a>'
    +     ' in any browser, on any device, and sign in with ' + esc(o.account) + '.</li>'
    +   '<li>Enter this one-time code there. It expires in 15 minutes.</li>'
    + '</ol>'
    + '<div class="device-code"><code>' + esc(data.userCode) + '</code>' + copyButton(data.userCode) + '</div>'
    + '<div class="login-row" style="margin-top:12px">'
    +   '<button class="switch-btn current login-cancel" style="margin-top:0" onclick="' + o.onCancel + '">Cancel</button>'
    +   '<button type="button" class="link-btn" onclick="' + o.onSwitch + '">Use the browser sign-in instead</button>'
    + '</div>'
    + '<div class="login-msg busy">Waiting for the code to be entered\\u2026</div>'
    + '</div>';
}

function renderChatGptRedirectPanel(authorizeUrl, loopback, o) {
  return '<div class="login-panel">'
    + '<div class="login-panel-title">' + esc(o.title) + '</div>'
    + (o.note ? '<div class="login-note">' + esc(o.note) + '</div>' : '')
    + '<ol class="login-steps">'
    +   '<li>A ChatGPT sign-in tab just opened \\u2014 '
    +     '<a class="login-reopen" href="' + attr(authorizeUrl) + '" target="_blank" rel="noopener noreferrer">open it again</a>'
    +     ' if it was blocked. Right-click it to sign in from a private window.</li>'
    +   '<li>Sign in with ' + esc(o.account) + '.</li>'
    +   (loopback ? '<li>On this machine the tab then ends on a Meridian page saying the seat is connected, and this panel finishes by itself.</li>' : '')
    + '</ol>'
    + '<label class="paste-label" for="' + o.inputId + '">' + (loopback ? 'Signed in from another machine? ' : '')
    +   'Paste the whole address the sign-in tab ended on. It starts with http://127.0.0.1:1455 and that page does not load \\u2014 that is expected.</label>'
    + '<div class="login-row">'
    +   '<input id="' + o.inputId + '" class="login-input" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:1455/auth/callback?code=\\u2026">'
    +   '<button class="login-btn login-submit" onclick="' + o.onSubmit + '">' + esc(o.submitLabel) + '</button>'
    +   '<button class="switch-btn current login-cancel" style="margin-top:0" onclick="' + o.onCancel + '">Cancel</button>'
    + '</div>'
    + '<div class="login-msg busy">Waiting for you to finish signing in\\u2026</div>'
    + '</div>';
}

async function postChatGptConnect(path, body) {
  try {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { res: res, data: await res.json() };
  } catch (err) {
    return null;
  }
}

async function startChatGptDevice() {
  var name = addName();
  setAddFormMsg('Starting\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/device', { name: name });
  if (!reply) { setAddFormMsg('Could not reach Meridian.', 'err'); return; }
  var data = reply.data;
  if (!reply.res.ok) {
    if (data.code === 'invalid_profile_id' || data.code === 'chatgpt_signin_unavailable') {
      setAddFormMsg(data.error || 'Could not start the sign-in.', 'err');
      return;
    }
    // auth.openai.com would not hand out a code; its browser sign-in may still work.
    startChatGptRedirect((data.error || 'The device sign-in is unavailable.') + ' Using the browser sign-in instead.');
    return;
  }
  setAddFormMsg('', '');
  setAddFormLocked(true);
  activeChatGptConnect = { connectId: data.connectId, name: name };
  addFlow().innerHTML = renderChatGptDevicePanel(data, CHATGPT_ADD_PANEL);
  chatGptConnectTimer = setTimeout(pollChatGptConnect, 1500);
}

async function startChatGptRedirect(note) {
  var name = addName();
  setAddFormMsg('Starting\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/start', { name: name, returnTo: location.origin + '/profiles' });
  if (!reply) { setAddFormMsg('Could not reach Meridian.', 'err'); return; }
  var data = reply.data;
  if (!reply.res.ok) { setAddFormMsg(data.error || 'Could not start the sign-in.', 'err'); return; }
  setAddFormMsg(note || '', '');
  setAddFormLocked(true);
  activeChatGptConnect = { connectId: data.connectId, name: name };
  var flow = addFlow();
  flow.innerHTML = renderChatGptRedirectPanel(data.authorizeUrl, data.loopback, CHATGPT_ADD_PANEL);
  var input = flow.querySelector('.login-input');
  if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitChatGptConnect(); });
  window.open(data.authorizeUrl, '_blank', 'noopener');
  chatGptConnectTimer = setTimeout(pollChatGptConnect, 1500);
}

function stopChatGptConnectPoll() {
  if (chatGptConnectTimer) clearTimeout(chatGptConnectTimer);
  chatGptConnectTimer = null;
}

function finishChatGptConnect(data) {
  stopChatGptConnectPoll();
  activeChatGptConnect = null;
  resetAddForm('');
  setAddFormMsg('Connected ' + (data.email || data.accountUserId || data.seat) + (data.profile ? ' as ' + data.profile : '') + '.', '');
  if (data.profile) meridianCardStatus.beginUpdate(data.profile);
  if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
  refresh().then(function () { if (data.profile) location.hash = encodeURIComponent(data.profile); });
}

async function pollChatGptConnect() {
  var current = activeChatGptConnect;
  if (!current) return;
  var res, data;
  try {
    res = await fetch('/profiles/chatgpt/connect/status?connectId=' + encodeURIComponent(current.connectId));
    data = await res.json();
  } catch (err) {
    chatGptConnectTimer = setTimeout(pollChatGptConnect, 1500);
    return;
  }
  if (activeChatGptConnect !== current) return;
  if (res.ok && (data.status === 'waiting' || data.status === 'exchanging')) {
    chatGptConnectTimer = setTimeout(pollChatGptConnect, 1500);
    return;
  }
  if (res.ok && data.status === 'completed') { finishChatGptConnect(data); return; }
  stopChatGptConnectPoll();
  setPanelMsg(addFlow(), data.message || data.error || 'The sign-in failed.', 'err');
}

async function submitChatGptConnect() {
  var current = activeChatGptConnect;
  var flow = addFlow();
  if (!current || !flow) return;
  var input = flow.querySelector('.login-input');
  var value = input ? input.value.trim() : '';
  if (!value) { setPanelMsg(flow, 'Paste the address the sign-in tab ended on first.', 'err'); return; }
  setPanelMsg(flow, 'Connecting\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/complete', { connectId: current.connectId, url: value });
  if (!reply) { setPanelMsg(flow, 'Could not reach Meridian.', 'err'); return; }
  if (activeChatGptConnect !== current) return;
  if (!reply.res.ok) {
    if (!reply.data.retryable) stopChatGptConnectPoll();
    setPanelMsg(flow, reply.data.error || 'The sign-in failed.', 'err');
    return;
  }
  finishChatGptConnect(reply.data);
}

// Tells Meridian the sign-in is abandoned, so it stops polling for a device
// code and closes the 127.0.0.1:1455 listener now rather than at its expiry.
async function releaseChatGptConnect() {
  var current = activeChatGptConnect;
  stopChatGptConnectPoll();
  activeChatGptConnect = null;
  if (current) await postChatGptConnect('/profiles/chatgpt/connect/cancel', { connectId: current.connectId });
}

async function cancelChatGptConnect() {
  var name = activeChatGptConnect ? activeChatGptConnect.name : addName();
  await releaseChatGptConnect();
  resetAddForm(name);
}

async function switchChatGptToRedirect() {
  await releaseChatGptConnect();
  startChatGptRedirect('');
}

// --- Signing a seat in again, from its card ---
//
// The add flow's sign-in, aimed at one seat: Meridian refuses the result
// unless ChatGPT hands back that same account and workspace, so the seat keeps
// its id, order, former names and overrides. The panel lives in the card's
// login slot inside #content, so the card poll pauses while it is open.
var activeChatGptRelogin = null;
var chatGptReloginTimer = null;

function chatGptReloginPanel(id, note) {
  return {
    title: 'Sign ' + id + ' in again',
    account: 'the ChatGPT account and workspace ' + id + ' belongs to',
    note: note || '',
    inputId: 'chatgpt-relogin-paste',
    submitLabel: 'Sign in',
    onSubmit: 'submitChatGptRelogin()',
    onCancel: 'cancelChatGptRelogin()',
    onSwitch: 'switchChatGptReloginToRedirect()'
  };
}

function startChatGptRelogin(button) {
  var id = button.getAttribute('data-profile');
  if (activeChatGptRelogin) releaseChatGptRelogin();
  if (browserOnThisHost()) startChatGptReloginRedirect(id, '');
  else startChatGptReloginDevice(id);
}

async function startChatGptReloginDevice(id) {
  showLoginMessage(id, 'Starting\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/device', { profile: id });
  if (!reply) { showLoginMessage(id, 'Could not reach Meridian.', 'err'); return; }
  if (!reply.res.ok) {
    if (reply.data.code === 'unknown_profile' || reply.data.code === 'chatgpt_signin_unavailable') {
      showLoginMessage(id, reply.data.error || 'Could not start the sign-in.', 'err');
      return;
    }
    startChatGptReloginRedirect(id, (reply.data.error || 'The device sign-in is unavailable.') + ' Using the browser sign-in instead.');
    return;
  }
  activeChatGptRelogin = { profile: id, connectId: reply.data.connectId };
  var slot = loginSlot(id);
  if (slot) slot.innerHTML = renderChatGptDevicePanel(reply.data, chatGptReloginPanel(id, ''));
  scheduleChatGptReloginPoll();
}

async function startChatGptReloginRedirect(id, note) {
  showLoginMessage(id, 'Starting\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/start', {
    profile: id,
    returnTo: location.origin + '/profiles#' + encodeURIComponent(id)
  });
  if (!reply) { showLoginMessage(id, 'Could not reach Meridian.', 'err'); return; }
  if (!reply.res.ok) { showLoginMessage(id, reply.data.error || 'Could not start the sign-in.', 'err'); return; }
  activeChatGptRelogin = { profile: id, connectId: reply.data.connectId };
  var slot = loginSlot(id);
  if (slot) {
    slot.innerHTML = renderChatGptRedirectPanel(reply.data.authorizeUrl, reply.data.loopback, chatGptReloginPanel(id, note));
    var input = slot.querySelector('.login-input');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitChatGptRelogin(); });
  }
  window.open(reply.data.authorizeUrl, '_blank', 'noopener');
  scheduleChatGptReloginPoll();
}

function scheduleChatGptReloginPoll() {
  stopChatGptReloginPoll();
  chatGptReloginTimer = setTimeout(pollChatGptRelogin, 1500);
}

function stopChatGptReloginPoll() {
  if (chatGptReloginTimer) clearTimeout(chatGptReloginTimer);
  chatGptReloginTimer = null;
}

// A failed sign-in keeps its panel, and with it the paused card poll, so the
// reason stays on screen until Cancel closes it.
function failChatGptRelogin(current, message) {
  stopChatGptReloginPoll();
  current.spent = true;
  setPanelMsg(loginSlot(current.profile), message || 'The sign-in failed.', 'err');
}

async function pollChatGptRelogin() {
  var current = activeChatGptRelogin;
  if (!current || current.spent) return;
  var res, data;
  try {
    res = await fetch('/profiles/chatgpt/connect/status?connectId=' + encodeURIComponent(current.connectId));
    data = await res.json();
  } catch (err) {
    scheduleChatGptReloginPoll();
    return;
  }
  if (activeChatGptRelogin !== current) return;
  if (res.ok && (data.status === 'waiting' || data.status === 'exchanging')) { scheduleChatGptReloginPoll(); return; }
  if (res.ok && data.status === 'completed') { finishChatGptRelogin(data); return; }
  failChatGptRelogin(current, data.message || data.error);
}

async function submitChatGptRelogin() {
  var current = activeChatGptRelogin;
  var slot = current ? loginSlot(current.profile) : null;
  if (!current || current.spent || !slot) return;
  var input = slot.querySelector('.login-input');
  var value = input ? input.value.trim() : '';
  if (!value) { setPanelMsg(slot, 'Paste the address the sign-in tab ended on first.', 'err'); return; }
  setPanelMsg(slot, 'Signing in\\u2026', 'busy');
  var reply = await postChatGptConnect('/profiles/chatgpt/connect/complete', { connectId: current.connectId, url: value });
  if (activeChatGptRelogin !== current) return;
  if (!reply) { setPanelMsg(slot, 'Could not reach Meridian.', 'err'); return; }
  if (!reply.res.ok) {
    if (reply.data.retryable) setPanelMsg(slot, reply.data.error || 'The sign-in failed.', 'err');
    else failChatGptRelogin(current, reply.data.error);
    return;
  }
  finishChatGptRelogin(reply.data);
}

function finishChatGptRelogin(data) {
  var id = activeChatGptRelogin ? activeChatGptRelogin.profile : null;
  stopChatGptReloginPoll();
  activeChatGptRelogin = null;
  if (id) meridianCardStatus.beginUpdate(id);
  if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
  refresh().then(function () {
    if (id) showLoginMessage(id, 'Signed in again' + (data.email ? ' as ' + data.email : '') + '.', '');
  });
}

// Tells Meridian the sign-in is abandoned, so it stops polling for a device
// code and closes the 127.0.0.1:1455 listener now rather than at its expiry.
function releaseChatGptRelogin() {
  var current = activeChatGptRelogin;
  stopChatGptReloginPoll();
  activeChatGptRelogin = null;
  if (!current) return Promise.resolve();
  var slot = loginSlot(current.profile);
  if (slot) slot.innerHTML = '';
  return postChatGptConnect('/profiles/chatgpt/connect/cancel', { connectId: current.connectId });
}

function cancelChatGptRelogin() {
  releaseChatGptRelogin();
}

async function switchChatGptReloginToRedirect() {
  var id = activeChatGptRelogin ? activeChatGptRelogin.profile : null;
  await releaseChatGptRelogin();
  if (id) startChatGptReloginRedirect(id, '');
}

async function renewChatGptSeat(button) {
  var id = button.getAttribute('data-profile');
  button.disabled = true;
  button.textContent = 'Renewing\\u2026';
  var res, data;
  try {
    res = await fetch('/profiles/chatgpt/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: id })
    });
    data = await res.json();
  } catch (err) {
    data = { error: 'Could not reach Meridian.' };
  }
  var text = res && res.ok && data.status === 'refreshed'
    ? 'Renewed; valid until ' + new Date(data.expiresAt).toLocaleString() + '.'
    : (data.error || ('Not renewed: ' + (data.reason || data.status || 'unknown') + '.'));
  showLoginMessage(id, text, res && res.ok ? '' : 'err');
  button.disabled = false;
  button.textContent = 'Renew now';
}

meridianReorder.init({ onSaved: refresh });
refresh();
if (!restorePendingAdd()) resetAddForm('');
// A poll re-renders every card, so it must not land while one is being
// operated on: mid-drag it replaces the cards being dragged, and mid-login or
// mid-add it wipes the panel the code is being pasted into. Each panel keeps
// its own state, so each needs its own term - resetAddForm nulls activeAdd,
// which is the addId the paste is about to be sent with. A hidden tab skips
// polls and catches up when it is shown again.
function pollRefresh() {
  if (document.visibilityState !== 'visible' || meridianReorder.dragging()
    || activeLogin || activeAdd || activeChatGptRelogin) return;
  refresh();
}
// The 1.5s poll while a card updates: a hidden tab keeps the timer, not the
// request, so the update resumes within 1.5s of the tab being shown again.
function pollUpdate() {
  if (document.visibilityState !== 'visible') {
    updatePollTimer = setTimeout(pollUpdate, 1500);
    return;
  }
  updatePollTimer = null;
  refresh();
}
setInterval(pollRefresh, 10000);
document.addEventListener('visibilitychange', pollRefresh);
` + profileBarJs + `
</script>
</body>
</html>`
