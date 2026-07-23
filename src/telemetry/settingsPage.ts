/**
 * SDK Features settings page — per-adapter toggle UI.
 * Same dark theme as the telemetry dashboard. No framework, no CDN.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"

export const settingsPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — SDK Features</title>
<link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); padding: 0; line-height: 1.5; }
  ${profileBarCss}
  .content { max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .nav { display: flex; gap: 16px; margin-bottom: 24px; font-size: 13px; }
  .nav a { color: var(--muted); text-decoration: none; }
  .nav a:hover { color: var(--accent); }
  .nav a.active { color: var(--accent); }

  .adapter-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; margin-bottom: 16px;
  }
  .adapter-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px;
  }
  .adapter-name { font-size: 16px; font-weight: 600; }
  .adapter-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-active { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-inactive { background: rgba(139, 148, 158, 0.15); color: var(--muted); }

  .feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .feature-grid { grid-template-columns: 1fr; } }

  .feature-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-radius: 6px;
    background: var(--bg); border: 1px solid var(--border);
  }
  .feature-info { display: flex; flex-direction: column; }
  .feature-label { font-size: 13px; font-weight: 500; }
  .feature-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }

  /* Toggle switch */
  .toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-track {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background: var(--border); border-radius: 10px; transition: background 0.2s;
  }
  .toggle-track::after {
    content: ""; position: absolute; height: 14px; width: 14px;
    left: 3px; bottom: 3px; background: var(--muted); border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }
  .toggle input:checked + .toggle-track { background: var(--accent); }
  .toggle input:checked + .toggle-track::after {
    transform: translateX(16px); background: var(--text);
  }

  /* Select dropdown */
  .feature-select {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer;
  }

  .save-indicator {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--green); color: #000; padding: 8px 16px;
    border-radius: 6px; font-size: 13px; font-weight: 500;
    opacity: 0; transition: opacity 0.3s; pointer-events: none;
  }
  .save-indicator.visible { opacity: 1; }

  .reset-btn {
    background: none; border: 1px solid var(--border); color: var(--muted);
    border-radius: 6px; padding: 4px 12px; font-size: 11px; cursor: pointer;
  }
  .reset-btn:hover { border-color: var(--red); color: var(--red); }

  /* Model pricing */
  .pricing-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pricing-table th { text-align: left; padding: 8px 10px; color: var(--muted); font-weight: 500;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  .pricing-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .pricing-table tr:last-child td { border-bottom: none; }
  .pricing-model { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .pricing-input { background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 8px; font-size: 12px; width: 84px; text-align: right;
    font-variant-numeric: tabular-nums; }
  .pricing-input:focus { border-color: var(--accent); outline: none; }
  .pricing-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px;
    text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .badge-override { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
  .badge-builtin { background: rgba(139, 148, 158, 0.15); color: var(--muted); }
  .pricing-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px;
    padding-top: 14px; border-top: 1px solid var(--border); }
  .pricing-add input[type="text"] { width: 240px; text-align: left; }
  .add-btn { background: var(--accent); border: none; color: #fff; border-radius: 6px;
    padding: 5px 14px; font-size: 12px; font-weight: 500; cursor: pointer; }
  .pricing-note { font-size: 11px; color: var(--muted); margin-top: 12px; line-height: 1.6; }
</style>
</head>
<body>
${profileBarHtml}
<div class="content">
  <h1>SDK Features <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(210,153,34,0.15);color:var(--yellow);vertical-align:middle;margin-left:8px">Experimental</span></h1>
  <p class="subtitle" style="max-width:720px;line-height:1.6">
    Unlock Claude Code features for any connected agent. Capabilities like auto-memory, dreaming, and CLAUDE.md — normally
    exclusive to Claude Code — become available to OpenCode, Crush, Droid, and any other harness routed through Meridian.
    Each agent keeps its own toolchain while gaining access to these additional features.<br><br>
    <strong style="color:var(--text)">System prompts:</strong> For these features to work correctly, both the Claude Code prompt and your client prompt
    should be enabled. When both are active, they are appended together — Claude Code's base instructions come first,
    followed by your agent's specific instructions.
  </p>

  <div id="adapters"></div>

  <h1 style="margin-top:40px">Routing</h1>
  <p class="subtitle" style="max-width:720px;line-height:1.6">
    How unpinned requests choose an account. <strong style="color:var(--text)">Active</strong> uses the manually
    selected profile. <strong style="color:var(--text)">Sticky</strong> distributes sessions across profiles evenly
    (cache-affine). <strong style="color:var(--text)">Priority</strong> drains the pool in order — highest first —
    and fails over per request when an account runs out; conversations keep their account, and new sessions
    return to the preferred account after its window resets. An explicit <code>x-meridian-profile</code> header
    always overrides. Changes apply to the next request — no restart needed.
  </p>
  <div class="adapter-card" id="routing-card">
    <div id="routing-body">Loading…</div>
  </div>

  <h1 style="margin-top:40px">Model Pricing</h1>
  <p class="subtitle" style="max-width:720px;line-height:1.6">
    Rates used by the telemetry cost estimate, in USD per million tokens. Edit a value to override the
    built-in rate, or add models the built-in table doesn't know about (they show as "no pricing" on the
    dashboard until defined here). Changes apply on the next dashboard refresh.
  </p>
  <div class="adapter-card">
    <table class="pricing-table">
      <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Source</th><th></th></tr></thead>
      <tbody id="pricingRows"></tbody>
    </table>
    <div class="pricing-add">
      <input type="text" class="pricing-input" id="newModelName" placeholder="model id (e.g. claude-opus-9)">
      <input type="number" class="pricing-input" id="newModelInput" placeholder="input" min="0" step="0.01">
      <input type="number" class="pricing-input" id="newModelOutput" placeholder="output" min="0" step="0.01">
      <input type="number" class="pricing-input" id="newModelCacheRead" placeholder="cache read" min="0" step="0.01">
      <input type="number" class="pricing-input" id="newModelCacheWrite" placeholder="cache write" min="0" step="0.01">
      <button class="add-btn" onclick="addPricingModel()">Add Model</button>
    </div>
    <div class="pricing-note">
      Cache read and cache write are optional; when left blank they default to 0.1x and 1.25x of the
      input rate (the 5-minute cache TTL multipliers). Verify current list prices at
      <a href="https://claude.com/pricing" target="_blank" rel="noreferrer" style="color:var(--accent)">claude.com/pricing</a>.
    </div>
  </div>
</div>

<div class="save-indicator" id="saveIndicator">Saved</div>

<script>
const FEATURES = [
  { key: 'codeSystemPrompt', label: 'Claude Code Prompt', desc: 'Include the built-in Claude Code system prompt (tool usage rules, safety guidelines, coding best practices)', type: 'toggle' },
  { key: 'clientSystemPrompt', label: 'Client Prompt', desc: 'Include the system prompt sent by the connecting agent (e.g. OpenCode or Crush instructions)', type: 'toggle' },
  { key: 'claudeMd', label: 'CLAUDE.md', desc: 'Load CLAUDE.md instruction files — Off: none, Project: ./CLAUDE.md only, Full: ~/.claude/CLAUDE.md + ./CLAUDE.md', type: 'select', options: ['off', 'project', 'full'] },
  { key: 'memory', label: 'Memory', desc: 'Read and write memories across sessions', type: 'toggle' },
  { key: 'dreaming', label: 'Auto-Dream', desc: 'Background memory consolidation', type: 'toggle' },
  { key: 'thinking', label: 'Thinking', desc: 'Extended thinking mode', type: 'select', options: ['disabled', 'adaptive', 'enabled'] },
  { key: 'thinkingPassthrough', label: 'Thinking Passthrough', desc: 'Forward thinking blocks to the client', type: 'toggle' },
  { key: 'sharedMemory', label: 'Shared Memory', desc: 'Share memory with Claude Code (~/.claude) instead of isolated storage', type: 'toggle' },
  { key: 'maxBudgetUsd', label: 'Max Budget (USD)', desc: 'Per-request cost cap — query aborts if exceeded (0 = disabled)', type: 'number' },
  { key: 'fallbackModel', label: 'Fallback Model', desc: 'Auto-fallback model if primary fails', type: 'select', options: ['', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]'] },
  { key: 'sdkDebug', label: 'SDK Debug Logging', desc: 'Enable verbose SDK debug output to proxy stderr', type: 'toggle' },
  { key: 'additionalDirectories', label: 'Additional Directories', desc: 'Comma-separated extra paths Claude can access (monorepo libs, etc.)', type: 'text' },
];

const ADAPTER_LABELS = {
  opencode: 'OpenCode',
  openai: 'OpenAI (/v1/chat/completions)',
  crush: 'Crush',
  forgecode: 'ForgeCode',
  pi: 'Pi',
  droid: 'Droid',
  passthrough: 'LiteLLM / Passthrough',
};

let currentConfig = {};

async function loadConfig() {
  const res = await fetch('/settings/api/features');
  currentConfig = await res.json();
  render();
}

async function saveFeature(adapter, key, value) {
  const patch = {};
  patch[key] = value;
  await fetch('/settings/api/features/' + adapter, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  currentConfig[adapter][key] = value;
  showSaved();
}

async function resetAdapter(adapter) {
  await fetch('/settings/api/features/' + adapter, { method: 'DELETE' });
  await loadConfig();
  showSaved();
}

function showSaved() {
  const el = document.getElementById('saveIndicator');
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 1500);
}

function hasAnyEnabled(features) {
  return features.codeSystemPrompt || !features.clientSystemPrompt || features.claudeMd !== 'off' || features.memory || features.dreaming ||
         features.thinking !== 'disabled' || features.thinkingPassthrough ||
         features.sharedMemory || features.maxBudgetUsd > 0 ||
         features.fallbackModel || features.sdkDebug ||
         features.additionalDirectories;
}

function render() {
  const container = document.getElementById('adapters');
  container.innerHTML = '';

  for (const [adapter, label] of Object.entries(ADAPTER_LABELS)) {
    const features = currentConfig[adapter] || {};
    const active = hasAnyEnabled(features);

    const card = document.createElement('div');
    card.className = 'adapter-card';
    card.innerHTML = '<div class="adapter-header">' +
      '<span class="adapter-name">' + label + '</span>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<span class="adapter-badge ' + (active ? 'badge-active' : 'badge-inactive') + '">' +
          (active ? 'Active' : 'Default') +
        '</span>' +
        '<button class="reset-btn" onclick="resetAdapter(\\''+adapter+'\\')">Reset</button>' +
      '</div>' +
    '</div>';

    const grid = document.createElement('div');
    grid.className = 'feature-grid';

    for (const feat of FEATURES) {
      const row = document.createElement('div');
      row.className = 'feature-row';

      const info = '<div class="feature-info"><span class="feature-label">' +
        feat.label + '</span><span class="feature-desc">' + feat.desc + '</span></div>';

      if (feat.type === 'toggle') {
        const checked = features[feat.key] ? 'checked' : '';
        row.innerHTML = info +
          '<label class="toggle"><input type="checkbox" ' + checked +
          ' onchange="saveFeature(\\''+adapter+'\\', \\''+feat.key+'\\', this.checked)">' +
          '<span class="toggle-track"></span></label>';
      } else if (feat.type === 'select') {
        const options = feat.options.map(o => {
          const label = o === '' ? '(None)' : o.charAt(0).toUpperCase()+o.slice(1);
          return '<option value="'+o+'"'+(features[feat.key]===o?' selected':'')+'>'+label+'</option>';
        }).join('');
        row.innerHTML = info +
          '<select class="feature-select" onchange="saveFeature(\\''+adapter+'\\', \\''+feat.key+'\\', this.value)">' +
          options + '</select>';
      } else if (feat.type === 'number') {
        const value = features[feat.key] ?? 0;
        row.innerHTML = info +
          '<input type="number" class="feature-select" style="width:80px;text-align:right" min="0" step="0.01" value="'+value+'"' +
          ' onchange="saveFeature(\\''+adapter+'\\', \\''+feat.key+'\\', parseFloat(this.value)||0)">';
      } else if (feat.type === 'text') {
        const value = (features[feat.key] ?? '').toString().replace(/"/g, '&quot;');
        row.innerHTML = info +
          '<input type="text" class="feature-select" style="width:180px" value="'+value+'"' +
          ' onchange="saveFeature(\\''+adapter+'\\', \\''+feat.key+'\\', this.value)">';
      }

      grid.appendChild(row);
    }

    card.appendChild(grid);
    container.appendChild(card);
  }
}

// ---- Model pricing (telemetry cost estimate) ----
let pricingData = { builtin: {}, overrides: {} };

function fmtRate(v) { return String(Math.round(v * 10000) / 10000); }

async function loadPricing() {
  const res = await fetch('/settings/api/pricing');
  pricingData = await res.json();
  renderPricing();
}

async function putPricing(model, rates) {
  const res = await fetch('/settings/api/pricing/' + encodeURIComponent(model), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rates),
  });
  if (!res.ok) {
    const err = await res.json().catch(function () { return {}; });
    alert('Could not save pricing: ' + (err.error || ('HTTP ' + res.status)));
    return false;
  }
  showSaved();
  return true;
}

async function removePricing(model) {
  await fetch('/settings/api/pricing/' + encodeURIComponent(model), { method: 'DELETE' });
  showSaved();
  await loadPricing();
}

function rateCell(value, onCommit) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.01';
  input.className = 'pricing-input';
  input.value = fmtRate(value);
  input.addEventListener('change', onCommit);
  td.appendChild(input);
  return { td: td, input: input };
}

