/**
 * Profile management page.
 * Shows all configured profiles, their auth status, and setup instructions.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"
import { profileFactsJs } from "./profileFacts"
import { profileFindJs } from "./profileFind"
import { reorderClientJs, reorderCss, reorderLiveRegionHtml } from "./profileOrder"
import { WINDOW_LABELS } from "./profileUsage"

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
    padding: 20px; margin-bottom: 12px; transition: border-color 0.2s;
  }
  .profile-card[hidden] { display: none; }
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
  .profile-card.active { border-color: var(--accent); }
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
  .profile-name { font-size: 16px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .profile-card-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon-btn {
    background: var(--bg); color: var(--muted); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; cursor: pointer; display: inline-flex;
    align-items: center; transition: all 0.15s; flex-shrink: 0;
  }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
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
  .badge-active { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-type { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
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
  .switch-btn {
    margin-top: 12px; padding: 6px 16px; font-size: 12px; font-weight: 500;
    background: var(--bg); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 6px; cursor: pointer; transition: all 0.15s; max-width: 100%; overflow-wrap: anywhere;
  }
  .switch-btn:hover { background: rgba(88,166,255,0.1); }
  .switch-btn:disabled { opacity: 0.4; cursor: default; }
  .switch-btn.current { border-color: var(--border); color: var(--muted); cursor: default; }

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
  }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
<h1>Profiles</h1>
<div class="subtitle">Manage Claude account profiles</div>

<!-- The heading and search box sit outside #content, which render() rebuilds
     on every poll: a box inside it would lose its text every ten seconds. -->
<div class="section" id="profiles-section">
  <h2 class="section-title">Configured Profiles</h2>
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

${reorderClientJs}

// Cache the last seen quota response so the /profiles/list refresh can
// keep showing usage even if a single /v1/usage/quota/all call fails.
var lastQuota = null;
// Last profile payload, so a rename can redraw from cache without refetching.
var lastProfiles = null;
// Profile whose name is being edited in place, and the error from the last
// rejected attempt. While editing, the poll is suspended — it rewrites
// innerHTML, which would blank the input mid-keystroke.
var editingProfile = null;
var renameError = null;

var ICON_PENCIL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg>';
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

async function refresh() {
  if (editingProfile) return;
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
    if (quota) lastQuota = quota;
    if (routingRes && routingRes.ok) {
      try { meridianReorder.adopt(await routingRes.json()); } catch (_) { /* keep the last good order */ }
    }
    lastProfiles = profiles;
    render(profiles, lastQuota);
  } catch {
    document.getElementById('content').innerHTML = '<div class="empty-state"><h2>Could not load profiles</h2><p>Is Meridian running?</p></div>';
  }
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function factRows(facts) {
  return facts.map(function (f) {
    var tone = f.tone === 'ok' ? ' status-ok' : f.tone === 'err' ? ' status-err' : '';
    var title = f.title ? ' title="' + esc(f.title) + '"' : '';
    var cached = f.cached ? ' <span class="cached-tag">(cached)</span>' : '';
    return '<span class="detail-label">' + esc(f.label) + '</span>'
      + '<span class="detail-value' + tone + '"' + title + '>' + esc(f.value) + cached + '</span>';
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

function renderSpentNote(spent) {
  var s = spentSummary(spent);
  if (!s) return '';
  return '<div class="spent-note">'
    + '<strong style="color:var(--red)">\u26a0 Anthropic is refusing this account</strong> - '
    + 'out of <strong>' + esc(s.label) + '</strong>'
    + (s.reset ? ', expected back ' + esc(s.reset) : '')
    + '. Refused ' + esc(timeAgo(s.at)) + '.'
    + '<div class="spent-why">' + esc(s.why) + '. The percentages below are the last successful read, not live.</div>'
    + '</div>';
}

function renderUsageSection(profileQuota) {
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

  // No figures at all means this profile has never been read successfully —
  // the route serves the last good reading at any age, so an empty windows
  // array is no longer "the stale window lapsed". Saying so keeps it distinct
  // from a profile genuinely sitting at 0%.
  if (windows.length === 0 && !extra) {
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

  var asOf = profileQuota.fetchedAt
    ? '<span class="usage-as-of">updated ' + timeAgo(profileQuota.fetchedAt) + '</span>'
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
  const active = data.activeProfile;
  const refocusId = meridianReorder.focusAnchor();
  // Build quick lookup: profileId -> per-profile quota entry from
  // /v1/usage/quota/all. Endpoint may be unavailable (older Meridian)
  // or have errored — in that case quotaById is empty and the per-card
  // renderer simply hides its usage section.
  const quotaProfiles = (quotaData && Array.isArray(quotaData.profiles)) ? quotaData.profiles : [];
  const quotaById = {};
  for (var qi = 0; qi < quotaProfiles.length; qi++) {
    quotaById[quotaProfiles[qi].id] = quotaProfiles[qi];
  }

  if (profiles.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty-state">'
      + '<h2>No profiles configured</h2>'
      + '<p style="margin-top:8px">Add your first one below, or from a terminal:</p>'
      + '<p style="margin-top:8px"><code class="mono" style="background:var(--bg);padding:8px 16px;border-radius:6px;display:inline-block">meridian profile add personal</code></p>'
      + '</div>';
    afterRender();
    return;
  }

  const reorderable = profiles.length > 1 && !meridianReorder.envPinned();

  let html = '';
  if (profiles.length > 1) html += meridianReorder.noteHtml(reorderable);

  for (let idx = 0; idx < profiles.length; idx++) {
    const p = profiles[idx];
    const isActive = p.id === active;
    html += '<div class="profile-card' + (isActive ? ' active' : '') + '" id="' + esc(profileAnchorElementId(p.id)) + '" data-id="' + esc(p.id) + '" data-index="' + idx + '">';
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
      if (reorderable) html += meridianReorder.handleHtml(p.id, idx, profiles.length);
      html += "<a class=\\"profile-name\\" href=\\"#" + esc(encodeURIComponent(p.id)) + "\\" title=\\"Link to this profile\\">" + esc(p.id) + "</a>";
      if (isActive) html += "<span class=\\"profile-badge badge-active\\">active</span>";
      html += "<span class=\\"profile-badge badge-type\\">" + esc(p.type || "claude-max") + "</span>";
      html += renderSpentBadge((quotaById[p.id] || {}).spent);
      html += "<span class=\\"profile-card-actions\\">";
      html += "<button class=\\"icon-btn\\" title=\\"Rename profile\\" onclick=\\"startRename(&quot;"+esc(p.id)+"&quot;)\\">" + ICON_PENCIL + "</button>";
      html += "</span>";
    }
    html += '</div>';
    html += renderSpentNote((quotaById[p.id] || {}).spent);

    if (editingProfile === p.id && renameError) {
      html += '<div class="rename-error">' + esc(renameError) + '</div>';
    }

    html += '<div class="profile-details">' + factRows(profileFacts(p)) + '</div>';

    if (!p.loggedIn) {
      html += '<div style="margin-top:12px;padding:10px 14px;background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.3);border-radius:8px;font-size:12px">';
      html += '<strong style="color:var(--yellow)">\u26a0 Needs re-authentication</strong>';
      html += '</div>';
    }

    html += '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    html += '<span style="font-size:11px;color:var(--muted)">Login:</span> ';
    html += '<code class="copy-cmd">meridian profile login ' + esc(p.id) + '</code>';
    html += '<button class="copy-btn" data-cmd="meridian profile login ' + esc(p.id) + '" onclick="copyCmd(this)" title="Copy to clipboard">';
    html += '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>';
    html += '</button>';
    // Only claude-max profiles have an OAuth flow; api and oauth-token profiles
    // would only ever get a refusal, so they get no button.
    if ((p.type || 'claude-max') === 'claude-max') {
      // A real anchor with a real href, not a button. That is the only way the
      // browser offers "Open Link in Incognito Window" and "Copy Link Address"
      // — and someone signed into several Claude accounts needs those, because
      // the ambient session in their main browser is usually the wrong account
      // for the profile being re-authenticated. A button, or an anchor that
      // navigates from a click handler, gets no such menu.
      html += '<a class="login-btn login-link" data-profile="' + esc(p.id) + '"'
        + ' href="' + esc(loginHrefFor(p.id) || '#') + '"'
        + (loginHrefFor(p.id) ? '' : ' aria-disabled="true"')
        + ' target="_blank" rel="noopener noreferrer"'
        + ' onclick="return onLoginLinkClick(event, &quot;' + esc(p.id) + '&quot;)">Log in from browser</a>';
    }
    html += '</div>';

    html += '<div class="login-slot" id="login-slot-' + esc(p.id) + '"></div>';

    html += renderUsageSection(quotaById[p.id]);

    if (!isActive) {
      html += '<button class="switch-btn" onclick="switchProfile(&quot;'+esc(p.id)+'&quot;)">Switch to ' + esc(p.id) + '</button>';
    } else {
      html += '<button class="switch-btn current" disabled>Currently active</button>';
    }

    html += '</div>';
  }

  // A refresh already in flight when a login panel opened still renders. Carry
  // the open panel's node across so the paste, and its focus, survive.
  var keptSlot = activeLogin ? loginSlot(activeLogin.profile) : null;
  var keptFocus = keptSlot && keptSlot.contains(document.activeElement) ? document.activeElement : null;
  document.getElementById('content').innerHTML = html;
  var freshSlot = keptSlot ? loginSlot(activeLogin.profile) : null;
  if (freshSlot) freshSlot.replaceWith(keptSlot);
  meridianReorder.restoreFocus(refocusId);
  afterRender();
  if (freshSlot && keptFocus) keptFocus.focus();
  // render() replaces #content wholesale, so the anchors are new elements with
  // whatever href the markup carried. Restore them from the cache, then top up
  // anything missing or near expiry in the background.
  applyLoginHrefs();
  ensureLoginLinks(profiles);
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

function applyProfileFilter() {
  var profiles = profilesForFind();
  var byId = Object.create(null);
  for (var i = 0; i < profiles.length; i++) byId[profiles[i].id] = profiles[i];
  var cards = document.querySelectorAll('#content .profile-card[data-id]');
  var shown = 0;
  for (var c = 0; c < cards.length; c++) {
    var match = profileMatchesQuery(byId[cards[c].getAttribute('data-id')], profileQuery);
    cards[c].hidden = !match;
    if (match) shown++;
  }
  var filtering = profileQueryTerms(profileQuery).length > 0;
  document.getElementById('profiles-section').classList.toggle('filtering', filtering);
  document.getElementById('profiles-filter-bar').hidden = cards.length === 0 && !filtering;
  var paused = filtering && document.querySelector('#content .drag-handle') ? ' \u00b7 clear to reorder' : '';
  document.getElementById('profiles-filter-count').textContent = filtering
    ? shown + ' of ' + cards.length + paused
    : '';
  document.getElementById('profiles-no-match-query').textContent = profileQuery.trim();
  document.getElementById('profiles-no-match').hidden = !(filtering && cards.length > 0 && shown === 0);
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
  // Following a link to one profile outranks a filter that hides it.
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
})();

function copyCmd(btn) {
  var cmd = btn.getAttribute('data-cmd');
  navigator.clipboard.writeText(cmd);
  btn.classList.add('copied');
  btn.innerHTML = '\u2713';
  setTimeout(function() {
    btn.classList.remove('copied');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25zM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>';
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
var loginLinks = {};
// Whether this browser can reach Meridian on loopback. A fact about the
// BROWSER, not about any one profile, so it is answered once for the page.
var loopbackOk = null;
// Set when the refusal is about the instance rather than a profile.
var loginBlocked = null;
// Cards whose link is being minted right now, so a render landing mid-mint
// does not start a second login for the same card.
var mintingLinks = {};

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
  if (finished) retireLoginLink(finished);
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

function renderAddForm(prefill) {
  return '<div class="add-intro">Sign in to another Claude account and keep it here alongside the others.</div>'
    + '<div class="login-row">'
    +   '<input class="login-input add-input" type="text" autocomplete="off" spellcheck="false"'
    +     ' placeholder="new profile name" value="' + esc(prefill || '') + '">'
    +   '<button class="login-btn" onclick="startAdd()">Add profile</button>'
    + '</div>'
    + '<div class="add-note">Letters, numbers, hyphens and underscores.</div>'
    + '<div class="login-msg"></div>';
}

function resetAddForm(prefill) {
  activeAdd = null;
  var slot = addSlot();
  if (!slot) return;
  slot.innerHTML = renderAddForm(prefill);
  var input = slot.querySelector('.add-input');
  if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') startAdd(); });
}

function renderAddPanel(id, authorizeUrl) {
  return renderOauthPanel({
    title: 'Create ' + esc(id),
    authorizeUrl: authorizeUrl,
    accountStep: 'Sign in with the Claude account this profile should use \u2014 if a different account is already '
      + 'signed in at claude.ai, sign out there first, or Claude will reuse it without asking.',
    submitLabel: 'Create profile',
    onSubmit: 'submitAdd()',
    onCancel: 'cancelAdd()',
  });
}

async function startAdd() {
  var slot = addSlot();
  if (!slot) return;
  var nameInput = slot.querySelector('.add-input');
  var name = nameInput ? nameInput.value.trim() : '';
  if (!name) { setPanelMsg(slot, 'Name the profile first.', 'err'); return; }

  setPanelMsg(slot, 'Starting\u2026', 'busy');

  var res, data;
  try {
    res = await fetch('/profiles/add/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: name })
    });
    data = await res.json();
  } catch (err) {
    setPanelMsg(slot, 'Could not reach Meridian.', 'err');
    return;
  }

  // The form is left standing on a refusal, name and all: every refusal here
  // is about the name, and retyping it to fix a typo is the wrong ask.
  if (!res.ok) { setPanelMsg(slot, data.error || 'Could not start.', 'err'); return; }

  activeAdd = { profile: name, addId: data.addId };
  slot.innerHTML = renderAddPanel(name, data.authorizeUrl);
  var codeInput = slot.querySelector('.login-input');
  if (codeInput) {
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAdd(); });
    codeInput.focus();
  }
  window.open(data.authorizeUrl, '_blank', 'noopener');
}

async function submitAdd() {
  if (!activeAdd || activeAdd.spent) return;
  var slot = addSlot();
  var input = slot ? slot.querySelector('.login-input') : null;
  var value = input ? input.value.trim() : '';
  if (!value) { setPanelMsg(slot, 'Paste the code first.', 'err'); return; }

  var buttons = slot ? slot.querySelectorAll('button') : [];
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  setPanelMsg(slot, 'Creating\u2026', 'busy');

  var res, data;
  try {
    res = await fetch('/profiles/add/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addId: activeAdd.addId, code: value })
    });
    data = await res.json();
  } catch (err) {
    setPanelMsg(slot, 'Could not reach Meridian.', 'err');
    for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    return;
  }

  if (!res.ok) {
    setPanelMsg(slot, data.error || 'Could not create the profile.', 'err');
    var cancelBtn = slot ? slot.querySelector('.login-cancel') : null;
    if (cancelBtn) cancelBtn.disabled = false;
    if (data.retryable) {
      var submitBtn = slot ? slot.querySelector('.login-submit') : null;
      if (submitBtn) submitBtn.disabled = false;
      if (input) input.focus();
    } else {
      // The code is spent. Keep the panel so the reason stays readable —
      // Cancel is the way back to the form.
      activeAdd.spent = true;
    }
    return;
  }

  resetAddForm('');
  if (window.meridianHeaderRefresh) window.meridianHeaderRefresh();
  refresh();
}

function cancelAdd() {
  // Keeps the name. Abandoning a sign-in almost always means the wrong Claude
  // account was signed in, not that the name was wrong.
  resetAddForm(activeAdd ? activeAdd.profile : '');
}

meridianReorder.init({ onSaved: refresh });
refresh();
resetAddForm('');
setInterval(function () { if (!activeLogin && !meridianReorder.dragging()) refresh(); }, 10000);
` + profileBarJs + `
</script>
</body>
</html>`
