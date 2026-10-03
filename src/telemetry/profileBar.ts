/**
 * Shared site header — injected into all HTML pages.
 *
 * One piece of chrome for the whole app: brand (logo + wordmark), site nav,
 * live health pill, and the active-profile chip. Profile *switching* happens
 * on the home page (click an account card) or the Profiles page — the header
 * only shows which profile is active.
 *
 * CSS and JS are self-contained. Export names are kept from the old profile
 * bar (profileBarCss/Html/Js) so every page picks the header up unchanged.
 */

import { buildDriftView, buildIdentityView } from "./buildBadge"

/**
 * Canonical Meridian theme.
 *
 * Every inline HTML page (landing, telemetry dashboard, profiles,
 * settings, plugins) prepends this block before its own styles so
 * `var(--bg)`, `var(--accent)` etc. resolve consistently everywhere.
 *
 * Extra variables (--queue, --ttfb, --upstream, --blue, --purple) exist
 * so the telemetry waterfall and lineage-colored badges keep their
 * semantic meaning without needing per-page overrides.
 */
export const themeCss = `
  :root {
    /* Cool-gray neutral palette. High contrast, surface/border separation,
       no color cast muddying the text. Blue is the primary accent; violet
       is the fixed secondary — used together in the brand gradient and
       individually for hover states and a handful of telemetry badges. */
    --bg:        #0d1117;
    --surface:   #161b22;
    --surface2:  #1c2128;
    --border:    #30363d;
    /* Text */
    --text:      #e6edf3;
    --muted:     #8b949e;
    /* Brand — blue primary, violet secondary */
    --accent:    #58a6ff;
    --accent2:   #bc8cff;
    --violet:    #bc8cff;
    --lavender:  #d2a8ff;
    /* Semantic */
    --green:     #3fb950;
    --yellow:    #d29922;
    --red:       #f85149;
    /* Telemetry-specific aliases (waterfall + lineage badges) */
    --blue:      #58a6ff;
    --purple:    #bc8cff;
    --queue:     #d29922;
    --ttfb:      #58a6ff;
    --upstream:  #3fb950;
  }
  /* Banner backsplash — the brand look: a gentle diagonal wash with soft
     blue (top-left) and violet (bottom-right) glows. Pages must not set
     their own body background so this shows through everywhere. */
  body {
    background:
      radial-gradient(1200px 800px at 12% -8%, rgba(88,166,255,0.07), transparent 60%),
      radial-gradient(1100px 800px at 92% 108%, rgba(188,140,255,0.06), transparent 60%),
      linear-gradient(135deg, #0d1117 0%, #10151d 55%, #161b22 100%);
    background-attachment: fixed;
    background-color: var(--bg);
  }
`

/**
 * The Meridian mark: a wireframe globe whose prime meridian runs the brand
 * gradient from blue (north) to violet (south), pinned by a node at each
 * pole. Scales cleanly from favicon to hero size.
 */
export const meridianLogoSvg = `<svg class="mh-logo" width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="mhGrad" x1="32" y1="4" x2="32" y2="60" gradientUnits="userSpaceOnUse">
      <stop stop-color="#58a6ff"/>
      <stop offset="1" stop-color="#bc8cff"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="25" stroke="url(#mhGrad)" stroke-width="3.5"/>
  <ellipse cx="32" cy="32" rx="10.5" ry="25" stroke="url(#mhGrad)" stroke-width="2.5" opacity="0.8"/>
  <path d="M7 32h50" stroke="url(#mhGrad)" stroke-width="2" opacity="0.4"/>
  <circle cx="32" cy="7" r="4.5" fill="#58a6ff"/>
  <circle cx="32" cy="57" r="4.5" fill="#bc8cff"/>
</svg>`