function renderPricing() {
  const tbody = document.getElementById('pricingRows');
  tbody.innerHTML = '';
  const models = Array.from(new Set(
    Object.keys(pricingData.builtin).concat(Object.keys(pricingData.overrides))
  )).sort();

  for (const model of models) {
    const override = pricingData.overrides[model];
    const effective = override || pricingData.builtin[model];
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'pricing-model';
    nameTd.textContent = model;
    tr.appendChild(nameTd);

    const cells = [];
    const commit = async function () {
      const rates = {
        inputPerMTok: parseFloat(cells[0].input.value),
        outputPerMTok: parseFloat(cells[1].input.value),
        cacheReadPerMTok: parseFloat(cells[2].input.value),
        cacheWritePerMTok: parseFloat(cells[3].input.value),
      };
      for (const k in rates) { if (!isFinite(rates[k]) || rates[k] < 0) return; }
      if (await putPricing(model, rates)) await loadPricing();
    };
    ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'].forEach(function (key) {
      const cell = rateCell(effective[key], commit);
      cells.push(cell);
      tr.appendChild(cell.td);
    });

    const badgeTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'pricing-badge ' + (override ? 'badge-override' : 'badge-builtin');
    badge.textContent = override ? 'Override' : 'Built-in';
    badgeTd.appendChild(badge);
    tr.appendChild(badgeTd);

    const actionTd = document.createElement('td');
    if (override) {
      const btn = document.createElement('button');
      btn.className = 'reset-btn';
      btn.textContent = pricingData.builtin[model] ? 'Reset' : 'Remove';
      btn.addEventListener('click', function () { removePricing(model); });
      actionTd.appendChild(btn);
    }
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

