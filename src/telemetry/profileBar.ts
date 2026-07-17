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
    display: flex; align-items: center; gap: 20px;
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
    margin-left: auto; display: flex; align-items: center; gap: 10px;
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
    .meridian-header { gap: 10px; padding: 10px 16px; flex-wrap: wrap; }
    .meridian-header .mh-name { display: none; }
    .meridian-header .mh-status .mh-status-text { display: none; }
  }
`

export const profileBarHtml = `
<header class="meridian-header" id="meridianHeader">
  <a class="mh-brand" href="/">
    ${meridianLogoSvg}
    <span class="mh-name">Meridian</span>
  </a>
  <nav class="mh-nav">
    <a href="/" id="nav-home">Home</a>
    <a href="/telemetry" id="nav-telemetry">Telemetry</a>
    <a href="/profiles" id="nav-profiles">Profiles</a>
    <a href="/settings" id="nav-settings">Settings</a>
    <a href="/plugins" id="nav-plugins">Plugins</a>
  </nav>
  <div class="mh-right">
    <a class="mh-profile" id="mhProfile" href="/" title="Active profile — switch from the home page"></a>
    <span class="mh-status" id="mhStatus"><span class="mh-dot" id="mhDot"></span><span class="mh-status-text" id="mhStatusText"></span></span>
  </div>
</header>
`

export const profileBarJs = `
(function() {
  var profileChip = document.getElementById('mhProfile');
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

  function loadHeader() {
    fetch('/health').then(function(r) { return r.json(); }).then(function(h) {
      var st = h.status === 'healthy' ? 'healthy' : h.status === 'degraded' ? 'degraded' : 'unhealthy';
      statusDot.className = 'mh-dot ' + st;
      statusText.textContent = st === 'healthy' ? 'Operational' : st === 'degraded' ? 'Degraded' : 'Offline';
    }).catch(function() {
      statusDot.className = 'mh-dot unhealthy';
      statusText.textContent = 'Offline';
    });

    fetch('/profiles/list').then(function(r) { return r.json(); }).then(function(data) {
      var current = (data.profiles || []).find(function(p) { return p.isActive; });
      if (!current) { profileChip.classList.remove('visible'); return; }
      profileChip.innerHTML = esc(current.id) + ' <span class="mh-profile-type">' + esc(current.type || '') + '</span>';
      profileChip.classList.add('visible');
    }).catch(function() {});
  }

  loadHeader();
  setInterval(loadHeader, 10000);
  // Pages call this after mutating state (e.g. switching the active profile)
  // so the header chip updates immediately instead of on the next poll.
  window.meridianHeaderRefresh = loadHeader;
})();
`