export const profileBarCss = `
  .meridian-header {
    position: sticky; top: 0; z-index: 100;
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px 20px;
    padding: 10px 24px;
    background: rgba(13, 17, 23, 0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border, #30363d);
  }
  .meridian-header .mh-brand {
    display: flex; align-items: center; gap: 10px;
    text-decoration: none; color: var(--text, #e6edf3);
  }
  .meridian-header .mh-logo { display: block; }
  .meridian-header .mh-name {
    font-size: 15px; font-weight: 700; letter-spacing: 2px;
    text-transform: uppercase;
  }
  .meridian-header .mh-nav { display: flex; align-items: center; gap: 2px; }
  .meridian-header .mh-nav a {
    color: var(--muted, #8b949e); text-decoration: none; font-size: 12px;
    font-weight: 500; padding: 5px 10px; border-radius: 6px;
    transition: color 0.15s, background 0.15s;
  }
  .meridian-header .mh-nav a:hover { color: var(--text, #e6edf3); background: var(--surface, #161b22); }
  .meridian-header .mh-nav a.active { color: var(--accent, #58a6ff); background: var(--surface, #161b22); }
  .meridian-header .mh-right {
    margin-left: auto; display: flex; align-items: center; gap: 6px 10px;
    flex-wrap: wrap; justify-content: flex-end; min-width: 0; max-width: 100%;
  }
  .meridian-header .mh-profile {
    display: none; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 500; color: var(--text, #e6edf3);
    padding: 3px 10px; border-radius: 20px;
    background: var(--surface, #161b22); border: 1px solid var(--border, #30363d);
    text-decoration: none; transition: border-color 0.15s;
  }
  .meridian-header .mh-profile:hover { border-color: var(--accent, #58a6ff); }
  .meridian-header .mh-profile.visible { display: inline-flex; }
  .meridian-header .mh-profile .mh-profile-type {
    color: var(--muted, #8b949e); font-size: 10px;
  }
  /* npm update chip — a link to the releases page, so it is blue
     (interactive). Local/dev provenance is the separate .mh-prov pill. */
  .meridian-header .mh-build {
    display: none; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 500; white-space: nowrap;
    padding: 3px 10px; border-radius: 20px;
    color: var(--muted, #8b949e);
    background: var(--surface, #161b22);
    border: 1px solid var(--border, #30363d);
    cursor: default;
  }
  .meridian-header .mh-build.visible { display: inline-flex; }
  /* Local/dev build identity: a violet meta pill whose branch and commit
     pieces become blue links only when the backend supplied a safe URL.
     Drift sits beside it as its own chip, because it is refreshed from a
     different endpoint and must be able to say "unknown" on its own. */
  .meridian-header .mh-prov {
    display: none; align-items: center; gap: 6px;
    min-width: 0; max-width: 100%;
    font-size: 11px; font-weight: 500; line-height: 16px;
    padding: 3px 10px; border-radius: 12px;
    color: var(--accent2, #bc8cff);
    background: rgba(188,140,255,0.12);
    border: 1px solid rgba(188,140,255,0.35);
  }
  .meridian-header .mh-prov.visible { display: inline-flex; }
  .meridian-header .mh-prov-part { white-space: nowrap; flex: none; }
  .meridian-header .mh-prov-part + .mh-prov-part::before {
    content: "·"; margin-right: 6px; color: var(--muted, #8b949e);
  }
  .meridian-header .mh-prov-branch {
    flex: 0 1 auto; min-width: 6ch; max-width: 22ch; overflow: hidden;
    text-overflow: ellipsis;
  }
  .meridian-header .mh-prov-commit { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
  .meridian-header a.mh-prov-part { color: var(--accent, #58a6ff); text-decoration: none; }
  .meridian-header a.mh-prov-part:hover { text-decoration: underline; }
  .meridian-header a.mh-prov-part:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 1px; border-radius: 3px; }
  /* When the header runs out of room, fitBuildChip() steps the build info
     down: the calm "current" drift chip goes first, then the pill shrinks
     to v1.77.1-3255c91, v1.77.1-src and finally v1.77.1. The full details
     stay in the pill's tooltip in every form. */
  .meridian-header[data-prov-calm="hidden"] .mh-drift.calm { display: none; }
  .meridian-header .mh-prov-short,
  .meridian-header .mh-prov-short-commit,
  .meridian-header .mh-prov-short-run { display: none; white-space: nowrap; }
  .meridian-header[data-prov-form="commit"] .mh-prov-part,
  .meridian-header[data-prov-form="run"] .mh-prov-part,
  .meridian-header[data-prov-form="version"] .mh-prov-part { display: none; }
  .meridian-header[data-prov-form="commit"] .mh-prov-short,
  .meridian-header[data-prov-form="run"] .mh-prov-short,
  .meridian-header[data-prov-form="commit"] .mh-prov-short-commit,
  .meridian-header[data-prov-form="run"] .mh-prov-short-run,
  .meridian-header[data-prov-form="version"] .mh-prov-short { display: inline; }
  .meridian-header .mh-prov-short a { color: var(--accent, #58a6ff); text-decoration: none; }
  .meridian-header .mh-prov-short a:hover { text-decoration: underline; }
  .meridian-header .mh-prov-short a:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 1px; border-radius: 3px; }
  .meridian-header .mh-drift {
    display: inline-flex; align-items: center; white-space: nowrap;
    font-size: 11px; font-weight: 500; line-height: 16px;
    padding: 3px 8px; border-radius: 12px;
    color: var(--muted, #8b949e); border: 1px solid transparent;
  }
  .meridian-header .mh-drift[hidden] { display: none; }
  .meridian-header .mh-drift.warning {
    color: var(--yellow, #d29922);
    background: rgba(210,153,34,0.12);
    border-color: rgba(210,153,34,0.35);
  }
  .meridian-header .mh-update {
    display: none; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 500; white-space: nowrap;
    padding: 3px 10px; border-radius: 20px; text-decoration: none;
    color: var(--accent, #58a6ff);
    background: rgba(88,166,255,0.12);
    border: 1px solid rgba(88,166,255,0.35);
    transition: background 0.15s;
  }
  .meridian-header .mh-update.visible { display: inline-flex; }
  .meridian-header .mh-update:hover { background: rgba(88,166,255,0.18); }
  .meridian-header .mh-profile.following { border-color: var(--accent2, #bc8cff); }
  .meridian-header .mh-profile .mh-profile-follow {
    color: var(--accent2, #bc8cff); font-size: 10px;
  }
  .meridian-header .mh-status {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--muted, #8b949e); white-space: nowrap;
  }
  .meridian-header .mh-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted, #8b949e); flex-shrink: 0;
  }
  .meridian-header .mh-dot.healthy { background: var(--green, #3fb950); box-shadow: 0 0 6px rgba(63,185,80,0.5); }
  .meridian-header .mh-dot.degraded { background: var(--yellow, #d29922); }
  .meridian-header .mh-dot.unhealthy { background: var(--red, #f85149); }
  @media (max-width: 720px) {
    .meridian-header { gap: 10px; padding: 10px 16px; }
    .meridian-header .mh-right { flex-wrap: wrap; justify-content: flex-end; row-gap: 6px; min-width: 0; }
    .meridian-header .mh-profile { min-width: 0; overflow-wrap: anywhere; }
    .meridian-header .mh-name { display: none; }
    .meridian-header .mh-nav { order: 3; flex-basis: 100%; min-width: 0; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    .meridian-header .mh-nav a { flex-shrink: 0; }
    .meridian-header .mh-right { flex: 1 1 0; }
    .meridian-header .mh-status .mh-status-text { display: none; }
  }
`

