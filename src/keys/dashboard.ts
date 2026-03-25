/**
 * Admin dashboard — inline HTML for API key management.
 * Self-contained, no CDN, no build step.
 */

export const adminDashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Admin</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }

  .auth-gate { max-width: 400px; margin: 80px auto; text-align: center; }
  .auth-gate input { width: 100%; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border);
                     border-radius: 8px; color: var(--text); font-size: 14px; margin: 12px 0; }
  .auth-gate input:focus { outline: none; border-color: var(--accent); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 28px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }

  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
  .toolbar input { flex: 1; max-width: 300px; padding: 8px 12px; background: var(--surface);
                   border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 13px; }
  .toolbar input:focus { outline: none; border-color: var(--accent); }

  button { padding: 8px 16px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer;
           font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-primary:hover { opacity: 0.9; }
  .btn-danger { background: transparent; color: var(--red); border-color: var(--red); }
  .btn-danger:hover { background: var(--red); color: #fff; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-ghost { background: transparent; color: var(--muted); border-color: var(--border); }
  .btn-ghost:hover { color: var(--text); border-color: var(--text); }

  table { width: 100%; border-collapse: collapse; background: var(--surface);
          border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: var(--bg); color: var(--muted);
       font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  tr:hover td { background: rgba(88,166,255,0.04); }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-red { background: rgba(248,81,73,0.15); color: var(--red); }

  .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }
  .empty { text-align: center; padding: 48px; color: var(--muted); }

  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-inner-spin-button,
  input[type=number]::-webkit-outer-spin-button {
    -webkit-appearance: none; margin: 0;
  }

  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px;
           background: var(--surface); border: 1px solid var(--border); color: var(--text);
           font-size: 13px; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast.error { border-color: var(--red); color: var(--red); }

  .key-reveal { background: var(--bg); border: 1px solid var(--accent); border-radius: 8px;
                padding: 16px; margin: 16px 0; word-break: break-all; }
  .key-reveal .label { font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
  .key-reveal .value { font-family: 'SF Mono', monospace; font-size: 14px; color: var(--accent); user-select: all; }
  .key-reveal .warning { font-size: 11px; color: var(--yellow); margin-top: 8px; }
</style>
</head>
<body>

<div id="auth-gate" class="auth-gate">
  <h1>Admin Dashboard</h1>
  <div class="subtitle">Enter your master key to continue</div>
  <input type="password" id="master-key-input" placeholder="CLAUDE_PROXY_MASTER_KEY" autofocus>
  <button class="btn-primary" onclick="authenticate()" style="width:100%">Unlock</button>
</div>

<div id="app" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between">
    <div>
      <h1>Meridian</h1>
      <div class="subtitle">Admin Dashboard</div>
    </div>
    <button class="btn-ghost" onclick="logout()">Logout</button>
  </div>

  <div style="display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid var(--border)">
    <div class="admin-tab active" data-tab="keys" onclick="switchAdminTab('keys')" style="padding:10px 20px;font-size:13px;font-weight:500;color:var(--accent);cursor:pointer;border-bottom:2px solid var(--accent);margin-bottom:-1px">Keys &amp; Settings</div>
    <div class="admin-tab" data-tab="telemetry" onclick="switchAdminTab('telemetry')" style="padding:10px 20px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px">Telemetry</div>
  </div>

  <div id="tab-keys">

  <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
    <div id="models-inline" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    <div style="border-left:1px solid var(--border);height:20px"></div>
    <div style="display:flex;gap:6px;align-items:center">
      <label style="font-size:11px;color:var(--muted)">Concurrent:</label>
      <input type="number" id="max-concurrent" min="1" max="100" disabled style="width:50px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px">
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <label style="font-size:11px;color:var(--muted)">PT:</label>
      <input type="checkbox" id="passthrough-toggle" disabled style="width:13px;height:13px;cursor:pointer">
      <span id="passthrough-label" style="font-size:10px">off</span>
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <label style="font-size:11px;color:var(--muted)">/6h:</label>
      <input type="number" id="global-limit-6h" min="0" step="10000" disabled style="width:110px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px" placeholder="0 = none">
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <label style="font-size:11px;color:var(--muted)">/wk:</label>
      <input type="number" id="global-limit-weekly" min="0" step="10000" disabled style="width:110px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px" placeholder="0 = none">
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <label style="font-size:11px;color:var(--muted)">Stuck timeout:</label>
      <input type="number" id="idle-timeout" min="0" max="60" disabled style="width:50px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px" placeholder="10" title="Kill request if no response activity for this many minutes (0 = disabled)">
      <span style="font-size:10px;color:var(--muted)">min</span>
    </div>
    <button class="btn-ghost btn-sm" id="settings-edit-btn" onclick="editSettings()" style="padding:2px 8px;font-size:11px">Edit</button>
    <button class="btn-primary btn-sm" id="settings-save-btn" onclick="saveSettings()" style="display:none;padding:2px 8px;font-size:11px">Save</button>
    <button class="btn-ghost btn-sm" id="settings-cancel-btn" onclick="cancelSettings()" style="display:none;padding:2px 8px;font-size:11px">Cancel</button>
    <span id="settings-status" style="font-size:10px;color:var(--muted)"></span>
  </div>

  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
    <select id="stats-window" onchange="loadStats();loadKeys()" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px">
      <option value="3600000">Last hour</option>
      <option value="21600000">Last 6 hours</option>
      <option value="86400000" selected>Today</option>
      <option value="604800000">This week</option>
      <option value="2678400000">This month</option>
      <option value="0">All time</option>
    </select>
    <button class="btn-ghost btn-sm" onclick="loadKeys();loadStats()">Refresh</button>
    <label style="font-size:12px;color:var(--muted)"><input type="checkbox" id="keys-auto" checked> Auto (5s)</label>
    <span id="keys-updated" style="font-size:11px;color:var(--muted)"></span>
  </div>

  <div id="all-cards" class="cards"></div>

  <h2 style="font-size:16px;margin-bottom:12px">API Keys</h2>
  <div class="toolbar">
    <input type="text" id="new-key-name" placeholder="Key name (e.g. user@team)">
    <button class="btn-primary" onclick="createKey()">Create Key</button>
  </div>

  <div id="new-key-display" style="display:none">
    <div class="key-reveal">
      <div class="label">New API Key Created</div>
      <div class="value" id="new-key-value"></div>
      <div class="warning">Copy this key now — it will not be shown again.</div>
      <button class="btn-sm btn-ghost" style="margin-top:8px" onclick="copyKey()">Copy to clipboard</button>
    </div>
  </div>

  <div id="keys-table"></div>

  </div><!-- end tab-keys -->

  <div id="tab-telemetry" style="display:none">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
      <select id="tel-window" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px">
        <option value="300000">Last 5 min</option>
        <option value="900000">Last 15 min</option>
        <option value="3600000" selected>Last 1 hour</option>
        <option value="86400000">Last 24 hours</option>
      </select>
      <button class="btn-ghost btn-sm" onclick="loadTelemetry()">Refresh</button>
      <label style="font-size:12px;color:var(--muted)"><input type="checkbox" id="tel-auto" checked> Auto (5s)</label>
      <span id="tel-updated" style="font-size:11px;color:var(--muted)"></span>
    </div>
    <div id="tel-cards" class="cards"></div>
    <div id="tel-percentiles" style="margin-bottom:24px"></div>
    <div id="tel-requests"></div>
  </div><!-- end tab-telemetry -->

</div>

<div class="toast" id="toast"></div>

<script>
let token = localStorage.getItem('adminToken') || '';
const $ = s => document.querySelector(s);

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => t.className = 'toast', 3000);
}

function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch('/admin' + path, opts).then(async r => {
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401) { logout(); throw new Error('Session expired'); }
      throw new Error(data.error || 'Request failed');
    }
    return data;
  });
}

