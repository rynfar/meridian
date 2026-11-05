/**
 * The login state of an account, and the chips that show or hide accounts in
 * each state.
 *
 * Beside the provider chips (profileProviders.ts), `/` and `/profiles` carry a
 * second group: Authenticated, Expires soon, Needs auth. A card shows when its
 * provider's chip is on AND its state's chip is on. Every chip is on until
 * someone turns it off; what is hidden is remembered in localStorage, shared
 * by both pages, as the provider chips are; a link can name the chips that are
 * on instead, as `?login=needs-auth`, without touching what is remembered
 * (profileFilterUrl.ts). The group exists only while two or more accounts are
 * listed, because with one account a chip could do nothing but empty the page.
 *
 * Each account is in exactly one state, decided by rules the pages already
 * apply rather than a second copy of them:
 *  - Needs auth: isUnusable() (profileSpent.ts), the needs-login decision
 *    behind the red border and pill. The page interpolates isUnusableJs
 *    before this module, which calls it.
 *  - Expires soon: logged in, and `renewalRequiredSoon` from /profiles/list,
 *    the flag that turns the card's "Refresh deadline" fact amber
 *    (profileFacts.ts). The server sets it once the login deadline
 *    (refreshTokenExpiresAt) is MERIDIAN_AUTH_RENEWAL_WARN_DAYS away or less,
 *    3 days by default. A ChatGPT seat states no login deadline, so it is
 *    never in this state.
 *  - Authenticated: every other account.
 *
 * The chips reuse `.provider-chip` for their look, keyboard behaviour and
 * phone sizing; `.login-<id>` points `--brand` at the state's semantic colour.
 */

import { profileFilterUrlJs } from "./profileFilterUrl"

export interface LoginState {
  readonly id: string
  readonly label: string
}

/** Chip order. */
export const LOGIN_STATES: readonly LoginState[] = [
  { id: "authenticated", label: "Authenticated" },
  { id: "expires-soon", label: "Expires soon" },
  { id: "needs-auth", label: "Needs auth" },
]

/** localStorage key: a JSON array of the login states whose chip is off. */
export const HIDDEN_LOGIN_STATES_KEY = "meridian.hiddenLoginStates"

/** Query parameter naming the login-state chips that are on (profileFilterUrl.ts). */
export const LOGIN_STATE_URL_PARAM = "login"

/** Shown in place of the grid when the login-state chips hide every card on screen. */
export const LOGIN_STATES_NONE_SHOWN_HTML = 'No account is in a login state shown. '
  + '<button type="button" class="provider-show-all" data-login-chip="*">Show all states</button>'

// The semantic colours as channels, for the chips' tinted fills: themeCss
// declares --green, --yellow and --red as hex only.
const STATE_COLOURS: Record<string, [string, string]> = {
  "authenticated": ["green", "63,185,80"],
  "expires-soon": ["yellow", "210,153,34"],
  "needs-auth": ["red", "248,81,73"],
}

export const profileLoginStatesCss = LOGIN_STATES.map(s => {
  const [token, rgb] = STATE_COLOURS[s.id]!
  return `  .login-${s.id} { --brand: var(--${token}); --brand-bright: var(--${token}); --brand-rgb: ${rgb}; }`
}).join("\n") + `
  /* The provider and login-state chips share one row and wrap as one. */
  .chip-row { display: flex; flex-wrap: wrap; column-gap: 16px; row-gap: 6px; margin-bottom: 12px; }
  .chip-row .provider-chips { margin-bottom: 0; }
  .chip-row > :empty, .chip-row:not(:has(.provider-chip)) { display: none; }
`

/**
 * The browser half, as `meridianLoginStates`. Interpolated verbatim into each
 * page's inline script after isUnusableJs; the tests evaluate this exact text.
 */