export const profileBarHtml = `
<header class="meridian-header" id="meridianHeader">
  <a class="mh-brand" href="/" aria-label="Meridian home">
    ${meridianLogoSvg}
    <span class="mh-name">Meridian</span>
  </a>
  <nav class="mh-nav">
    <a href="/" id="nav-home">Home</a>
    <a href="/providers" id="nav-providers">Providers</a>
    <a href="/telemetry" id="nav-telemetry">Telemetry</a>
    <a href="/profiles" id="nav-profiles">Profiles</a>
    <a href="/settings" id="nav-settings">Settings</a>
    <a href="/plugins" id="nav-plugins">Plugins</a>
  </nav>
  <div class="mh-right">
    <span class="mh-prov" id="mhProv" role="group"></span>
    <span class="mh-drift" id="mhDrift" role="status" hidden></span>
    <a class="mh-profile" id="mhProfile" href="/" title="Active profile — switch from the home page"></a>
    <span class="mh-status" id="mhStatus"><span class="mh-dot" id="mhDot"></span><span class="mh-status-text" id="mhStatusText"></span></span>
    <span class="mh-build" id="mhBuild"></span>
    <a class="mh-update" id="mhUpdate" href="https://github.com/rynfar/meridian/releases" target="_blank" rel="noopener"></a>
  </div>
</header>
`