let telTimer;
let keysTimer;
const expandedUsage = new Set();
const expandedLimits = new Set();

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => {
    const isActive = t.dataset.tab === tab;
    t.style.color = isActive ? 'var(--accent)' : 'var(--muted)';
    t.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
  });
  $('#tab-keys').style.display = tab === 'keys' ? '' : 'none';
  $('#tab-telemetry').style.display = tab === 'telemetry' ? '' : 'none';
  if (tab === 'telemetry') loadTelemetry();
}

function showApp() {
  $('#auth-gate').style.display = 'none';
  $('#app').style.display = 'block';
  loadSettings();
  loadModels();
  loadStats();
  loadKeys();
  // Start auto-refresh timers
  clearInterval(telTimer);
  clearInterval(keysTimer);
  if ($('#tel-auto')?.checked) telTimer = setInterval(() => {
    if ($('#tab-telemetry').style.display !== 'none') loadTelemetry();
  }, 5000);
  if ($('#keys-auto')?.checked) keysTimer = setInterval(() => {
    if ($('#tab-keys').style.display !== 'none') { loadKeys(); loadStats(); }
  }, 5000);
  $('#keys-auto')?.addEventListener('change', function() {
    clearInterval(keysTimer);
    if (this.checked) keysTimer = setInterval(() => {
      if ($('#tab-keys').style.display !== 'none') { loadKeys(); loadStats(); }
    }, 5000);
  });
}

