/**
 * Which provider an account belongs to, and the chips that show or hide each
 * provider's accounts.
 *
 * `/` and `/profiles` list every account in one grid, grouped by provider: a
 * heading per provider, then its cards, each carrying the provider's stripe
 * and badge. A provider's cards keep the saved order among themselves and
 * never move into another provider's group, because the router ranks each
 * pool on its own: resolvePriorityOrder() for Claude, savedSeatOrder() for
 * ChatGPT seats (moveWithinGroup in profileOrder.ts).
 *
 * The chips above the grid show or hide a provider. All are on until someone
 * turns one off; what is hidden is remembered in localStorage, as the landing
 * page's sort is, and both pages share it. A link can name the chips that are
 * on instead, as `?provider=claude`, without touching what is remembered
 * (profileFilterUrl.ts). Chips exist only while two or more providers have
 * accounts: a provider with none has no chip, and a lone provider is always
 * shown, because its chip could do nothing but empty the page.
 *
 * Adding a provider (Antigravity) is one PROFILE_PROVIDERS entry plus its
 * `--<id>`, `--<id>-bright` and `--<id>-rgb` tokens in themeCss; the CSS below
 * is generated from the list.
 *
 * `profileProvidersJs` is the single browser-side copy, interpolated by both
 * pages, and the tests evaluate this exact text (profile-providers.test.ts),
 * as profileFacts.ts is tested.
 */

import { profileFilterUrlJs } from "./profileFilterUrl"

export interface ProfileProvider {
  /** The `provider` /profiles/list sends, and the suffix of its theme tokens. */
  readonly id: string
  readonly label: string
  /** What one of its accounts is called: singular, plural. */
  readonly noun: readonly [string, string]
}

/** Group and chip order. */
export const PROFILE_PROVIDERS: readonly ProfileProvider[] = [
  { id: "claude", label: "Claude", noun: ["account", "accounts"] },
  { id: "chatgpt", label: "ChatGPT", noun: ["seat", "seats"] },
]

/** localStorage key: a JSON array of the provider ids whose chip is off. */
export const HIDDEN_PROVIDERS_KEY = "meridian.hiddenProviders"

/** Query parameter naming the provider chips that are on (profileFilterUrl.ts). */
export const PROVIDER_URL_PARAM = "provider"

/** Shown in place of the grid when every provider's chip is off. */
export const PROVIDERS_NONE_SHOWN_HTML = 'Every provider is hidden. '
  + '<button type="button" class="provider-show-all" data-provider-chip="*">Show all</button>'

/**
 * `.provider-<id>` scopes `--brand`, `--brand-bright` and `--brand-rgb` to
 * one provider, so a card, chip or heading styles itself from those three
 * without knowing which provider it is.
 */
export const profileProvidersCss = PROFILE_PROVIDERS.map(p =>
  `  .provider-${p.id} { --brand: var(--${p.id}); --brand-bright: var(--${p.id}-bright); --brand-rgb: var(--${p.id}-rgb); }`,
).join("\n") + `
  .provider-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: var(--brand); }
  .provider-badge { color: var(--brand-bright); background: transparent; border: 1px solid rgba(var(--brand-rgb), 0.5); }
  .provider-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .provider-chips[hidden] { display: none; }
  .provider-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: inherit; font-size: 12px; font-weight: 500; line-height: 16px;
    padding: 3px 10px; border-radius: 14px; cursor: pointer;
    color: var(--muted); background: var(--surface); border: 1px solid var(--border);
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }
  .provider-chip .provider-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--brand); }
  .provider-chip[aria-pressed="true"] {
    color: var(--text); background: rgba(var(--brand-rgb), 0.12); border-color: rgba(var(--brand-rgb), 0.5);
  }
  .provider-chip[aria-pressed="true"] .provider-dot { background: var(--brand); box-shadow: none; }
  .provider-chip:hover { border-color: var(--brand-bright); }
  /* A chip is a control, and blue is what says so: the brand marks which
     provider it is for, the focus ring stays blue. */
  .provider-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .provider-chip-count { color: var(--muted); font-variant-numeric: tabular-nums; }
  .provider-group-head {
    grid-column: 1 / -1; display: flex; align-items: center; gap: 8px;
    font-size: 11px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 1px;
  }
  .provider-group-head[hidden] { display: none; }
  .provider-group-count { font-weight: 500; letter-spacing: 0.5px; }
  .provider-group-count::before { content: "\\00b7"; margin-right: 8px; }
  .provider-none {
    font-size: 13px; color: var(--muted); padding: 16px; margin-bottom: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  }
  .provider-none[hidden] { display: none; }
  .profile-card[data-group]::before {
    content: ""; position: absolute; left: -1px; top: 14px; bottom: 14px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--brand); pointer-events: none;
  }
  .provider-show-all { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
  .provider-show-all:hover { text-decoration: underline; }
  .provider-show-all:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
  @media (max-width: 720px) {
    .provider-chip { min-height: 40px; padding: 0 14px; }
    .provider-show-all { display: inline-flex; align-items: center; min-height: 40px; }
  }
`