async function addPricingModel() {
  const name = document.getElementById('newModelName').value.trim();
  const inputRate = parseFloat(document.getElementById('newModelInput').value);
  const outputRate = parseFloat(document.getElementById('newModelOutput').value);
  if (!name) { alert('Enter a model id'); return; }
  if (!isFinite(inputRate) || !isFinite(outputRate)) { alert('Enter input and output rates (USD per million tokens)'); return; }
  const rates = { inputPerMTok: inputRate, outputPerMTok: outputRate };
  const cacheRead = parseFloat(document.getElementById('newModelCacheRead').value);
  const cacheWrite = parseFloat(document.getElementById('newModelCacheWrite').value);
  if (isFinite(cacheRead)) rates.cacheReadPerMTok = cacheRead;
  if (isFinite(cacheWrite)) rates.cacheWritePerMTok = cacheWrite;
  if (await putPricing(name, rates)) {
    ['newModelName', 'newModelInput', 'newModelOutput', 'newModelCacheRead', 'newModelCacheWrite'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    await loadPricing();
  }
}

async function loadRouting() {
  const res = await fetch('/settings/api/routing');
  const cfg = await res.json();
  const el = document.getElementById('routing-body');
  const envNote = (on) => on ? ' <span style="font-size:11px;color:var(--yellow)">(env override active — setting saved but env wins)</span>' : '';
  let h = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">'
    + '<label style="color:var(--muted);font-size:13px;width:90px">Mode</label>'
    + '<select id="routing-mode" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px">'
    + ['active','sticky','priority'].map(m => '<option value="'+m+'"'+(cfg.routing===m?' selected':'')+'>'+m+'</option>').join('')
    + '</select>' + envNote(cfg.envOverride.routing) + '</div>';
  h += '<div id="routing-order-wrap" style="'+(cfg.routing==='priority'?'':'display:none')+'">'
    + '<div style="color:var(--muted);font-size:13px;margin-bottom:8px">Pool order — highest priority first. Drained top to bottom.'
    + envNote(cfg.envOverride.profileOrder) + '</div>'
    + '<ol id="routing-order" style="margin:0;padding-left:22px">'
    + cfg.profileOrder.map((id, i) =>
        '<li style="padding:4px 0;color:var(--text)">'
        + '<span style="font-family:var(--mono, monospace)">'+id+'</span>'
        + ' <button data-move="up" data-i="'+i+'" style="margin-left:10px;background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:1px 8px;cursor:pointer"'+(i===0?' disabled':'')+'>&uarr;</button>'
        + ' <button data-move="down" data-i="'+i+'" style="background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:1px 8px;cursor:pointer"'+(i===cfg.profileOrder.length-1?' disabled':'')+'>&darr;</button>'
        + '</li>').join('')
    + '</ol></div>';
  el.innerHTML = h;
  document.getElementById('routing-mode').addEventListener('change', async (e) => {
    await fetch('/settings/api/routing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routing: e.target.value }) });
    await loadRouting();
  });
  el.querySelectorAll('button[data-move]').forEach(btn => btn.addEventListener('click', async () => {
    const i = Number(btn.dataset.i);
    const j = btn.dataset.move === 'up' ? i - 1 : i + 1;
    const order = cfg.profileOrder.slice();
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    await fetch('/settings/api/routing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileOrder: order }) });
    await loadRouting();
  }));
}

loadConfig();
loadPricing();
loadRouting();
${profileBarJs}
</script>
</body>
</html>`