const settingsInputs = ['max-concurrent', 'passthrough-toggle', 'global-limit-6h', 'global-limit-weekly', 'idle-timeout'];

function applySettings(s) {
  $('#max-concurrent').value = s.maxConcurrent;
  $('#passthrough-toggle').checked = s.passthrough;
  $('#passthrough-label').textContent = s.passthrough ? 'on' : 'off';
  $('#passthrough-label').style.color = s.passthrough ? 'var(--green)' : 'var(--muted)';
  $('#global-limit-6h').value = s.globalLimit6h || '';
  $('#global-limit-weekly').value = s.globalLimitWeekly || '';
  $('#idle-timeout').value = s.idleTimeoutMinutes ?? 10;
}

function setSettingsEditable(editable) {
  $('#max-concurrent').disabled = !editable;
  $('#passthrough-toggle').disabled = !editable;
  $('#global-limit-6h').disabled = !editable;
  $('#global-limit-weekly').disabled = !editable;
  $('#idle-timeout').disabled = !editable;
  ['max-concurrent', 'global-limit-6h', 'global-limit-weekly', 'idle-timeout'].forEach(id => {
    const el = $('#' + id);
    if (el) el.style.background = editable ? 'var(--surface)' : 'var(--bg)';
  });
  $('#settings-edit-btn').style.display = editable ? 'none' : '';
  $('#settings-save-btn').style.display = editable ? '' : 'none';
  $('#settings-cancel-btn').style.display = editable ? '' : 'none';
}

let savedSettings = null;

async function loadSettings() {
  try {
    const s = await api('GET', '/settings');
    savedSettings = s;
    applySettings(s);
    setSettingsEditable(false);
  } catch {}
}

function editSettings() {
  setSettingsEditable(true);
}

function cancelSettings() {
  if (savedSettings) applySettings(savedSettings);
  setSettingsEditable(false);
}

$('#passthrough-toggle')?.addEventListener('change', function() {
  $('#passthrough-label').textContent = this.checked ? 'on' : 'off';
  $('#passthrough-label').style.color = this.checked ? 'var(--green)' : 'var(--muted)';
});