/**
 * The browser half, as `meridianProviders`. Interpolated verbatim into each
 * page's inline script; see the module doc for why it is a string.
 */
export const profileProvidersJs = `
var meridianProviders = (function () {
  var PROVIDERS = ${JSON.stringify(PROFILE_PROVIDERS)};
  var STORAGE_KEY = ${JSON.stringify(HIDDEN_PROVIDERS_KEY)};
  var URL_PARAM = ${JSON.stringify(PROVIDER_URL_PARAM)};
  var NONE_SHOWN_HTML = ${JSON.stringify(PROVIDERS_NONE_SHOWN_HTML)};
  // Null-prototype, so a key named "constructor" is not a provider.
  var byId = Object.create(null);
  for (var i = 0; i < PROVIDERS.length; i++) byId[PROVIDERS[i].id] = PROVIDERS[i];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // A seat comes from /profiles/list with provider "chatgpt"; a Claude
  // account has no provider at all, as every account had before seats.
  function providerOf(p) {
    if (p && typeof p.provider === 'string' && byId[p.provider]) return p.provider;
    if (p && p.type === 'chatgpt') return 'chatgpt';
    return 'claude';
  }

  // One group per provider that has items, in PROVIDERS order, each keeping
  // the order its items arrived in. A key no provider claims still gets a
  // group, after the known ones, rather than losing its cards.
  function group(items, keyOf) {
    var buckets = Object.create(null);
    var keys = [];
    for (var i = 0; i < items.length; i++) {
      var key = String(keyOf(items[i]));
      if (!buckets[key]) { buckets[key] = []; keys.push(key); }
      buckets[key].push(items[i]);
    }
    var ordered = [];
    for (var j = 0; j < PROVIDERS.length; j++) if (buckets[PROVIDERS[j].id]) ordered.push(PROVIDERS[j].id);
    for (var k = 0; k < keys.length; k++) if (!byId[keys[k]]) ordered.push(keys[k]);
    return ordered.map(function (id) { return { provider: id, items: buckets[id] }; });
  }

  // The groups as one list: the order cards are drawn in, and so the order a
  // drag reads back off the page and saves. Each entry knows its group and
  // its place in it, which is the position its handle shows.
  function slots(groups) {
    var out = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      for (var j = 0; j < g.items.length; j++) {
        out.push({ item: g.items[j], provider: g.provider, group: g, place: j, size: g.items.length });
      }
    }
    return out;
  }

  // Whatever was stored, only known ids come back, once each. Storage that
  // is blocked or holds garbage hides nothing.
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

  // A provider's accounts are on screen unless its chip is off, and it has a
  // chip only while another provider has accounts too.
  function visibleIn(id, present, hidden) {
    return present.length < 2 || hidden.indexOf(id) < 0;
  }

  var storage = null;
  try { storage = localStorage; } catch (_) { storage = null; }
  var filterUrl = ${profileFilterUrlJs};
  var IDS = PROVIDERS.map(function (p) { return p.id; });
  // Whether ?provider= decides the chips (profileFilterUrl.ts), rather than
  // the remembered choice.
  var fromUrl = false;
  var hidden = [];

  // Takes the chips from the address (including an explicitly empty choice),
  // or from storage when the parameter is absent or contains only unknown ids.
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

  function visible(id, present) { return visibleIn(id, present, hidden); }

  function setHidden(id, hide) {
    if (!byId[id] || isHidden(id) === !!hide) return;
    hidden = hide ? hidden.concat([id]) : hidden.filter(function (h) { return h !== id; });
    save();
  }

  function showAll() {
    hidden = [];
    save();
  }

  function label(id) { return byId[id] ? byId[id].label : id; }

  function noun(id, n) {
    var nouns = byId[id] ? byId[id].noun : ['account', 'accounts'];
    return nouns[n === 1 ? 0 : 1];
  }

  function chipsHtml(groups) {
    if (groups.length < 2) return '';
    var out = '';
    for (var i = 0; i < groups.length; i++) {
      var id = groups[i].provider;
      var on = !isHidden(id);
      out += '<button type="button" class="provider-chip provider-' + esc(id) + '" data-provider-chip="' + esc(id) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + (on ? 'Hide ' : 'Show ') + esc(label(id) + ' ' + noun(id, 2)) + '">'
        + '<span class="provider-dot" aria-hidden="true"></span>' + esc(label(id))
        + '<span class="provider-chip-count">' + groups[i].items.length + '</span></button>';
    }
    return '<div class="provider-chips" role="group" aria-label="Providers shown">' + out + '</div>';
  }

  function headingHtml(g, hiddenNow) {
    var n = g.items.length;
    return '<div class="provider-group-head provider-' + esc(g.provider) + '" data-group="' + esc(g.provider) + '"'
      + ' role="heading" aria-level="3"' + (hiddenNow ? ' hidden' : '') + '>'
      + '<span class="provider-dot" aria-hidden="true"></span>' + esc(label(g.provider))
      + '<span class="provider-group-count">' + n + ' ' + esc(noun(g.provider, n)) + '</span></div>';
  }

  function badgeHtml(id, extraClass) {
    return '<span class="' + (extraClass ? extraClass + ' ' : '') + 'provider-badge">' + esc(label(id)) + '</span>';
  }

  function noneShownHtml(hiddenNow) {
    return '<div class="provider-none"' + (hiddenNow ? ' hidden' : '') + '>' + NONE_SHOWN_HTML + '</div>';
  }

  function anyShown(present) {
    if (present.length === 0) return true;
    for (var i = 0; i < present.length; i++) if (visible(present[i], present)) return true;
    return false;
  }

  // A toggle updates the chips in place, so the one under the pointer or
  // keyboard focus is never replaced by the click that pressed it.
  function syncChips(root) {
    var chips = root ? root.querySelectorAll('.provider-chip[data-provider-chip]') : [];
    for (var i = 0; i < chips.length; i++) {
      var id = chips[i].getAttribute('data-provider-chip');
      var on = !isHidden(id);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      chips[i].setAttribute('title', (on ? 'Hide ' : 'Show ') + label(id) + ' ' + noun(id, 2));
    }
  }

  // Applies a click on a chip or on "Show all", and returns which ('*' for
  // Show all); null when the click was on neither.
  function onClick(target) {
    var chip = target && target.closest ? target.closest('[data-provider-chip]') : null;
    if (!chip) return null;
    var id = chip.getAttribute('data-provider-chip');
    if (id === '*') showAll();
    else setHidden(id, !isHidden(id));
    return id;
  }

  return {
    providerOf: providerOf,
    group: group,
    slots: slots,
    readHidden: readHidden,
    writeHidden: writeHidden,
    visibleIn: visibleIn,
    isHidden: isHidden,
    visible: visible,
    fromLocation: fromLocation,
    setHidden: setHidden,
    showAll: showAll,
    label: label,
    chipsHtml: chipsHtml,
    headingHtml: headingHtml,
    badgeHtml: badgeHtml,
    noneShownHtml: noneShownHtml,
    anyShown: anyShown,
    syncChips: syncChips,
    onClick: onClick
  };
})();
`
