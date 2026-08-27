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
  .profile-card-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .icon-btn {
    background: var(--bg); color: var(--muted); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; cursor: pointer; display: inline-flex;
    align-items: center; transition: all 0.15s;
  }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
  .rename-input {
    background: var(--surface2); color: var(--text); border: 1px solid var(--accent);
    border-radius: 6px; padding: 4px 8px; font-size: 14px; font-weight: 600;
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; width: 200px;
  }
  .rename-input:focus { outline: none; }
  .rename-hint { font-size: 11px; color: var(--muted); }
  .rename-error { font-size: 12px; color: var(--red); margin-bottom: 12px; }
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
      <li>Open a terminal and run: <code>meridian profile add &lt;name&gt;</code></li>
      <li>This opens your browser for Claude login</li>
      <li>Done \u2014 the profile is ready to use</li>
    </ol>

    <div class="warn">
      <strong>\u26a0 Important for adding a second account:</strong> Before running
      <code>meridian profile add</code> for a different account, sign out of claude.ai
      in your browser first, then sign in with the other account. Claude\u2019s OAuth
      reuses your browser session \u2014 if you\u2019re already signed in, the login will
      silently use the same account.
    </div>

    <h3 style="margin-top:16px">Switching profiles</h3>
    <ol>
      <li><strong>UI:</strong> Click an account card on the <a href="/" style="color:var(--accent)">home page</a>, or the Switch button on this page</li>
      <li><strong>CLI:</strong> <code>meridian profile switch &lt;name&gt;</code></li>
      <li><strong>Per-request:</strong> Send <code>x-meridian-profile: &lt;name&gt;</code> header</li>
    </ol>

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
    lastProfiles = profiles;
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
      + '<p style="margin-top:8px">Add your first profile from the terminal:</p>'
      + '<p style="margin-top:8px"><code class="mono" style="background:var(--bg);padding:8px 16px;border-radius:6px;display:inline-block">meridian profile add personal</code></p>'
      + '</div>';
    return;
  }

  let html = '<div class="section"><div class="section-title">Configured Profiles</div>';

  for (const p of profiles) {
    const isActive = p.id === active;
    html += '<div class="profile-card' + (isActive ? ' active' : '') + '">';
    html += '<div class="profile-card-header">';
    if (editingProfile === p.id) {
      html += '<input class="rename-input" id="rename-input" value="' + esc(p.id) + '" spellcheck="false" autocomplete="off"'
        + ' onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();commitRename(&quot;' + esc(p.id) + '&quot;)}'
        + 'else if(event.key===&quot;Escape&quot;){cancelRename()}">';
      html += '<span class="rename-hint">Enter to save \u00b7 Esc to cancel</span>';
      html += '<span class="profile-card-actions">';
      html += '<button class="icon-btn" title="Save new name" onclick="commitRename(&quot;'+esc(p.id)+'&quot;)">' + ICON_CHECK + '</button>';
      html += '<button class="icon-btn" title="Cancel" onclick="cancelRename()">' + ICON_X + '</button>';
      html += '</span>';
    } else {
      html += '<span class="profile-name">' + esc(p.id) + '</span>';
      if (isActive) html += '<span class="profile-badge badge-active">active</span>';
      html += '<span class="profile-badge badge-type">' + esc(p.type || 'claude-max') + '</span>';
      html += '<span class="profile-card-actions">';
      html += '<button class="icon-btn" title="Rename profile" onclick="startRename(&quot;'+esc(p.id)+'&quot;)">' + ICON_PENCIL + '</button>';
      html += '</span>';
    }
    html += '</div>';

    if (editingProfile === p.id && renameError) {
      html += '<div class="rename-error">' + esc(renameError) + '</div>';
    }

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
    if (p.aliases && p.aliases.length > 0) {
      html += '<span class="detail-label">Former names</span>';
      html += '<span class="detail-value" title="Requests naming these are served by this profile, until the name is added again">'
        + p.aliases.map(esc).join(', ') + '</span>';
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
    html += '</div>';

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

refresh();
setInterval(refresh, 10000);
` + profileBarJs + `
</script>
</body>
</html>`