export const profileBarJs = `
(function() {
  var profileChip = document.getElementById('mhProfile');
  var buildChip = document.getElementById('mhBuild');
  var updateChip = document.getElementById('mhUpdate');
  var statusDot = document.getElementById('mhDot');
  var statusText = document.getElementById('mhStatusText');

  // Highlight active nav link
  var path = location.pathname;
  var navLinks = document.querySelectorAll('.mh-nav a');
  navLinks.forEach(function(a) {
    if (a.getAttribute('href') === path || (path === '/telemetry' && a.id === 'nav-telemetry') || (path === '/' && a.id === 'nav-home')) {
      a.classList.add('active');
    }
  });

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Inlined from src/telemetry/buildBadge.ts, unit-tested in build-badge.test.ts.
  var buildIdentityView = ${buildIdentityView.toString()};
  var buildDriftView = ${buildDriftView.toString()};
  var provChip = document.getElementById('mhProv');
  var driftChip = document.getElementById('mhDrift');
  var provKey = '';
  var driftKey = '';
  var provForms = [];
  var headerEl = document.getElementById('meridianHeader');
  var brandEl = headerEl.querySelector('.mh-brand');
  var rightEl = headerEl.querySelector('.mh-right');

  // The compact forms of the pill, rendered once beside the full parts so
  // that switching between them is a CSS attribute flip and never replaces
  // a link under the pointer. Returns the forms this build can show.
  function appendShortForms(parts) {
    function kind(k) { return parts.find(function(part) { return part.kind === k; }); }
    var version = kind('version'), run = kind('run'), commit = kind('commit');
    if (!version) return [];
    var forms = [];
    var short = document.createElement('span');
    short.className = 'mh-prov-short';
    short.appendChild(document.createTextNode(version.text));
    if (commit) {
      var commitWrap = document.createElement('span');
      commitWrap.className = 'mh-prov-short-commit';
      var sha = document.createElement(commit.href ? 'a' : 'span');
      sha.className = 'mh-prov-commit';
      sha.textContent = commit.text;
      sha.title = commit.title;
      if (commit.href) { sha.href = commit.href; sha.target = '_blank'; sha.rel = 'noopener noreferrer'; }
      commitWrap.append('-', sha);
      short.appendChild(commitWrap);
      forms.push('commit');
    }
    if (run && run.short) {
      var runWrap = document.createElement('span');
      runWrap.className = 'mh-prov-short-run';
      runWrap.textContent = '-' + run.short;
      runWrap.title = run.title;
      short.appendChild(runWrap);
      forms.push('run');
    }
    forms.push('version');
    provChip.appendChild(short);
    return forms;
  }

  // Picks the largest build-info form the header has room for. Room means
  // the right-hand group stays on one line beside the brand; a header too
  // narrow for even the smallest form on that row (a tablet whose nav fills
  // it) settles for the largest form that fits on one line of its own.
  function rightFits(besideBrand) {
    if (rightEl.scrollWidth > rightEl.clientWidth + 1) return false;
    if (besideBrand && rightEl.getBoundingClientRect().top >= brandEl.getBoundingClientRect().bottom) return false;
    var first = null;
    for (var i = 0; i < rightEl.children.length; i++) {
      var box = rightEl.children[i].getBoundingClientRect();
      if (!box.width) continue;
      if (!first) { first = box; continue; }
      if (box.top >= first.bottom || box.bottom <= first.top) return false;
    }
    return true;
  }

  function fitBuildChip() {
    var steps = [['shown', 'full'], ['hidden', 'full']].concat(provForms.map(function(form) { return ['hidden', form]; }));
    function apply(step) { headerEl.setAttribute('data-prov-calm', step[0]); headerEl.setAttribute('data-prov-form', step[1]); }
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < steps.length; i++) {
        apply(steps[i]);
        if (rightFits(pass === 0)) return;
      }
    }
  }

  var fitQueued = false;
  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function() { fitQueued = false; fitBuildChip(); });
  }
  // Header content changes with every poll (status, profile, drift), so the
  // fit follows it. Fitting only writes data-prov-* on the header, which
  // this observer ignores, so it cannot retrigger itself.
  new MutationObserver(queueFit).observe(headerEl, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'],
  });
  var fitWidth = 0;
  if (window.ResizeObserver) {
    new ResizeObserver(function(entries) {
      var width = entries[0].contentRect.width;
      if (width !== fitWidth) { fitWidth = width; queueFit(); }
    }).observe(headerEl);
  } else {
    window.addEventListener('resize', queueFit);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);

  // Build chips. Hidden entirely for a current npm install, which is the case
  // that needs no comment. Rebuilt only when the view changes, so a poll never
  // yanks a link out from under the pointer or keyboard focus.
  function renderBuild(build) {
    var view = buildIdentityView(build);
    var known = build && build.version && build.version !== 'unknown';
    buildChip.textContent = known ? 'v' + build.version : '';
    buildChip.title = known ? 'Running Meridian ' + build.version : '';
    // Local provenance already includes release/package version and run identity.
    buildChip.className = known && build.source === 'npm' ? 'mh-build visible' : 'mh-build';
    if (build && build.updateAvailable && build.latest) {
      updateChip.textContent = 'update available';
      updateChip.title = build.latest + ' is published, running ' + build.version + ' — ' +
        (build.source === 'npm' ? 'update with:\\nnpm install -g @rynfar/meridian@latest' : 'pull and rebuild this checkout');
      updateChip.className = 'mh-update visible';
    } else {
      updateChip.className = 'mh-update';
    }
    var key = JSON.stringify(view);
    if (key !== provKey) {
      provKey = key;
      if (view.mode === 'local') {
        provChip.replaceChildren.apply(provChip, view.parts.map(function(part) {
          var piece = document.createElement(part.href ? 'a' : 'span');
          piece.className = 'mh-prov-part mh-prov-' + part.kind;
          piece.textContent = part.text;
          piece.title = part.title;
          if (part.href) { piece.href = part.href; piece.target = '_blank'; piece.rel = 'noopener noreferrer'; }
          return piece;
        }));
        provForms = appendShortForms(view.parts);
        provChip.title = view.title;
        provChip.setAttribute('aria-label', view.label);
        provChip.className = 'mh-prov visible';
      } else {
        provForms = [];
        provChip.replaceChildren();
        provChip.removeAttribute('title');
        provChip.removeAttribute('aria-label');
        provChip.className = 'mh-prov';
      }
    }
    setDriftTracking(view.mode === 'local');
  }

  // Drift comes from /build-status, which only local/dev builds serve. It has
  // its own chained timer: the next request is scheduled only after the last
  // one settles, so slow responses cannot overlap or land out of order. A
  // failed request replaces the previous claim with an explicit unknown and
  // never touches the health pill.
  var driftTracking = false;
  var driftInFlight = false;
  var driftTimer = null;
  var driftGeneration = 0;

  function renderDrift(status) {
    var view = buildDriftView(status);
    var key = JSON.stringify(view);
    if (key === driftKey) return;
    driftKey = key;
    driftChip.textContent = view.text;
    driftChip.title = view.title;
    driftChip.className = 'mh-drift ' + view.tone;
    driftChip.hidden = false;
  }

  function pollDrift() {
    clearTimeout(driftTimer);
    driftTimer = null;
    if (!driftTracking || driftInFlight) return;
    driftInFlight = true;
    var generation = driftGeneration;
    fetch('/build-status', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .catch(function() { return null; })
      .then(function(status) {
        driftInFlight = false;
        if (!driftTracking) return;
        var fresh = generation === driftGeneration;
        if (fresh) renderDrift(status);
        driftTimer = setTimeout(pollDrift, fresh ? 10000 : 0);
      });
  }

  function setDriftTracking(tracking) {
    if (tracking === driftTracking) return;
    driftTracking = tracking;
    driftGeneration++;
    if (tracking) { pollDrift(); return; }
    clearTimeout(driftTimer);
    driftTimer = null;
    driftKey = '';
    driftChip.hidden = true;
    driftChip.textContent = '';
  }

  function loadHeader() {
    fetch('/health').then(function(r) { return r.json(); }).then(function(h) {
      var st = h.status === 'healthy' ? 'healthy' : h.status === 'degraded' ? 'degraded' : 'unhealthy';
      statusDot.className = 'mh-dot ' + st;
      statusText.textContent = st === 'healthy' ? 'Operational' : st === 'degraded' ? 'Degraded' : 'Offline';
      renderBuild(h.build);
      if (h.backend === 'antigravity') {
        ['nav-telemetry','nav-profiles','nav-settings','nav-plugins'].forEach(function(id) { document.getElementById(id).hidden = true; });
        profileChip.removeAttribute('href');
      }
    }).catch(function() {
      statusDot.className = 'mh-dot unhealthy';
      statusText.textContent = 'Offline';
    });

    fetch('/profiles/list').then(function(r) { return r.json(); }).then(function(data) {
      var current = (data.profiles || []).find(function(p) { return p.isActive; });
      if (!current) { profileChip.classList.remove('visible'); return; }
      // Follow mode: say so on every page. An instance quietly taking its
      // active profile from another one, with a picker that won't stick, is
      // otherwise an hour of confusion.
      var follow = data.follow;
      var followLabel = follow ? (follow.activeProfile ? 'following' : 'follow: local') : '';
      if (follow && follow.stale) followLabel += ' (stale)';
      profileChip.innerHTML = esc(current.id) + ' <span class="mh-profile-type">' + esc(current.type || '') + '</span>'
        + (follow ? ' <span class="mh-profile-follow">' + esc(followLabel) + '</span>' : '');
      profileChip.classList.toggle('following', !!follow);
      profileChip.title = follow
        ? 'Active profile follows ' + follow.url + ' (MERIDIAN_FOLLOW_ACTIVE)'
          + (follow.activeProfile ? '' : ' — no usable value from it, using the local profile')
          + '. Switching here is refused; switch on the followed instance.'
        : 'Active profile — switch from the home page';
      profileChip.classList.add('visible');
    }).catch(function() {});
  }

  loadHeader();
  setInterval(loadHeader, 10000);
  // Pages call this after mutating state (e.g. switching the active profile)
  // so the header chip updates immediately instead of on the next poll.
  window.meridianHeaderRefresh = function() { loadHeader(); pollDrift(); };
})();
`

/** Native desktop chrome: system appearance with the canonical Meridian hues.
 * Web pages continue using themeCss and the shared profile header above. */
export const desktopThemeCss = `
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7; --surface: #ffffff; --surface2: #edeff2;
    --border: #dde0e5; --text: #23272e; --muted: #69717e;
    --accent: #176bce; --accent2: #8250b5;
    --green: #237c40; --yellow: #976400; --red: #ca3b36;
    --sidebar: #e9edf1; --control: #ffffff; --control-border: #d0d5dc;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --surface: #161b22; --surface2: #1c2128;
      --border: #30363d; --text: #e6edf3; --muted: #8b949e;
      --accent: #58a6ff; --accent2: #bc8cff;
      --green: #3fb950; --yellow: #d29922; --red: #f85149;
      --sidebar: #161b22; --control: #242b35; --control-border: #39424e;
    }
  }
  body { background: var(--bg); }
  html.native-glass body { background: transparent; }
`

export const desktopWindowColors = { transparent: '#00000000', dark: '#0d1117', light: '#f4f5f7' } as const
