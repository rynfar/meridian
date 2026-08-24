/**
 * Inline HTML dashboard for telemetry.
 * No framework, no build step, no CDN. Single self-contained page.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Telemetry</title>
<link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
  ${themeCss}
  :root { --total: var(--accent); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); padding: 0; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 28px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card-detail { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--muted);
                   text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface);
          border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: var(--bg); color: var(--muted);
       font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .waterfall { display: flex; align-items: center; height: 18px; min-width: 200px; position: relative; }
  .waterfall-seg { height: 100%; border-radius: 2px; min-width: 2px; }
  .waterfall-seg.queue { background: var(--queue); }
  .waterfall-seg.overhead { background: var(--yellow); }
  .waterfall-seg.response { background: var(--upstream); }
  .legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 12px; color: var(--muted); }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }
  .status-ok { color: var(--green); }
  .status-err { color: var(--red); }
  .pct-table td:first-child { font-weight: 500; }
  .pct-table .phase-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }
  .refresh-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .refresh-bar select, .refresh-bar button {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .refresh-bar button:hover { border-color: var(--accent); }
  .refresh-indicator { font-size: 11px; color: var(--muted); }
  .retention { font-size: 11px; color: var(--muted); margin: -8px 0 16px; }
  .empty { text-align: center; padding: 48px; color: var(--muted); }

  /* Tabs */
  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 10px 20px; font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer;
         border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s;
         user-select: none; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
               background: var(--border); color: var(--muted); font-variant-numeric: tabular-nums; }
  .tab.active .tab-badge { background: rgba(88,166,255,0.15); color: var(--accent); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Log filters */
  .log-filters { display: flex; gap: 8px; margin-bottom: 12px; }
  .log-filter { font-size: 11px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
                border: 1px solid var(--border); background: var(--surface); color: var(--muted);
                transition: all 0.15s; }
  .log-filter:hover { border-color: var(--accent); color: var(--text); }
  .log-filter.active { background: rgba(88,166,255,0.1); border-color: var(--accent); color: var(--accent); }
  .usage-note { font-size: 11px; color: var(--muted); }

` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div style="padding:24px">
<h1>Telemetry</h1>
<div class="subtitle">Request performance, cost, and wire-contract integrity</div>

<div class="refresh-bar">
  <select id="window">
    <option value="300000">Last 5 min</option>
    <option value="900000">Last 15 min</option>
    <option value="3600000" selected>Last 1 hour</option>
    <option value="86400000">Last 24 hours</option>
  </select>
  <button onclick="refresh()">Refresh</button>
  <label><input type="checkbox" id="autoRefresh" checked> Auto (5s)</label>
  <span class="refresh-indicator" id="lastUpdate"></span>
</div>

<div class="retention" id="retention"></div>

<div id="content"><div class="empty">Loading…</div></div>

<script>
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let timer;
let activeTab = 'requests';
let activeLogFilter = 'all';



function ms(v) {
  if (v == null) return '—';
  if (v < 1000) return v + 'ms';
  return (v / 1000).toFixed(1) + 's';
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

function fmtTok(n) {
  return n > 1000000 ? (n/1000000).toFixed(1) + 'M' : n > 1000 ? Math.round(n/1000) + 'k' : String(n);
}

// Model names come from client-supplied request bodies (requestModel) — escape
// before concatenating into innerHTML so a quirky/malicious client can't
// script the dashboard.
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function usd(v) {
  if (v == null) return '—';
  if (v > 0 && v < 0.01) return '$' + v.toFixed(4);
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + Math.round(v).toLocaleString();
}

function pctRow(label, color, phase) {
  return '<tr>'
    + '<td><span class="phase-dot" style="background:' + color + '"></span>' + label + '</td>'
    + '<td class="mono">' + ms(phase.p50) + '</td>'
    + '<td class="mono">' + ms(phase.p95) + '</td>'
    + '<td class="mono">' + ms(phase.p99) + '</td>'
    + '<td class="mono">' + ms(phase.min) + '</td>'
    + '<td class="mono">' + ms(phase.max) + '</td>'
    + '<td class="mono">' + ms(phase.avg) + '</td>'
    + '</tr>';
}

function switchTab(tab) {
  activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

function setLogFilter(filter) {
  activeLogFilter = filter;
  $$('.log-filter').forEach(f => f.classList.toggle('active', f.dataset.filter === filter));
  $$('.log-row').forEach(r => {
    r.style.display = (filter === 'all' || r.dataset.category === filter) ? '' : 'none';
  });
}

async function refresh() {
  const w = $('#window').value;
  try {
    const [summary, reqs, logs, routes, health, retention] = await Promise.all([
      fetch('/telemetry/summary?window=' + w).then(r => r.json()),
      fetch('/telemetry/requests?limit=50&since=' + (Date.now() - Number(w))).then(r => r.json()),
      fetch('/telemetry/logs?limit=200&since=' + (Date.now() - Number(w))).then(r => r.json()),
      fetch('/telemetry/routes?window=' + w).then(r => r.json()),
      // Lives on the proxy app, not under /telemetry, so it is absent when the
      // telemetry routes are mounted standalone. The accounts table degrades to
      // "no live state known" rather than failing the whole refresh.
      fetch('/profiles/health').then(r => r.json()).catch(function() { return null; }),
      fetch('/telemetry/retention').then(r => r.json()),
    ]);
    render(summary, reqs, logs, routes, health);
    renderRetention(retention);
    $('#lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#content').innerHTML = '<div class="empty">Failed to load telemetry</div>';
  }
}

function bytes(n) {
  if (n == null) return null;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// How far back the data actually goes. Null when the store is empty, which is
// NOT the same as zero coverage — an empty store constrains no window, whereas
// a store holding 40 minutes makes every longer window a partial answer.
function coverageMs(r) {
  return (r && r.oldestTimestamp) ? Date.now() - r.oldestTimestamp : null;
}

// One line saying what the page can actually show you. The window selector
// offers 24 hours against a ring buffer that is well under an hour of traffic
// here, and until this line existed the page looked identical whether a window
// was empty because nothing happened or because the rows were overwritten.
function renderRetention(r) {
  var el = $('#retention');
  if (!el || !r) return;
  var parts = [];
  var span = coverageMs(r);
  if (r.kind === 'sqlite') {
    parts.push(r.held.toLocaleString() + ' request' + (r.held === 1 ? '' : 's') + ' in SQLite');
    if (r.retentionDays != null) parts.push(r.retentionDays + 'd retention');
    if (span != null) parts.push('back to ' + ago(r.oldestTimestamp).replace(' ago', ''));
    var size = bytes(r.dbBytes);
    if (size) parts.push(size);
    parts.push('survives restart');
  } else {
    parts.push(r.held.toLocaleString() + (r.capacity != null ? ' of ' + r.capacity.toLocaleString() : '') + ' requests in memory');
    if (span != null) parts.push('back to ' + ago(r.oldestTimestamp).replace(' ago', ''));
    // Named because it is the surprising half: a dashboard that has been
    // reporting all day still starts from nothing after a restart, and the
    // fix — MERIDIAN_TELEMETRY_PERSIST — is not discoverable from the page.
    parts.push('lost on restart');
  }
  el.textContent = parts.join(' · ');
  el.title = r.kind === 'sqlite'
    ? 'Persistent telemetry at ' + r.dbPath
    : 'In-memory ring buffer. Set MERIDIAN_TELEMETRY_PERSIST=1 to keep telemetry across restarts.';
  annotateWindows(r);
}

// Mark the windows this store cannot fill. Deliberately NOT disabled: the data
// grows, a partial answer is still an answer, and a selector that refuses the
// option a user wants is worse than one that tells them what they will get.
function annotateWindows(r) {
  var span = coverageMs(r);
  var sel = $('#window');
  if (!sel) return;
  for (var i = 0; i < sel.options.length; i++) {
    var opt = sel.options[i];
    if (!opt.dataset.label) opt.dataset.label = opt.textContent;
    var short = span != null && Number(opt.value) > span;
    opt.textContent = opt.dataset.label + (short ? ' — only ' + ago(r.oldestTimestamp).replace(' ago', '') + ' held' : '');
    opt.style.color = short ? 'var(--muted)' : '';
  }
}

// Colour groups by family — the pool modes share one, the internal hops
// another — and the badge TEXT carries which mode it actually was. Giving
// active+priority its own colour would imply a difference in kind where the
// difference is only in what sits at the head of the pool.
var ROUTE_KIND_COLOR = {
  pinned: 'var(--blue)',
  active: 'var(--muted)',
  sticky: 'var(--purple)',
  priority: 'var(--yellow)',
  'active+priority': 'var(--yellow)',
  'priority-hop': 'var(--muted)',
  'active+priority-hop': 'var(--muted)',
};

// routeChain arrives oldest attempt first; the last entry is the one that answered.
function routeHtml(r) {
  var badge = r.routeKind
    ? '<br><span style="font-size:9px;padding:1px 5px;border-radius:3px;background:'
      + (ROUTE_KIND_COLOR[r.routeKind] || 'var(--muted)') + ';color:var(--bg)">' + esc(r.routeKind) + '</span>'
    : '';
  if (r.routeChain && r.routeChain.length > 0) {
    return r.routeChain.map(function(h) {
      var why = h.error || ('status ' + h.status);
      if (h.refusedBucket) why += ' · ' + h.refusedBucket;
      return '<span style="color:' + (h.ok ? 'var(--green)' : 'var(--red)') + '" title="'
        + esc(why) + '">' + esc(h.profileId) + (h.ok ? ' ✓' : ' ✗') + '</span>';
    }).join('<span style="color:var(--muted)"> → </span>') + badge;
  }
  var refused = r.routeRefusedBucket
    ? ' <span style="color:var(--red);font-size:10px" title="the allowance Anthropic refused on">'
      + esc(r.routeRefusedBucket) + '</span>'
    : '';
  return (r.profileId ? esc(r.profileId) : '—') + refused + badge;
}

function until(ts) {
  if (ts == null) return '';
  var sec = Math.round((ts - Date.now()) / 1000);
  if (sec <= 0) return 'any moment';
  if (sec < 60) return 'in ' + sec + 's';
  if (sec < 3600) return 'in ' + Math.round(sec/60) + 'm';
  if (sec < 86400) return 'in ' + Math.round(sec/3600) + 'h';
  return 'in ' + Math.round(sec/86400) + 'd';
}

// Shown only once more than one account is in play: with a single account
// there is nothing to fail over TO, so a permanent "0" would be noise.
function failoverCard(routes) {
  if (!routes || !routes.requests) return '';
  var accounts = Object.keys(routes.byProfile || {}).length;
  if (routes.failedOver === 0 && routes.unserved === 0 && accounts < 2) return '';
  var pct = ((routes.failedOver / routes.requests) * 100).toFixed(1);
  return '<div class="card"><div class="card-label">Failovers</div>'
    + '<div class="card-value" style="color:' + (routes.failedOver > 0 ? 'var(--yellow)' : 'var(--green)') + '">' + routes.failedOver + '</div>'
    // Names its own denominator on purpose: the Requests card beside it counts
    // one per internal hop, so a failover is 2 there and 1 here. Saying just
    // "% of requests" next to a larger Requests number reads as broken maths.
    + '<div class="card-detail">' + pct + '% of ' + routes.requests + ' client request' + (routes.requests === 1 ? '' : 's')
    + (routes.unserved > 0 ? ' · ' + routes.unserved + ' unserved' : '')
    + '</div></div>';
}

// One row per account that did anything this window, or that is in trouble
// right now. Three independent sources keyed by profile id: the route tally
// (served/refused), the cost rollup, and the live spent/benched state.
function accountsHtml(routes, s, health) {
  var cost = (s.costEstimate && s.costEstimate.byProfile) || {};
  var tally = (routes && routes.byProfile) || {};
  var spent = {}, benched = {};
  if (health) {
    (health.spent || []).forEach(function(x) { spent[x.profileId] = x; });
    (health.exhausted || []).forEach(function(x) { benched[x.id] = x; });
  }

  var ids = {};
  [tally, cost, spent, benched].forEach(function(src) {
    Object.keys(src).forEach(function(k) { ids[k] = 1; });
  });
  var list = Object.keys(ids);
  if (list.length === 0) return '';

  var anyTrouble = list.some(function(id) {
    return (tally[id] && tally[id].refused > 0) || spent[id] || benched[id];
  });
  // A single-account setup with nothing wrong learns nothing from this table.
  if (list.length < 2 && !anyTrouble) return '';

  list.sort(function(a, b) {
    return ((tally[b] && tally[b].served) || 0) - ((tally[a] && tally[a].served) || 0)
      || ((tally[b] && tally[b].refused) || 0) - ((tally[a] && tally[a].refused) || 0)
      || a.localeCompare(b);
  });

  var html = '<div class="section"><div class="section-title">Accounts</div>'
    + '<table><thead><tr><th>Account</th><th>Served</th><th>Refused</th><th>Refused on</th>'
    + '<th>Est. Cost</th><th>State</th></tr></thead><tbody>';

  for (var i = 0; i < list.length; i++) {
    var id = list[i];
    var t = tally[id] || { served: 0, refused: 0, refusedBuckets: {} };
    var buckets = Object.keys(t.refusedBuckets || {}).map(function(b) {
      return esc(b) + ' ×' + t.refusedBuckets[b];
    }).join(', ');

    var state = '<span style="color:var(--muted)">—</span>';
    if (spent[id]) {
      var d = spent[id].diagnosis || {};
      state = '<span style="color:var(--red)" title="' + esc(d.rationale || '') + '">refusing'
        + (d.bucket ? ' (' + esc(d.bucket) + (d.reported ? '' : ', guess') + ')' : '')
        + '</span>'
        + (spent[id].until ? '<br><span style="font-size:10px;color:var(--muted)">back ' + until(spent[id].until) + '</span>' : '');
    } else if (benched[id]) {
      state = '<span style="color:var(--yellow)" title="' + esc(benched[id].reason || '') + '">benched</span>'
        + '<br><span style="font-size:10px;color:var(--muted)">back ' + until(benched[id].until) + '</span>';
    }

    html += '<tr>'
      + '<td>' + esc(id) + (health && health.activeProfile === id ? ' <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--blue);color:var(--bg)">active</span>' : '') + '</td>'
      + '<td class="mono">' + t.served + '</td>'
      + '<td class="mono"' + (t.refused > 0 ? ' style="color:var(--red)"' : '') + '>' + t.refused + '</td>'
      + '<td class="mono" style="font-size:11px;color:var(--muted)">' + (buckets || '—') + '</td>'
      + '<td class="mono">' + (cost[id] ? usd(cost[id].estimatedUsd) : '—') + '</td>'
      + '<td>' + state + '</td>'
      + '</tr>';
  }
  return html + '</tbody></table>'
    + '<div class="usage-note" style="margin-top:8px">Refusals include the ones a failover hid from the client,'
    + ' which never reach the client as an error and are counted nowhere else.</div></div>';
}

function render(s, reqs, logs, routes, health) {
  if (s.totalRequests === 0 && (!logs || logs.length === 0)) {
    $('#content').innerHTML = '<div class="empty">No requests recorded yet. Send a request through the proxy to see telemetry.</div>';
    return;
  }

  // Count lineage types for badges
  const lineageCounts = {};
  for (const r of reqs) { const t = r.lineageType || 'unknown'; lineageCounts[t] = (lineageCounts[t] || 0) + 1; }
  const logCounts = { session: 0, lineage: 0, error: 0, token: 0 };
  for (const l of logs) { if (logCounts[l.category] !== undefined) logCounts[l.category]++; }

  // Tabs
  let html = '<div class="tabs">'
    + '<div class="tab' + (activeTab === 'overview' ? ' active' : '') + '" data-tab="overview" onclick="switchTab(&apos;overview&apos;)">Overview</div>'
    + '<div class="tab' + (activeTab === 'requests' ? ' active' : '') + '" data-tab="requests" onclick="switchTab(&apos;requests&apos;)">'
    +   'Requests<span class="tab-badge">' + reqs.length + '</span></div>'
    + '<div class="tab' + (activeTab === 'logs' ? ' active' : '') + '" data-tab="logs" onclick="switchTab(&apos;logs&apos;)">'
    +   'Logs<span class="tab-badge">' + logs.length + '</span></div>'
    + '</div>';

  // ==================== Overview tab ====================
  html += '<div id="panel-overview" class="tab-panel' + (activeTab === 'overview' ? ' active' : '') + '">';

  // Summary cards
  html += '<div class="cards">'
    + card('Requests', s.totalRequests, s.requestsPerMinute.toFixed(1) + ' req/min')
    + card('Errors', s.errorCount, s.totalRequests > 0 ? ((s.errorCount/s.totalRequests)*100).toFixed(1) + '% error rate' : '')
    + failoverCard(routes)
    + '<div class="card"><div class="card-label">Envelope</div><div class="card-value" style="color:' + ((s.envelopeViolationCount || 0) > 0 ? 'var(--red)' : 'var(--green)') + '">' + (s.envelopeViolationCount || 0) + '</div><div class="card-detail">' + ((s.envelopeViolationCount || 0) > 0 ? 'wire-contract violations — check logs' : 'wire contract clean') + '</div></div>'
    + card('Median Total', ms(s.totalDuration.p50), 'p95: ' + ms(s.totalDuration.p95))
    + card('Median TTFB', ms(s.ttfb.p50), 'p95: ' + ms(s.ttfb.p95))
    + card('Proxy Overhead', ms(s.proxyOverhead.p50), 'p95: ' + ms(s.proxyOverhead.p95))
    + card('Queue Wait', ms(s.queueWait.p50), 'p95: ' + ms(s.queueWait.p95))
    + '</div>';

  html += accountsHtml(routes, s, health);

  // Token usage cards
  if (s.tokenUsage) {
    const t = s.tokenUsage;
    html += '<div class="section"><div class="section-title">Token Usage</div></div>';
    html += '<div class="cards">'
      + card('Input Tokens', fmtTok(t.totalInputTokens), '')
      + card('Output Tokens', fmtTok(t.totalOutputTokens), '')
      + card('Cache Read', fmtTok(t.totalCacheReadTokens), '')
      + card('Cache Write', fmtTok(t.totalCacheCreationTokens), '')
      + card('Avg Cache Hit', (t.avgCacheHitRate * 100).toFixed(0) + '%', t.cacheMissOnResumeCount > 0 ? t.cacheMissOnResumeCount + ' cache miss on resume' : '')
      + '</div>';
  }

  // Estimated cost: static API list pricing applied to the window's token usage
  if (s.costEstimate && Object.keys(s.costEstimate.byModel).length > 0) {
    const ce = s.costEstimate;
    const costRows = Object.entries(ce.byModel)
      .sort((a, b) => (b[1].estimatedUsd || 0) - (a[1].estimatedUsd || 0));

    html += '<div class="section"><div class="section-title">Estimated Cost</div></div>';
    html += '<div class="cards">'
      + card('Est. API Cost', usd(ce.totalUsd), 'window total at API list prices');
    for (const [model, m] of costRows) {
      html += card(esc(model), usd(m.estimatedUsd), m.requests + ' req' + (m.requests === 1 ? '' : 's'));
    }
    html += '</div>';

    html += '<div class="section">'
      + '<table><thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th>'
      + '<th>Cache Read</th><th>Cache Write</th><th>Est. Cost</th></tr></thead><tbody>';
    for (const [model, m] of costRows) {
      html += '<tr>'
        + '<td>' + esc(model) + (m.estimatedUsd == null ? ' <span style="font-size:10px;color:var(--yellow)">no pricing</span>' : '') + '</td>'
        + '<td class="mono">' + m.requests + '</td>'
        + '<td class="mono">' + fmtTok(m.inputTokens) + '</td>'
        + '<td class="mono">' + fmtTok(m.outputTokens) + '</td>'
        + '<td class="mono">' + fmtTok(m.cacheReadTokens) + '</td>'
        + '<td class="mono">' + fmtTok(m.cacheCreationTokens) + '</td>'
        + '<td class="mono">' + usd(m.estimatedUsd) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>'
      + '<div class="usage-note" style="margin-top:8px">Estimated at static Anthropic API list prices'
      + ' (cache writes at the 5-minute TTL rate). Claude Max usage is covered by your subscription'
      + ' (equivalent API cost, not a charge).'
      + (ce.unpricedRequestCount > 0
          ? ' ' + ce.unpricedRequestCount + ' request' + (ce.unpricedRequestCount === 1 ? '' : 's') + ' from unrecognized models excluded.'
          : '')
      + ' Rates are editable in <a href="/settings" style="color:var(--accent)">Settings</a>.'
      + '</div></div>';
  }

  // Model breakdown
  const models = Object.entries(s.byModel);
  if (models.length > 0) {
    html += '<div class="cards">';
    for (const [name, data] of models) {
      html += card(esc(name), data.count + ' reqs', 'avg ' + ms(data.avgTotalMs));
    }
    html += '</div>';
  }

  // Lineage breakdown
  if (Object.keys(lineageCounts).length > 0) {
    html += '<div class="cards">';
    const lineageColors = {continuation:'var(--green)',compaction:'var(--yellow)',undo:'var(--purple)',diverged:'var(--red)',new:'var(--muted)'};
    for (const [type, count] of Object.entries(lineageCounts)) {
      html += '<div class="card"><div class="card-label">Lineage: ' + type + '</div>'
        + '<div class="card-value" style="color:' + (lineageColors[type] || 'var(--text)') + '">' + count + '</div></div>';
    }
    html += '</div>';
  }

  // Percentile table
  html += '<div class="section"><div class="section-title">Percentiles</div>'
    + '<table class="pct-table"><thead><tr><th>Phase</th><th>p50</th><th>p95</th><th>p99</th><th>Min</th><th>Max</th><th>Avg</th></tr></thead><tbody>'
    + pctRow('Queue Wait', 'var(--queue)', s.queueWait)
    + pctRow('Session Queue', 'var(--queue)', s.sessionQueueWait)
    + pctRow('SDK Queue', 'var(--queue)', s.sdkQueueWait)
    + pctRow('Proxy Overhead', 'var(--yellow)', s.proxyOverhead)
    + pctRow('TTFB', 'var(--ttfb)', s.ttfb)
    + pctRow('Upstream', 'var(--upstream)', s.upstreamDuration)
    + pctRow('Total', 'var(--purple)', s.totalDuration)
    + '</tbody></table></div>';

  html += '</div>'; // end overview panel

  // ==================== Requests tab ====================
  html += '<div id="panel-requests" class="tab-panel' + (activeTab === 'requests' ? ' active' : '') + '">';

  html += '<div class="legend">'
    + '<span><span class="legend-dot" style="background:var(--queue)"></span>Queue</span>'
    + '<span><span class="legend-dot" style="background:var(--yellow)"></span>Proxy</span>'
    + '<span><span class="legend-dot" style="background:var(--upstream)"></span>Response</span>'
    + '</div>'
    + '<table><thead><tr><th>Time</th><th>Adapter</th><th>Route</th><th>Model</th><th>Mode</th><th>Session</th><th>Status</th>'
    + '<th>Queue</th><th>Proxy</th><th>TTFB</th><th>Total</th><th>Tokens</th><th>Cache</th><th>Waterfall</th></tr></thead><tbody>';

  const maxTotal = Math.max(...reqs.map(r => r.totalDurationMs), 1);

  for (const r of reqs) {
    const statusClass = r.error ? 'status-err' : 'status-ok';
    const statusText = r.error ? r.error : r.status;
    const scale = 280 / maxTotal;
    const sessionQW = r.sessionQueueWaitMs || 0;
    const sdkQW = r.sdkQueueWaitMs || 0;
    const qW = Math.max(r.queueWaitMs * scale, 2);
    const ohW = Math.max((r.proxyOverheadMs || 0) * scale, 0);
    const respW = Math.max(r.upstreamDurationMs * scale, 2);

    const lineageBadge = r.lineageType ? '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:' + ({continuation:'var(--green)',compaction:'var(--yellow)',undo:'var(--purple)',diverged:'var(--red)',new:'var(--muted)'}[r.lineageType] || 'var(--muted)') + ';color:var(--bg)">' + r.lineageType + '</span>' : '';
    const envBadge = (r.envelopeViolations && r.envelopeViolations.length > 0) ? ' <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--red);color:var(--bg)" title="' + r.envelopeViolations.join(', ') + '">envelope×' + r.envelopeViolations.length + '</span>' : '';
    const sessionShort = r.sdkSessionId ? r.sdkSessionId.slice(0, 8) : '—';
    const msgCount = r.messageCount != null ? r.messageCount : '?';

    const sourceBadge = r.requestSource ? '<br><span class="mono" style="font-size:9px;color:var(--violet)">' + r.requestSource + '</span>' : '';

    html += '<tr>'
      + '<td class="mono">' + ago(r.timestamp) + '</td>'
      + '<td>' + (r.adapter || '—') + sourceBadge + '</td>'
      + '<td>' + routeHtml(r) + '</td>'
      + '<td>' + (r.requestModel || r.model) + '<br><span style="font-size:10px;color:var(--muted)">' + r.model + '</span></td>'
      + '<td>' + r.mode + (r.hasDeferredTools ? (function() { var sessDisc = r.sessionDiscoveredCount || 0; var loaded = ((r.toolCount || 0) - (r.deferredToolCount || 0)) + sessDisc; var deferred = Math.max(0, (r.deferredToolCount || 0) - sessDisc); var newDisc = r.discoveredTools || []; return '<br><span style="font-size:10px;color:var(--purple)">loaded=' + loaded + ' deferred=' + deferred + '</span>' + (newDisc.length > 0 ? '<br><span style="font-size:10px;color:var(--green)">+' + newDisc.join(', +') + '</span>' : ''); })() : '') + '</td>'
      + '<td class="mono">' + sessionShort + ' ' + lineageBadge + envBadge + '<br><span style="font-size:10px;color:var(--muted)">' + msgCount + ' msgs</span></td>'
      + '<td class="' + statusClass + '">' + statusText + '</td>'
      + '<td class="mono">' + ms(r.queueWaitMs) + '<br><span style="font-size:9px;color:var(--muted)">session ' + ms(sessionQW) + ' / sdk ' + ms(sdkQW) + '</span></td>'
      + '<td class="mono">' + ms(r.proxyOverheadMs) + '</td>'
      + '<td class="mono">' + ms(r.ttfbMs) + '</td>'
      + '<td class="mono">' + ms(r.totalDurationMs) + '</td>'
      + '<td class="mono">' + (r.inputTokens != null ? (r.inputTokens > 1000 ? Math.round(r.inputTokens/1000) + 'k' : r.inputTokens) + ' in<br>' + (r.outputTokens > 1000 ? Math.round(r.outputTokens/1000) + 'k' : r.outputTokens || 0) + ' out' : '—') + '</td>'
      + '<td class="mono">' + (r.cacheHitRate != null ? '<span style="color:' + (r.cacheHitRate > 0.5 ? 'var(--green)' : r.cacheHitRate > 0 ? 'var(--yellow)' : 'var(--red)') + '">' + Math.round(r.cacheHitRate * 100) + '%</span>' : '—') + '</td>'
      + '<td><div class="waterfall" title="Queue, then proxy overhead, then upstream response. A request that replayed upstream sums every attempt into the response segment, while TTFB counts only the attempt that produced the first chunk.">'
      + '<div class="waterfall-seg queue" style="width:' + qW + 'px"></div>'
      + '<div class="waterfall-seg overhead" style="width:' + ohW + 'px"></div>'
      + '<div class="waterfall-seg response" style="width:' + respW + 'px"></div>'
      + '</div></td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  html += '</div>'; // end requests panel

  // ==================== Logs tab ====================
  html += '<div id="panel-logs" class="tab-panel' + (activeTab === 'logs' ? ' active' : '') + '">';

  // Filter buttons
  html += '<div class="log-filters">'
    + '<span class="log-filter' + (activeLogFilter === 'all' ? ' active' : '') + '" data-filter="all" onclick="setLogFilter(&apos;all&apos;)">All<span class="tab-badge">' + logs.length + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'session' ? ' active' : '') + '" data-filter="session" onclick="setLogFilter(&apos;session&apos;)" style="--accent:var(--blue)">Session<span class="tab-badge">' + logCounts.session + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'lineage' ? ' active' : '') + '" data-filter="lineage" onclick="setLogFilter(&apos;lineage&apos;)" style="--accent:var(--purple)">Lineage<span class="tab-badge">' + logCounts.lineage + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'error' ? ' active' : '') + '" data-filter="error" onclick="setLogFilter(&apos;error&apos;)" style="--accent:var(--red)">Error<span class="tab-badge">' + logCounts.error + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'token' ? ' active' : '') + '" data-filter="token" onclick="setLogFilter(&apos;token&apos;)" style="--accent:var(--yellow)">Token<span class="tab-badge">' + logCounts.token + '</span></span>'
    + '</div>';

  if (logs.length === 0) {
    html += '<div class="empty">No diagnostic logs in this time window.</div>';
  } else {
    html += '<table><thead><tr>'
      + '<th style="width:80px">Time</th><th style="width:55px">Level</th><th style="width:70px">Category</th><th>Message</th>'
      + '</tr></thead><tbody>';

    for (const log of logs) {
      const levelColor = {info:'var(--green)',warn:'var(--yellow)',error:'var(--red)'}[log.level] || 'var(--muted)';
      const catColor = {session:'var(--blue)',lineage:'var(--purple)',error:'var(--red)',lifecycle:'var(--muted)',token:'var(--yellow)'}[log.category] || 'var(--muted)';
      const display = (activeLogFilter === 'all' || log.category === activeLogFilter) ? '' : 'display:none';
      html += '<tr class="log-row" data-category="' + log.category + '" style="' + display + '">'
        + '<td class="mono">' + ago(log.timestamp) + '</td>'
        + '<td><span style="color:' + levelColor + '">' + log.level + '</span></td>'
        + '<td><span style="color:' + catColor + '">' + log.category + '</span></td>'
        + '<td class="mono" style="word-break:break-all">' + log.message + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>'; // end logs panel


  $('#content').innerHTML = html;
}

function card(label, value, detail) {
  return '<div class="card"><div class="card-label">' + label + '</div>'
    + '<div class="card-value">' + value + '</div>'
    + (detail ? '<div class="card-detail">' + detail + '</div>' : '')
    + '</div>';
}

$('#autoRefresh').addEventListener('change', function() {
  clearInterval(timer);
  if (this.checked) timer = setInterval(refresh, 5000);
});
$('#window').addEventListener('change', refresh);

refresh();
timer = setInterval(refresh, 5000);
` + profileBarJs + `
</script>
</body>
</html>`