async function saveSettings() {
  const val = parseInt($('#max-concurrent').value, 10);
  if (!val || val < 1) { toast('Invalid value', true); return; }
  try {
    const s = await api('PATCH', '/settings', {
      maxConcurrent: val,
      passthrough: $('#passthrough-toggle').checked,
      globalLimit6h: parseInt($('#global-limit-6h').value, 10) || 0,
      globalLimitWeekly: parseInt($('#global-limit-weekly').value, 10) || 0,
      idleTimeoutMinutes: parseInt($('#idle-timeout').value, 10) || 0,
    });
    savedSettings = s;
    applySettings(s);
    setSettingsEditable(false);
    $('#settings-status').textContent = 'Saved';
    setTimeout(() => $('#settings-status').textContent = '', 2000);
    toast('Settings saved — takes effect immediately');
  } catch (e) { toast(e.message, true); }
}

function authenticate() {
  const key = $('#master-key-input').value.trim();
  if (!key) return;
  fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Login failed');
    token = data.token;
    localStorage.setItem('adminToken', token);
    showApp();
  }).catch(e => {
    toast(e.message || 'Invalid master key', true);
  });
}

function logout() {
  token = '';
  localStorage.removeItem('adminToken');
  $('#app').style.display = 'none';
  $('#auth-gate').style.display = 'block';
  $('#master-key-input').value = '';
}

// Auto-login if token exists
if (token) {
  api('GET', '/keys').then(() => showApp()).catch(() => {
    localStorage.removeItem('adminToken');
    token = '';
  });
}