export const profileLoginStatesJs = `
var meridianLoginStates = (function () {
  var STATES = ${JSON.stringify(LOGIN_STATES)};
  var STORAGE_KEY = ${JSON.stringify(HIDDEN_LOGIN_STATES_KEY)};
  var URL_PARAM = ${JSON.stringify(LOGIN_STATE_URL_PARAM)};
  var NONE_SHOWN_HTML = ${JSON.stringify(LOGIN_STATES_NONE_SHOWN_HTML)};
  var byId = Object.create(null);
  for (var i = 0; i < STATES.length; i++) byId[STATES[i].id] = STATES[i];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // p: { loggedIn, error (the quota entry's), renewalRequiredSoon }.
  function stateOf(p) {
    if (isUnusable(p || {})) return 'needs-auth';
    if (p && p.renewalRequiredSoon === true) return 'expires-soon';
    return 'authenticated';
  }

  function counts(states) {
    var out = Object.create(null);
    for (var i = 0; i < STATES.length; i++) out[STATES[i].id] = 0;
    for (var j = 0; j < states.length; j++) if (byId[states[j]]) out[states[j]]++;
    return out;
  }

  function readHidden(storage) {
    var raw = null;
    try { raw = storage ? storage.getItem(STORAGE_KEY) : null; } catch (_) { raw = null; }
    var parsed = null;
    try { parsed = JSON.parse(raw || '[]'); } catch (_) { parsed = null; }
    var hidden = [];
    if (!Array.isArray(parsed)) return hidden;
    for (var i = 0; i < parsed.length; i++) {
      var id = parsed[i];
      if (typeof id === 'string' && byId[id] && hidden.indexOf(id) < 0) hidden.push(id);
    }
    return hidden;
  }

  function writeHidden(storage, hidden) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(hidden)); return true; } catch (_) { return false; }
  }

  var storage = null;
  try { storage = localStorage; } catch (_) { storage = null; }
  var filterUrl = ${profileFilterUrlJs};
  var IDS = STATES.map(function (s) { return s.id; });
  // Whether ?login= decides the chips, rather than the remembered choice.
  var fromUrl = false;
  var hidden = [];

  // Called again on popstate, when the address can change under the page.
  function fromLocation() {
    var on = filterUrl.read(URL_PARAM, IDS);
    fromUrl = on !== null;
    hidden = fromUrl ? IDS.filter(function (id) { return on.indexOf(id) < 0; }) : readHidden(storage);
  }
  fromLocation();

  function save() {
    if (fromUrl) filterUrl.write(URL_PARAM, IDS.filter(function (id) { return hidden.indexOf(id) < 0; }));
    else writeHidden(storage, hidden);
  }

  function isHidden(id) { return hidden.indexOf(id) >= 0; }

  // With fewer than two accounts there are no chips, so nothing is hidden.
  function visible(id, total) { return total < 2 || !isHidden(id); }

  function setHidden(id, hide) {
    if (!byId[id] || isHidden(id) === !!hide) return;
    hidden = hide ? hidden.concat([id]) : hidden.filter(function (h) { return h !== id; });
    save();
  }

  function showAll() {
    hidden = [];
    save();
  }

  function title(id, on) { return (on ? 'Hide' : 'Show') + ' accounts: ' + byId[id].label.toLowerCase(); }

  function chipsHtml(stateCounts, total) {
    if (total < 2) return '';
    var out = '';
    for (var i = 0; i < STATES.length; i++) {
      var id = STATES[i].id;
      var on = !isHidden(id);
      out += '<button type="button" class="provider-chip login-' + esc(id) + '" data-login-chip="' + esc(id) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(title(id, on)) + '">'
        + '<span class="provider-dot" aria-hidden="true"></span>' + esc(STATES[i].label)
        + '<span class="provider-chip-count">' + (stateCounts[id] || 0) + '</span></button>';
    }
    return '<div class="provider-chips login-chips" role="group" aria-label="Login states shown">' + out + '</div>';
  }

  function noneShownHtml(hiddenNow) {
    return '<div class="provider-none login-none"' + (hiddenNow ? ' hidden' : '') + '>' + NONE_SHOWN_HTML + '</div>';
  }

  function syncChips(root) {
    var chips = root ? root.querySelectorAll('.provider-chip[data-login-chip]') : [];
    for (var i = 0; i < chips.length; i++) {
      var id = chips[i].getAttribute('data-login-chip');
      if (!byId[id]) continue;
      var on = !isHidden(id);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      chips[i].setAttribute('title', title(id, on));
    }
  }

  // Applies a click on a chip or on "Show all states", and returns which
  // ('*' for Show all); null when the click was on neither.
  function onClick(target) {
    var chip = target && target.closest ? target.closest('[data-login-chip]') : null;
    if (!chip) return null;
    var id = chip.getAttribute('data-login-chip');
    if (id === '*') showAll();
    else setHidden(id, !isHidden(id));
    return id;
  }

  return {
    stateOf: stateOf,
    counts: counts,
    readHidden: readHidden,
    isHidden: isHidden,
    visible: visible,
    fromLocation: fromLocation,
    setHidden: setHidden,
    showAll: showAll,
    chipsHtml: chipsHtml,
    noneShownHtml: noneShownHtml,
    syncChips: syncChips,
    onClick: onClick
  };
})();
`
