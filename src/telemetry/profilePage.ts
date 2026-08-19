/**
 * Profile management page.
 * Shows all configured profiles, their auth status, and setup instructions.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"
import { WINDOW_LABELS } from "./profileUsage"

export const profilePageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Profiles</title>
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

  .profile-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px; margin-bottom: 12px; transition: border-color 0.2s;
  }
  .profile-card.active { border-color: var(--accent); }
  .profile-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .profile-name { font-size: 16px; font-weight: 600; }
  .profile-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase;
    letter-spacing: 0.5px; font-weight: 500;
  }
  .badge-active { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-type { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
  .profile-details {
    display: grid; grid-template-columns: 120px 1fr; gap: 6px 16px; font-size: 13px;
  }
  .detail-label { color: var(--muted); }
  .detail-value { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }
  .status-ok { color: var(--green); }
  .status-err { color: var(--red); }
  .switch-btn {
    margin-top: 12px; padding: 6px 16px; font-size: 12px; font-weight: 500;
    background: var(--bg); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 6px; cursor: pointer; transition: all 0.15s;
  }
  .switch-btn:hover { background: rgba(88,166,255,0.1); }
  .switch-btn:disabled { opacity: 0.4; cursor: default; }
  .switch-btn.current { border-color: var(--border); color: var(--muted); cursor: default; }

  .empty-state {
    text-align: center; padding: 48px; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  }
  .empty-state h2 { font-size: 16px; margin-bottom: 8px; color: var(--text); }

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
    margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
  }
  .usage-as-of { font-size: 10px; color: var(--muted); text-transform: none; letter-spacing: 0; opacity: 0.7; }
  .usage-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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
  .usage-label { color: var(--muted); font-weight: 500; white-space: nowrap; }
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
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
<h1>Profiles</h1>
<div class="subtitle">Manage Claude account profiles</div>

<div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading\u2026</div></div>

<!-- Outside #content on purpose: render() rebuilds that element wholesale on
     every poll, which would destroy a half-typed name or a pasted code. -->
<div class="section">
  <div class="section-title">Add a profile</div>
  <div class="profile-card"><div id="add-slot"></div></div>
</div>

<div class="section" style="margin-top:32px">
  <div class="section-title">Setup Guide</div>
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
      <code>meridian profile remove &lt;name&gt;</code> \u2014 remove a profile
    </div>
  </div>
</div>
</div>

<script>
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

// Cache the last seen quota response so the /profiles/list refresh can
// keep showing usage even if a single /v1/usage/quota/all call fails.
var lastQuota = null;

async function refresh() {
  try {
    var [profilesRes, quotaRes] = await Promise.all([
      fetch('/profiles/list'),
      fetch('/v1/usage/quota/all').catch(function () { return null; }),
    ]);
    var profiles = await profilesRes.json();
    var quota = null;
    if (quotaRes && quotaRes.ok) {
      try { quota = await quotaRes.json(); } catch (_) { quota = null; }
    }
    if (quota) lastQuota = quota;
    render(profiles, lastQuota);
  } catch {
    document.getElementById('content').innerHTML = '<div class="empty-state"><h2>Could not load profiles</h2><p>Is Meridian running?</p></div>';
  }
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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

  if (windows.length === 0 && !extra) {
    if (profileQuota.error === 'no_token') {
      return '<div class="usage-section">'
        + '<div class="usage-section-title">Usage</div>'
        + '<div class="usage-empty">Run <code style="background:var(--bg);padding:1px 5px;border-radius:3px">claude login</code> to see usage.</div>'
        + '</div>';
    }
    // Credentials are fine here — Anthropic is throttling the usage endpoint
    // and the backoff has no snapshot left to serve. Saying "run claude login"
    // would send the user chasing a problem they don't have.
    if (profileQuota.error === 'rate_limited') {
      return '<div class="usage-section">'
        + '<div class="usage-section-title">Usage</div>'
        + '<div class="usage-empty">Usage data is rate limited upstream — retrying shortly.</div>'
        + '</div>';
    }
    return ''; // nothing fetched yet
  }

  var asOf = profileQuota.fetchedAt
    ? '<span class="usage-as-of">updated ' + timeAgo(profileQuota.fetchedAt) + '</span>'
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
      +   '<span class="usage-pct">' + pctRound + '%</span>'
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
      +     '<span class="usage-pct">' + extra.utilizationPct + '%</span>'
      +   '</div>'
      +   '<div class="usage-bar"><div class="usage-fill" style="width:' + extra.utilizationPct + '%"></div></div>'
      +   '<div class="usage-extra-row" style="margin-top:4px">'
      +     '<span class="usage-reset">' + esc(extra.used) + ' / ' + esc(extra.limit) + '</span>'
      +   '</div>'
      + '</div>';
  }

  return '<div class="usage-section">'
    + '<div class="usage-section-title">Usage' + asOf + '</div>'
    + (cards ? '<div class="usage-grid">' + cards + '</div>' : '')
    + extraBlock
    + '</div>';
}

function render(data, quotaData) {
  const profiles = data.profiles || [];
  const active = data.activeProfile;
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
    return;
  }

  let html = '<div class="section"><div class="section-title">Configured Profiles</div>';

  for (const p of profiles) {
    const isActive = p.id === active;
    html += '<div class="profile-card' + (isActive ? ' active' : '') + '">';
    html += '<div class="profile-card-header">';
    html += '<span class="profile-name">' + esc(p.id) + '</span>';
    if (isActive) html += '<span class="profile-badge badge-active">active</span>';
    html += '<span class="profile-badge badge-type">' + esc(p.type || 'claude-max') + '</span>';
    html += '</div>';

    html += '<div class="profile-details">';
    html += '<span class="detail-label">Status</span>';
    html += '<span class="detail-value ' + (p.loggedIn ? 'status-ok' : 'status-err') + '">'
      + (p.loggedIn ? '\u2713 Authenticated' : '\u2717 Not logged in') + '</span>';

    if (p.email) {
      html += '<span class="detail-label">Email</span>';
      html += '<span class="detail-value">' + esc(p.email) + '</span>';
    }
    if (p.subscriptionType) {
      html += '<span class="detail-label">Plan</span>';
      html += '<span class="detail-value">' + esc(p.subscriptionType) + '</span>';
    }
    if (p.lastSuccessAt) {
      html += '<span class="detail-label">Last Verified</span>';
      html += '<span class="detail-value" style="color:var(--green)">' + timeAgo(p.lastSuccessAt) + '</span>';
    }
    if (p.lastCheckedAt && (!p.lastSuccessAt || p.lastCheckedAt !== p.lastSuccessAt)) {
      html += '<span class="detail-label">Last Checked</span>';
      html += '<span class="detail-value">' + timeAgo(p.lastCheckedAt) + '</span>';
    }
    html += '</div>';

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

  html += '</div>';
  document.getElementById('content').innerHTML = html;
  // render() replaces #content wholesale, so the anchors are new elements with
  // whatever href the markup carried. Restore them from the cache, then top up
  // anything missing or near expiry in the background.
  applyLoginHrefs();
  ensureLoginLinks(profiles);
}

function timeAgo(ts) {
  if (!ts) return '\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

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
    if ((p.type || 'claude-max') !== 'claude-max') continue;
    var link = loginLinks[p.id];
    if (!link || link.expiresAt - Date.now() < 120000) due.push(p.id);
  }
  if (due.length === 0) return;

  // The first alone: a refusal about the INSTANCE (a read-only standby, no
  // profiles at all) would otherwise repeat once per card, and each one is a
  // logged refusal on the server.
  if (await mintLoginLink(due[0]) === 'blocked') { applyLoginHrefs(); return; }
  await Promise.all(due.slice(1).map(mintLoginLink));

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
  activeLogin = null;
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

refresh();
resetAddForm('');
setInterval(function () { if (!activeLogin) refresh(); }, 10000);
` + profileBarJs + `
</script>
</body>
</html>`