$('#master-key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') authenticate();
});

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function ago(v) {
  if (!v) return 'Never';
  const ts = typeof v === 'number' ? v : new Date(v).getTime();
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

let cachedStats = null;
let cachedKeyCounts = null;
function renderAllCards() {
  const parts = [];
  if (cachedKeyCounts) {
    parts.push(card('Total Keys', cachedKeyCounts.total));
    parts.push(card('Active', cachedKeyCounts.active, 'color:var(--green)'));
  }
  if (cachedStats) {
    parts.push(card('Requests', fmtNum(cachedStats.requests)));
    parts.push(card('Input Tokens', fmtNum(cachedStats.inputTokens)));
    parts.push(card('Output Tokens', fmtNum(cachedStats.outputTokens)));
    parts.push(card('Total Tokens', fmtNum(cachedStats.inputTokens + cachedStats.outputTokens)));
  }
  $('#all-cards').innerHTML = parts.join('');
}

async function loadStats() {
  try {
    cachedStats = await api('GET', '/stats?window=' + $('#stats-window').value);
    renderAllCards();
  } catch {}
}



async function loadModels() {
  try {
    const models = await api('GET', '/models');
    if (!Array.isArray(models)) return;
    const parts = models.map(m => {
      const ctx = m.contextWindow >= 1000000 ? (m.contextWindow / 1000000) + 'M' : (m.contextWindow / 1000) + 'K';
      return '<span class="mono" style="padding:3px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px">'
        + esc(m.id) + ' <span style="color:var(--muted)">' + ctx + '</span></span>';
    });
    $('#models-inline').innerHTML = parts.join(' ');
  } catch {}
}

async function loadKeys() {
  try {
    const w = $('#stats-window').value;
    const keys = await api('GET', '/keys?window=' + w);

    cachedKeyCounts = {
      total: keys.length,
      active: keys.filter(k => k.enabled).length,
    };
    renderAllCards();

    // Skip table re-render while limits are being edited to preserve input values
    if (expandedLimits.size > 0) return;

    if (keys.length === 0) {
      $('#keys-table').innerHTML = '<div class="empty">No API keys yet. Create one above.</div>';
      return;
    }

    let html = '<table><thead><tr><th>Name</th><th>Key</th><th>Status</th>'
      + '<th>Requests</th><th>Usage (6h / week)</th><th>Last Used</th><th>Actions</th></tr></thead><tbody>';

    for (const k of keys) {
      const badge = k.enabled
        ? '<span class="badge badge-green">Active</span>'
        : '<span class="badge badge-red">Disabled</span>';
      const hasUsage = k.requestCount > 0;
      const lim6h = k.limits?.limit6h || 0;
      const limW = k.limits?.limitWeekly || 0;
      const used6h = k.used6h || 0;
      const usedW = k.usedWeekly || 0;
      const bar6h = lim6h > 0 ? usageBar(used6h, lim6h) : '<span style="font-size:11px">' + fmtNum(used6h) + ' <span style="color:var(--muted)">(no limit)</span></span>';
      const barW = limW > 0 ? usageBar(usedW, limW) : '<span style="font-size:11px">' + fmtNum(usedW) + ' <span style="color:var(--muted)">(no limit)</span></span>';

      html += '<tr style="cursor:pointer" onclick="toggleUsage(\\'' + k.id + '\\')">'
        + '<td><strong>' + esc(k.name) + '</strong></td>'
        + '<td class="mono">' + esc(k.key) + '</td>'
        + '<td>' + badge + '</td>'
        + '<td>' + fmtNum(k.windowRequests) + ' <span style="font-size:10px;color:var(--muted)">(' + fmtNum(k.windowTokens) + ' tok)</span></td>'
        + '<td style="min-width:180px"><div style="font-size:11px;margin-bottom:2px">6h: ' + bar6h + '</div><div style="font-size:11px">Week: ' + barW + '</div></td>'
        + '<td class="mono" style="color:var(--muted)">' + ago(k.lastUsedAt) + '</td>'
        + '<td style="white-space:nowrap" onclick="event.stopPropagation()">'
        + '<button class="btn-sm btn-ghost" onclick="copyExistingKey(\\'' + k.id + '\\')">Copy</button> '
        + '<button class="btn-sm btn-ghost" onclick="toggleLimits(\\'' + k.id + '\\')">Limits</button> '
        + '<button class="btn-sm btn-ghost" onclick="toggleKey(\\'' + k.id + '\\',' + !k.enabled + ')">'
        + (k.enabled ? 'Disable' : 'Enable') + '</button> '
        + '<button class="btn-sm btn-danger" onclick="deleteKey(\\'' + k.id + '\\',\\'' + esc(k.name) + '\\')">Delete</button>'
        + '</td></tr>';

      // Per-model usage row (expandable by clicking the row)
      const modelEntries = Object.entries(k.modelUsage || {});
      html += '<tr id="usage-' + k.id + '" style="display:' + (expandedUsage.has(k.id) ? '' : 'none') + '"><td colspan="7" style="padding:4px 12px 12px 24px">'
        + '<table style="font-size:12px;margin-top:4px"><thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>';
      if (modelEntries.length === 0) {
        html += '<tr><td class="mono" style="color:var(--muted)" colspan="5">No usage data for this period</td></tr>';
      } else {
        for (const [model, mu] of modelEntries) {
          html += '<tr><td class="mono">' + esc(model) + '</td>'
            + '<td>' + fmtNum(mu.requestCount) + '</td>'
            + '<td>' + fmtNum(mu.inputTokens) + '</td>'
            + '<td>' + fmtNum(mu.outputTokens) + '</td>'
            + '<td>' + fmtNum(mu.inputTokens + mu.outputTokens) + '</td></tr>';
        }
      }
      html += '</tbody></table></td></tr>';

      // Per-key limits row (hidden by default, toggled from Actions)
      html += '<tr id="limits-' + k.id + '" style="display:' + (expandedLimits.has(k.id) ? '' : 'none') + '"><td colspan="7" style="padding:8px 12px 12px 24px">'
        + '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">'
        + '<div style="display:flex;gap:6px;align-items:center"><label style="font-size:12px;color:var(--muted)">Limit /6h:</label>'
        + '<input type="number" id="lim6h-' + k.id + '" value="' + lim6h + '" min="0" style="width:130px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px" step="10000" placeholder="0 = none"></div>'
        + '<div style="display:flex;gap:6px;align-items:center"><label style="font-size:12px;color:var(--muted)">Limit /week:</label>'
        + '<input type="number" id="limW-' + k.id + '" value="' + limW + '" min="0" style="width:130px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px" step="10000" placeholder="0 = none"></div>'
        + '<button class="btn-primary btn-sm" onclick="saveLimits(\\'' + k.id + '\\')">Apply</button>'
        + '</div></td></tr>';
    }
    html += '</tbody></table>';
    $('#keys-table').innerHTML = html;
    $('#keys-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    toast(e.message, true);
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function card(label, value, style) {
  return '<div class="card"><div class="card-label">' + label + '</div>'
    + '<div class="card-value"' + (style ? ' style="' + style + '"' : '') + '>' + value + '</div></div>';
}

async function createKey() {
  const name = $('#new-key-name').value.trim();
  if (!name) { toast('Enter a key name', true); return; }
  try {
    const key = await api('POST', '/keys', { name });
    $('#new-key-value').textContent = key.key;
    $('#new-key-display').style.display = 'block';
    $('#new-key-name').value = '';
    toast('Key created for ' + name);
    loadKeys();
  } catch (e) {
    toast(e.message, true);
  }
}

function copyKey() {
  navigator.clipboard.writeText($('#new-key-value').textContent).then(
    () => toast('Copied to clipboard'),
    () => toast('Copy failed', true)
  );
}

async function copyExistingKey(id) {
  try {
    const data = await api('GET', '/keys/' + id + '/reveal');
    await navigator.clipboard.writeText(data.key);
    toast('Key copied to clipboard');
  } catch (e) { toast(e.message, true); }
}

async function toggleKey(id, enabled) {
  try {
    await api('PATCH', '/keys/' + id, { enabled });
    toast(enabled ? 'Key enabled' : 'Key disabled');
    loadKeys();
  } catch (e) { toast(e.message, true); }
}

function usageBar(used, limit) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--yellow)' : 'var(--green)';
  return '<div style="display:inline-flex;align-items:center;gap:6px;width:100%">'
    + '<div style="flex:1;height:6px;background:var(--border);border-radius:3px;min-width:60px">'
    + '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px"></div></div>'
    + '<span style="font-size:10px;white-space:nowrap">' + fmtNum(used) + '/' + fmtNum(limit) + ' (' + pct + '%)</span></div>';
}

function toggleLimits(id) {
  const row = document.getElementById('limits-' + id);
  if (row) {
    const show = row.style.display === 'none';
    row.style.display = show ? '' : 'none';
    show ? expandedLimits.add(id) : expandedLimits.delete(id);
  }
}

async function saveLimits(id) {
  const limit6h = parseInt(document.getElementById('lim6h-' + id).value, 10) || 0;
  const limitWeekly = parseInt(document.getElementById('limW-' + id).value, 10) || 0;
  try {
    await api('PATCH', '/keys/' + id, { limits: { limit6h, limitWeekly } });
    expandedLimits.delete(id);
    toast('Limits updated');
    loadKeys();
  } catch (e) { toast(e.message, true); }
}

function toggleUsage(id) {
  const row = document.getElementById('usage-' + id);
  if (row) {
    const show = row.style.display === 'none';
    row.style.display = show ? '' : 'none';
    show ? expandedUsage.add(id) : expandedUsage.delete(id);
  }
}

function ms(v) {
  if (v == null) return '—';
  if (v < 1000) return v + 'ms';
  return (v / 1000).toFixed(1) + 's';
}

function pctRow(label, color, phase) {
  return '<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:' + color + '"></span>' + label + '</td>'
    + '<td class="mono">' + ms(phase.p50) + '</td><td class="mono">' + ms(phase.p95) + '</td>'
    + '<td class="mono">' + ms(phase.p99) + '</td><td class="mono">' + ms(phase.avg) + '</td></tr>';
}

async function loadTelemetry() {
  const w = $('#tel-window').value;
  try {
    const [summary, reqs] = await Promise.all([
      api('GET', '/telemetry/summary?window=' + w),
      api('GET', '/telemetry/requests?limit=50&since=' + (Date.now() - Number(w))),
    ]);

    // Summary cards
    const s = summary;
    $('#tel-cards').innerHTML =
      card('Requests', s.totalRequests) +
      card('Errors', s.errorCount, s.errorCount > 0 ? 'color:var(--red)' : '') +
      card('Median Total', ms(s.totalDuration.p50)) +
      card('Median TTFB', ms(s.ttfb.p50)) +
      card('p95 Total', ms(s.totalDuration.p95)) +
      card('Queue Wait', ms(s.queueWait.p50));

    // Percentiles table
    if (s.totalRequests > 0) {
      $('#tel-percentiles').innerHTML = '<table><thead><tr><th>Phase</th><th>p50</th><th>p95</th><th>p99</th><th>Avg</th></tr></thead><tbody>'
        + pctRow('Queue', 'var(--yellow)', s.queueWait)
        + pctRow('Proxy Overhead', 'var(--yellow)', s.proxyOverhead)
        + pctRow('TTFB', 'var(--accent)', s.ttfb)
        + pctRow('Upstream', 'var(--green)', s.upstreamDuration)
        + pctRow('Total', 'var(--purple, #bc8cff)', s.totalDuration)
        + '</tbody></table>';
    } else {
      $('#tel-percentiles').innerHTML = '';
    }

    // Recent requests table
    if (reqs.length === 0) {
      $('#tel-requests').innerHTML = '<div class="empty">No requests in this time window.</div>';
    } else {
      const maxTotal = Math.max(...reqs.map(r => r.totalDurationMs), 1);
      let html = '<table><thead><tr><th>Time</th><th>Model</th><th>Mode</th><th>Status</th><th>TTFB</th><th>Total</th><th>Waterfall</th></tr></thead><tbody>';
      for (const r of reqs) {
        const statusCls = r.error ? 'color:var(--red)' : 'color:var(--green)';
        const scale = 200 / maxTotal;
        const qW = Math.max((r.queueWaitMs || 0) * scale, 1);
        const ttfbW = Math.max((r.ttfbMs || 0) * scale, 1);
        const respW = Math.max(((r.upstreamDurationMs || 0) - (r.ttfbMs || 0)) * scale, 1);
        html += '<tr><td class="mono">' + ago(r.timestamp) + '</td>'
          + '<td>' + r.model + '</td><td>' + r.mode + '</td>'
          + '<td style="' + statusCls + '">' + (r.error || r.status) + '</td>'
          + '<td class="mono">' + ms(r.ttfbMs) + '</td>'
          + '<td class="mono">' + ms(r.totalDurationMs) + '</td>'
          + '<td><div style="display:flex;height:14px;min-width:120px">'
          + '<div style="width:' + qW + 'px;background:var(--yellow);border-radius:2px;min-width:1px"></div>'
          + '<div style="width:' + ttfbW + 'px;background:var(--accent);border-radius:2px;min-width:1px"></div>'
          + '<div style="width:' + respW + 'px;background:var(--green);border-radius:2px;min-width:1px"></div>'
          + '</div></td></tr>';
      }
      html += '</tbody></table>';
      $('#tel-requests').innerHTML = html;
    }

    $('#tel-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#tel-cards').innerHTML = '<div class="empty">Failed to load telemetry</div>';
  }
}

$('#tel-window')?.addEventListener('change', () => loadTelemetry());
$('#tel-auto')?.addEventListener('change', function() {
  clearInterval(telTimer);
  if (this.checked) telTimer = setInterval(() => {
    if ($('#tab-telemetry').style.display !== 'none') loadTelemetry();
  }, 5000);
});

async function deleteKey(id, name) {
  if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
  try {
    await api('DELETE', '/keys/' + id);
    toast('Key deleted');
    loadKeys();
  } catch (e) { toast(e.message, true); }
}
</script>
</body>
</html>`
