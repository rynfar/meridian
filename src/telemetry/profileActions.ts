/**
 * What `/` and `/profiles` do to a profile from its card, written once:
 *
 * - `refreshProfile(id, done)` re-reads what Meridian can about the profile
 *   now (`POST /profiles/:id/refresh`: its login and its usage) and keeps
 *   the outcome, one line per part, for the card to show for a minute; `refreshing(id)` and `outcomeHtml(id)` are
 *   what a render reads, `busy()` what a poll checks before redrawing.
 *
 * `done` runs after a change so the page redraws; `refreshProfile` also runs
 * it with `false` as the read starts (redraw what you have) and with `true`
 * once it ended (fetch the new figures). The profileCardStatus.ts
 * pattern: one browser-side copy, interpolated as a string into each page.
 */
export const profileActionsJs = `
var meridianProfileActions = (function () {
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
      }, function () { return { status: 0, ok: false, data: null }; });
  }
  function refreshHeader() { if (window.meridianHeaderRefresh) window.meridianHeaderRefresh(); }

  var inflight = Object.create(null);
  var outcomes = Object.create(null);
  var OUTCOME_MS = 60000;
  var PART_LABELS = { login: 'Login', usage: 'Usage' };
  var PART_ORDER = ['login', 'usage'];
  async function refreshProfile(id, done) {
    if (inflight[id]) return;
    inflight[id] = true;
    if (done) done(false);
    var r = await post('/profiles/' + encodeURIComponent(id) + '/refresh');
    delete inflight[id];
    var parts = [];
    var answered = r.ok && r.data && r.data.parts;
    if (answered) {
      PART_ORDER.forEach(function (name) {
        var part = r.data.parts[name];
        if (part && typeof part.note === 'string') parts.push({ label: PART_LABELS[name], state: part.state, note: part.note });
      });
    } else {
      parts.push({ label: 'Refresh', state: 'failed', note: meridianDialog.errorText(r.data, r.status === 0 ? 'Could not reach Meridian.' : 'Meridian refused the refresh (HTTP ' + r.status + ').') });
    }
    outcomes[id] = { parts: parts, at: Date.now() };
    refreshHeader();
    if (done) await done(true);
  }
  function refreshing(id) { return !!inflight[id]; }
  function busy() { for (var k in inflight) return true; return false; }
  function outcome(id) {
    var o = outcomes[id];
    if (o && Date.now() - o.at > OUTCOME_MS) { delete outcomes[id]; o = null; }
    return o || null;
  }
  // The card's inline note: one line per part, its state as a word and a
  // colour, so a rate limit reads apart from a failure without a dialog.
  var STATE_WORDS = { fresh: 'refreshed', rate_limited: 'rate limited', failed: 'failed', skipped: 'skipped', unavailable: 'not readable here' };
  function outcomeHtml(id) {
    var o = outcome(id);
    if (!o) return '';
    var text = function (value) { var d = document.createElement('div'); d.textContent = value; return d.innerHTML; };
    return '<ul class="refresh-outcome" role="status" aria-label="Refresh outcome">' + o.parts.map(function (part) {
      var state = STATE_WORDS[part.state] ? part.state : 'failed';
      return '<li class="refresh-part ' + state + '"><span class="refresh-part-label">' + text(part.label) + '</span>'
        + '<span class="refresh-part-state">' + text(STATE_WORDS[state]) + '</span>'
        + '<span class="refresh-part-note">' + text(part.note) + '</span></li>';
    }).join('') + '</ul>';
  }
  return { refreshProfile: refreshProfile, refreshing: refreshing, busy: busy, outcome: outcome, outcomeHtml: outcomeHtml };
})();
`

/** The circular-arrows icon of the refresh button, 14px like the other card icons. */
export const ICON_REFRESH_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 11-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/></svg>'

/**
 * The refresh button's spin while its reads run (still under reduced motion),
 * and the per-part outcome under the card's name row: label, state, note on
 * one line that wraps the note beneath on a narrow card.
 */
export const profileActionsCss = `
  .profile-refresh.spinning svg { animation: profile-refresh-spin 0.9s linear infinite; }
  @keyframes profile-refresh-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .profile-refresh.spinning svg { animation: none; } }
  .profile-refresh[disabled] { opacity: 0.6; cursor: progress; }
  .refresh-outcome { list-style: none; margin: 0 0 8px; padding: 0; font-size: 11px; color: var(--muted); display: grid; gap: 2px; }
  .refresh-part { display: grid; grid-template-columns: 4.5em 8.5em minmax(0, 1fr); gap: 6px; align-items: baseline; }
  .refresh-part-label { color: var(--text); }
  .refresh-part-note { overflow-wrap: anywhere; }
  .refresh-part.fresh .refresh-part-state { color: var(--green); }
  .refresh-part.rate_limited .refresh-part-state { color: var(--yellow); }
  .refresh-part.failed .refresh-part-state { color: var(--red); }
  @media (max-width: 520px) {
    .refresh-part { grid-template-columns: auto minmax(0, 1fr); }
    .refresh-part-note { grid-column: 1 / -1; }
  }
`
