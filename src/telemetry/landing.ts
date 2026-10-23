/**
 * Meridian landing page.
 *
 * The at-a-glance dashboard: a short how-it-works intro, per-account cards
 * (usage + est. cost, click to switch the active profile), and a compact
 * 24h traffic strip. Site chrome (logo, nav, status) lives in the shared
 * header from profileBar.ts. Fetches /health, /telemetry/summary,
 * /v1/usage/quota/all, /profiles/list and /settings/api/routing client-side for live data.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"
import { profileFactsJs } from "./profileFacts"
import { profileFindJs } from "./profileFind"
import { reorderClientJs, reorderCss, reorderLiveRegionHtml } from "./profileOrder"
import { profileProvidersCss, profileProvidersJs } from "./profileProviders"
import { DEFAULT_PROFILE_SORT, PROFILE_SORT_MODES } from "./profileSort"
import { FADE_FROM, GENERAL_WINDOW_TYPES, SPENT_AT, isUnusableJs } from "./profileSpent"
import { domPatchJs } from "./domPatch"
import { profileCardStatusCss, profileCardStatusJs } from "./profileCardStatus"

export const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian</title>
<link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); line-height: 1.6; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 28px 24px; }

  /* Intro — friendly one-paragraph overview of how Meridian works */
  .intro { margin-bottom: 28px; }
  .intro h2 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .intro p { font-size: 13px; color: var(--muted); max-width: 640px; }
  .intro code { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 5px;
    padding: 1px 6px; color: var(--accent2); white-space: nowrap; }
  .intro a { color: var(--accent); text-decoration: none; }
  .intro a:hover { text-decoration: underline; }
  .intro-meta { font-size: 12px; color: var(--muted); margin-top: 8px; }

  /* Profile cards — the centerpiece: usage + cost per account, click to switch */
  /* min() lets a single column shrink below 300px: a phone at 320px has only
     272px inside the container, and a fixed 300px track scrolled the page. */
  .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; margin-bottom: 24px; }
  /* Wide layout: a card stays about as wide as in the contained column, where
     a 960px row holds two of about 448px, and a row takes as many as fit.
     auto-fill keeps empty tracks, so a short list keeps its card size instead
     of stretching across the window. */
  html[data-layout="wide"] .profile-grid { grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr)); }
  .profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 18px 20px; position: relative; transition: border-color 0.15s, background 0.15s; }
  .profile-card[hidden] { display: none; }
  /* Each provider has its own active account, so the active ring and the
     hover that offers a switch are in that provider's brand (--brand comes
     from the card's .provider-<id> class, profileProviders.ts). */
  .profile-card.switchable { cursor: pointer; }
  .profile-card.switchable:hover { border-color: var(--brand-bright, var(--accent)); background: rgba(var(--brand-rgb, 88,166,255), 0.05); }
  .profile-card.active { border-color: var(--brand, var(--accent)); box-shadow: 0 0 0 1px var(--brand, var(--accent)); }
  .profile-grid .provider-group-head:not([hidden]) ~ .provider-group-head { margin-top: 8px; }

  /* Spent accounts recede. --spend-fade is set per card (0..1) from the
     shared classifier; hovering restores the card so a dimmed one can still
     be read. An account that needs a login is NOT dimmed — it needs
     attention, not fading, so it keeps full contrast and turns red.

     The fade is on the card's CONTENTS and never on the card, because
     filter and opacity apply to an element's OWN border and box-shadow.
     Fading .profile-card therefore greyed out the active ring on
     .profile-card.active - the one mark on the page saying which account is
     serving requests - so the active profile became unfindable the moment it
     passed 95%, which is precisely when somebody comes looking for it. A
     descendant cannot undo an ancestor's filter or opacity, so scoping the
     fade to the children is the only thing that leaves the ring alone. The
     active card spares its name row as well, so its Active pill and its
     spent badge stay readable and only its figures recede. */
  .profile-card.spend-fading > *, .profile-card.spend-spent > * {
    filter: grayscale(var(--spend-fade, 0));
    opacity: calc(1 - 0.55 * var(--spend-fade, 0));
    transition: filter 0.2s, opacity 0.2s; }
  .profile-card.spend-fading:hover > *, .profile-card.spend-spent:hover > * { filter: none; opacity: 1; }
  .profile-card.active.spend-fading > .profile-head, .profile-card.active.spend-spent > .profile-head { filter: none; opacity: 1; }
  .profile-card.needs-login { border-color: var(--red); }
  .profile-card.needs-login .prof-dot { background: var(--red); }
  .spend-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); background: var(--surface2); border: 1px solid var(--border);
    border-radius: 10px; padding: 1px 8px; }
  .spend-pill.needs-login { color: var(--red); background: rgba(248,81,73,0.12);
    border-color: rgba(248,81,73,0.35); }
  a.spend-pill { text-decoration: none; }
  a.spend-pill:hover { border-color: var(--red); }
  ${reorderCss}
  ${profileProvidersCss}
  ${profileCardStatusCss}
  /* The name row carries every badge the card can earn - Active, the plan
     chip, pool position, exhausted/refused, needs login, spent - and on a
     narrow card they do not fit beside the cost. The row wraps its badges
     onto further lines and may break a long label (an email) anywhere; the
     cost never shrinks, and once the name would get narrower than 12em the
     cost moves to its own right-aligned line. Nothing is pushed past the
     card's edge. When everything fits on one line, as on a desktop, none of
     this changes the layout. */
  .profile-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: 2px 8px; margin-bottom: 4px; }
  .profile-name { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;
    flex: 1 1 12em; flex-wrap: wrap; row-gap: 4px; min-width: 0; overflow-wrap: anywhere; }
  .profile-name .prof-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: var(--border); }
  .profile-card.active .prof-dot { background: var(--brand, var(--accent)); box-shadow: 0 0 6px rgba(var(--brand-rgb, 88,166,255),0.5); }
  .active-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--brand-bright, var(--accent)); background: rgba(var(--brand-rgb, 88,166,255),0.12);
    border: 1px solid rgba(var(--brand-rgb, 88,166,255),0.35);
    border-radius: 10px; padding: 1px 8px; }
  .provider-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    border-radius: 10px; padding: 1px 8px; }
  .switch-hint { font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); opacity: 0; transition: opacity 0.15s; }
  .profile-card.switchable:hover .switch-hint { opacity: 1; }
  .profile-cost { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); flex-shrink: 0; margin-left: auto; }

  /* Account details on hover. Drawn rather than a title attribute: the native
     tooltip cannot show a label/value list, and this one has to match the grid
     on /profiles row for row. */
  .prof-info { position: relative; display: inline-flex; }
  .prof-info-dot { width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%;
    border: 1px solid var(--border); background: var(--surface2); color: var(--muted);
    font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-size: 10px;
    font-weight: 700; line-height: 12px; text-align: center; cursor: help; }
  .prof-info:hover .prof-info-dot, .prof-info:focus-within .prof-info-dot {
    border-color: var(--accent); color: var(--accent); }
  .prof-info-dot:focus-visible { outline: none; border-color: var(--accent); color: var(--accent); }
  .prof-pop { position: absolute; top: calc(100% + 8px); left: -8px; z-index: 20;
    min-width: 256px; padding: 12px 14px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    opacity: 0; visibility: hidden; transition: opacity 0.12s;
    text-align: left; font-weight: 400; letter-spacing: 0; text-transform: none; cursor: default;
    overflow-wrap: normal; }
  .prof-info:hover .prof-pop, .prof-info:focus-within .prof-pop { opacity: 1; visibility: visible; }
  .prof-pop-type { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--accent2); margin-bottom: 8px; }
  .prof-pop-grid { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; font-size: 11px; }
  .prof-pop-link { display: block; margin-top: 10px; font-size: 11px; color: var(--accent); text-decoration: none; }
  .prof-pop-link:hover { text-decoration: underline; }
  .prof-pop-label { color: var(--muted); white-space: nowrap; }
  .prof-pop-value { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; word-break: break-word; }
  .prof-pop-value.status-ok { color: var(--green); }
  .prof-pop-value.status-err { color: var(--red); }
  .prof-pop-value.status-warn { color: var(--yellow); }
  .prof-pop-value[tabindex]:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .prof-pop-value .cached-tag { color: var(--muted); font-size: 10px; font-style: italic; white-space: nowrap; }
  .prof-pop-value .fact-explanation { display: none; margin-top: 4px; color: var(--muted); font-family: inherit; line-height: 1.4; }
  .prof-pop-value:focus > .fact-explanation { display: block; }
  /* A hidden overlay still counts toward the page's scroll width, and one
     hung off the icon at 256px or more reaches past a phone's right edge.
     On a narrow screen it spans the card's header row instead. */
  @media (max-width: 720px) {
    .profile-head { position: relative; }
    .prof-info { position: static; }
    .prof-pop { left: 0; right: 0; min-width: 0; }
  }
  /* A phone shows one card per row, each packed with usage rows and chips,
     so the page edge and the card's own padding give that room back. */
  @media (max-width: 720px) {
    .container { padding-left: 8px; padding-right: 8px; }
    .profile-card { padding: 9px 10px; }
  }
  .profile-sub { font-size: 11px; color: var(--muted); text-align: right; margin-bottom: 12px; }
  .usage-row { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 4px 0; }
  .usage-row .w-label { color: var(--muted); width: 64px; flex-shrink: 0; }
  .usage-row .w-bar { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
  .usage-row .w-fill { height: 100%; border-radius: 3px; }
  .pace-row { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
  .pace-row .w-bar { overflow: visible; position: relative; }
  .pace-marker { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text); opacity: 0.55; border-radius: 1px; }
  .pace-row .w-pct { font-weight: 600; }
  .pool-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--surface2); color: var(--muted); margin-left: 6px; vertical-align: middle; }
  .pool-chip.exhausted { color: var(--red); background: rgba(248,81,73,0.12); }
  .plan-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--surface2);
    color: var(--accent2); margin-left: 6px; vertical-align: middle; font-variant-numeric: tabular-nums; }
  .spent-banner { font-size: 12px; line-height: 1.45; color: var(--text); margin-bottom: 10px;
    padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(248,81,73,0.35); background: rgba(248,81,73,0.1); }
  .spent-banner strong { color: var(--red); }
  .spent-banner-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .usage-row .w-pct { width: 38px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .usage-row .w-reset { color: var(--muted); font-size: 11px; width: 76px; text-align: right; }
  .no-usage { font-size: 12px; color: var(--muted); padding: 4px 0; }
  .empty-accounts { font-size: 13px; color: var(--muted); padding: 16px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 10px; }
  .empty-accounts a { color: var(--accent); }
  .past-usage { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 16px; }
  .past-row { display: flex; gap: 12px; align-items: baseline; font-size: 12px; padding: 6px 0;
    border-bottom: 1px solid var(--border); }
  .past-row:last-child { border-bottom: none; }
  .past-id { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--muted); }
  .past-note { font-size: 11px; }
  .past-req, .past-cost { color: var(--muted); white-space: nowrap; }
  @media (max-width: 720px) {
    .sort-tab { min-height: 40px; }
  }
  .credits-row .w-credits { flex: 1; min-width: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
  .credits-row .w-credits.serving { color: var(--yellow); }
  .credits-row .w-credits-note { color: var(--muted); font-size: 11px; text-align: right; min-width: 0; overflow-wrap: anywhere; }
  .credits-row .w-credits-note.credits-pace { flex: 1; text-align: left; }
  .pool-chip.on-credits { color: var(--yellow); background: rgba(210,153,34,0.15); }

  /* Traffic strip — one compact surface */
  .strip { display: flex; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 4px; margin-bottom: 24px; }
  .strip-item { flex: 1; min-width: 120px; padding: 2px 18px; border-right: 1px solid var(--border); }
  .strip-item:last-child { border-right: none; }
  .strip-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .strip-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .strip-value.green { color: var(--green); }
  .strip-value.red { color: var(--red); }
  .strip-detail { font-size: 11px; color: var(--muted); }
  .strip-detail.red { color: var(--red); }

  .section { margin-bottom: 24px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 12px; }

  /* Tabs rather than a dropdown: the current order stays legible without
     opening anything, which is the whole job of this page. */
  .section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 12px; }
  .section-head .section-title { margin-bottom: 0; }
  .sort-tabs { display: flex; flex-wrap: wrap; gap: 2px; min-width: 0; max-width: 100%; }
  .sort-tab { background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--muted); font-family: inherit; font-size: 11px; font-weight: 500;
    letter-spacing: 0.3px; padding: 2px 8px 3px; cursor: pointer; }
  .sort-tab:hover { color: var(--text); }
  .sort-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .sort-tab:focus-visible { outline: none; color: var(--accent); border-bottom-color: var(--accent); }

  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--muted); text-align: center; }
  .footer a { color: var(--accent); text-decoration: none; }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
  <div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading…</div></div>
  ${reorderLiveRegionHtml}
</div>
<script>
` + profileFactsJs + profileFindJs + `
function ms(v){if(v==null||v===0)return '—';return v<1000?v+'ms':(v/1000).toFixed(1)+'s'}
function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]})}
function usd(v){if(v==null)return '—';if(v>0&&v<0.01)return '$'+v.toFixed(4);if(v<100)return '$'+v.toFixed(2);return '$'+Math.round(v).toLocaleString()}

var WIN_LABELS={five_hour:'5h',seven_day:'7d',seven_day_opus:'7d Opus',seven_day_sonnet:'7d Sonnet',seven_day_fable:'7d Fable',seven_day_oauth_apps:'7d Apps',seven_day_cowork:'7d Cowork',seven_day_omelette:'7d Omelette'};
function winLabel(t){if(WIN_LABELS[t])return WIN_LABELS[t];return t.replace(/^seven_day_/,'7d ').replace(/_/g,' ').replace(/\\b\\w/g,function(c){return c.toUpperCase()})}
function utilColor(u){return u>=0.85?'var(--red)':u>=0.6?'var(--yellow)':'var(--green)'}
// Mirrors computeWeeklyPace in src/telemetry/profileUsage.ts (unit-tested
// there): actual vs expected (even) consumption at this point in the 7-day
// window, with the dashboard's over-promotion when the projection hits 100%.
function weeklyPace(u,resetsAt){
  var WEEK=7*86400000;
  if(u==null||resetsAt==null)return null;
  var el=Math.max(0,Math.min(1,(Date.now()-(resetsAt-WEEK))/WEEK));
  var actual=Math.round(Math.max(0,u)*100);
  var expected=Math.round(el*100);
  var delta=actual-expected;
  var proj=el>=0.1?Math.round((Math.max(0,u)/el)*100):null;
  var st=delta>7?'ahead':delta<-7?'under':'on';
  if(proj!=null&&proj>=100)st='over';
  return {actual:actual,expected:expected,delta:delta,proj:proj,status:st};
}
function paceText(pc){
  if(pc.status==='over')return 'on track to run out';
  if(pc.status==='ahead')return '+'+pc.delta+'% ahead of pace';
  if(pc.status==='under')return Math.abs(pc.delta)+'% under pace';
  return 'on pace';
}
function paceColor(pc){return pc.status==='over'?'var(--red)':pc.status==='ahead'?'var(--yellow)':'var(--green)'}

function resetIn(ts){if(ts==null)return '';var d=ts-Date.now();if(d<=0)return 'resetting…';var m=Math.ceil(d/60000);if(m<60)return 'in '+m+'m';var h=Math.floor(m/60);if(h<24)return 'in '+h+'h'+(m%60?' '+(m%60)+'m':'');var days=Math.floor(h/24);return 'in '+days+'d'+(h%24?' '+(h%24)+'h':'')}

// Inlined from src/telemetry/profileSpent.ts, unit-tested in
// profile-spent.test.ts — same arrangement as weeklyPace above.
var GENERAL_WINDOW_TYPES=${JSON.stringify(GENERAL_WINDOW_TYPES)};
var FADE_FROM=${FADE_FROM};
var SPENT_AT=${SPENT_AT};
${isUnusableJs}
function generalUtilization(windows,provider){
  var everyWindow=provider==='chatgpt';
  var worst=null;
  for(var i=0;i<(windows||[]).length;i++){
    var w=windows[i];
    if(!everyWindow&&GENERAL_WINDOW_TYPES.indexOf(w.type)<0)continue;
    if(w.utilization==null||!isFinite(w.utilization))continue;
    var c=Math.max(0,Math.min(1,w.utilization));
    if(worst==null||c>worst)worst=c;
  }
  return worst;
}
function computeProfileSpend(p){
  if(isUnusable(p))return {fraction:1,state:'spent',fade:0,reason:'unusable'};
  var f=generalUtilization(p.windows,p.provider);
  if(f==null)return {fraction:null,state:'unknown',fade:0,reason:null};
  if(f>=SPENT_AT)return {fraction:f,state:'spent',fade:1,reason:'usage'};
  if(f>=FADE_FROM)return {fraction:f,state:'fading',fade:(f-FADE_FROM)/(SPENT_AT-FADE_FROM),reason:null};
  return {fraction:f,state:'available',fade:0,reason:null};
}

// Inlined from src/telemetry/profileSort.ts, unit-tested in
// profile-sort.test.ts.
var PROFILE_SORT_MODES=${JSON.stringify(PROFILE_SORT_MODES)};
var viewSort=${JSON.stringify(DEFAULT_PROFILE_SORT)};
function sortProfilesForView(items,mode,spentOf){
  var list=items.slice();
  if(mode==='configured')return list;
  var direction=mode==='spent-desc'?-1:1;
  return list
    .map(function(item,index){return {item:item,index:index,spent:spentOf(item)}})
    .sort(function(a,b){
      if(a.spent==null||b.spent==null){
        if(a.spent==null&&b.spent==null)return a.index-b.index;
        return a.spent==null?1:-1;
      }
      if(a.spent!==b.spent)return (a.spent-b.spent)*direction;
      return a.index-b.index;
    })
    .map(function(entry){return entry.item});
}
function sortTabs(count){
  if(count<2)return '';
  var out='';
  for(var i=0;i<PROFILE_SORT_MODES.length;i++){
    var m=PROFILE_SORT_MODES[i];var on=m.id===viewSort;
    out+='<button type="button" class="sort-tab'+(on?' active':'')+'" data-sort="'+esc(m.id)+'"'
      +' title="'+esc(m.title)+'" aria-pressed="'+(on?'true':'false')+'">'+esc(m.label)+'</button>';
  }
  return '<div class="sort-tabs" role="group" aria-label="Sort accounts">'+out+'</div>';
}

// Re-sorting must not wait for the next 10s poll, so the last payload is
// kept and re-rendered from memory. The choice is a view preference and is
// never sent to the server — the saved pool order (/settings) is untouched.
var SORT_STORAGE_KEY='meridian.accountSort';
var lastData=null;
function readStoredSort(){
  try{
    var stored=localStorage.getItem(SORT_STORAGE_KEY);
    for(var i=0;i<PROFILE_SORT_MODES.length;i++)if(PROFILE_SORT_MODES[i].id===stored)return stored;
  }catch(_){/* storage blocked (private mode) — the default is fine */}
  return null;
}
function setViewSort(mode){
  if(mode===viewSort)return;
  var refocus=!!(document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.sort-tab'));
  viewSort=mode;
  try{localStorage.setItem(SORT_STORAGE_KEY,mode)}catch(_){/* a lost preference is not worth failing over */}
  if(lastData)render(lastData[0],lastData[1],lastData[2],lastData[3]);
  if(refocus){var el=document.querySelector('.sort-tab[data-sort="'+mode+'"]');if(el)el.focus()}
}

${reorderClientJs}
${profileProvidersJs}
${domPatchJs}
${profileCardStatusJs}

var providersPresent=[];

// A chip hides or shows its provider's cards where they stand. Hidden cards
// stay in the page, so a drag still saves their place in the order.
function applyProviderFilter(){
  var root=document.getElementById('content');
  var grouped=root.querySelectorAll('[data-group]');
  for(var i=0;i<grouped.length;i++)grouped[i].hidden=!meridianProviders.visible(grouped[i].getAttribute('data-group'),providersPresent);
  meridianProviders.syncChips(root);
  var none=root.querySelector('.provider-none');
  if(none)none.hidden=meridianProviders.anyShown(providersPresent);
}
// Whether this instance serves Claude at all. An instance that serves ChatGPT
// and has neither a Claude login nor a Claude profile does not, and its page
// must not describe a Claude account it never had.
function servesClaude(h,pl){
  if(h&&h.auth&&h.auth.loggedIn)return true;
  var ps=(pl&&Array.isArray(pl.profiles))?pl.profiles:[];
  for(var i=0;i<ps.length;i++)if(!isChatGptProfile(ps[i]))return true;
  // /profiles/list can fail on its own; /health says ChatGPT too, so a
  // failed list does not bring the Claude wording back.
  return !(pl&&pl.chatgpt)&&!(h&&h.chatgpt);
}

// Telemetry is filed under whatever profile served a request, and under
// "default" when none did (a refused or failed turn). Ids that match no card
// on this page - a seat that was removed, a store this instance no longer
// follows, unattributed turns - are listed here, never drawn as accounts.
function pastUsage(byProfile,cards){
  var shown={};
  for(var i=0;i<cards.length;i++){var c=cards[i];shown[c.id]=1;var al=(c.entry&&c.entry.aliases)||[];for(var j=0;j<al.length;j++)shown[al[j]]=1}
  var rows=[];
  for(var k in byProfile){if(shown[k])continue;var u=byProfile[k];if(!u||!u.requests)continue;rows.push({id:k,requests:u.requests,estimatedUsd:u.estimatedUsd||0})}
  rows.sort(function(a,b){return b.requests-a.requests});
  return rows;
}

function pastUsageSection(rows){
  if(rows.length===0)return '';
  var items='';
  for(var i=0;i<rows.length;i++){var r=rows[i];
    items+='<div class="past-row"><span class="past-id">'+(r.id==='default'?'unattributed <span class="past-note">(served by no account)</span>':esc(r.id))+'</span>'
      +'<span class="past-req">'+r.requests+' request'+(r.requests===1?'':'s')+'</span><span class="past-cost">'+usd(r.estimatedUsd)+'</span></div>';
  }
  return '<div class="section"><div class="section-title">Past usage · not a configured account · 24h</div><div class="past-usage">'+items+'</div></div>';
}

function introSection(h,pl){
  var meta=[];
  if(h.auth&&h.auth.loggedIn)meta.push(esc(h.auth.email||'')+(h.auth.subscriptionType?' ('+esc(h.auth.subscriptionType)+')':''));
  meta.push(h.mode||'internal');
  if(location.port)meta.push('port '+location.port);
  var chatgpt=!!h.chatgpt;
  var claude=servesClaude(h,pl);
  var base=location.origin;
  var chatgptLine=' For ChatGPT, point an OpenAI Responses client (opencode’s <code>openai-meridian</code> provider) at <code>'+esc(base)+'/v1</code>: each turn goes to the active seat below, then to the others in their order.';
  if(chatgpt&&!claude){
    return '<div class="intro">'
      +'<h2>ChatGPT, in your tools.</h2>'
      +'<p>This page manages the ChatGPT seats this Meridian serves.'+chatgptLine
      +' Connect a seat on <a href="/profiles">Profiles</a>.</p>'
      +'<div class="intro-meta">'+meta.join(' · ')+'</div>'
      +'</div>';
  }
  return '<div class="intro">'
    +'<h2>'+(chatgpt?'Claude, ChatGPT &amp; Antigravity':'Claude &amp; Antigravity')+', in your tools.</h2>'
    +'<p>This page manages '+(chatgpt?'Claude accounts and ChatGPT seats':'Claude accounts')+'. Use <a href="/providers">Providers</a> to connect Claude or Antigravity. For Claude, point your supported client’s <code>ANTHROPIC_BASE_URL</code> at <code>'+esc(base)+'</code> and every request routes through the active account below.'
    +(chatgpt?chatgptLine:'')
    +' Setup guides for each agent live in the <a href="https://github.com/rynfar/meridian/blob/main/docs/agents.md">Agent Setup guide</a>.</p>'
    +'<div class="intro-meta">'+meta.join(' · ')+'</div>'
    +'</div>';
}

// A renamed profile's traffic from before the rename is filed under its former
// names, so the 24h line sums every name the profile has answered to.
function profileCost(byProfile,p){
  var ids=[p.id].concat((p.entry&&p.entry.aliases)||[]);var sum=null;
  for(var i=0;i<ids.length;i++){var c=byProfile[ids[i]];if(!c)continue;if(!sum)sum={requests:0,estimatedUsd:0};sum.requests+=c.requests||0;sum.estimatedUsd+=c.estimatedUsd||0}
  return sum;
}

function infoIcon(entry,type){
  var facts=profileFacts(entry);
  var rows='';
  for(var i=0;i<facts.length;i++){
    var f=facts[i];
    var tone=f.tone==='ok'?' status-ok':f.tone==='err'?' status-err':f.tone==='warn'?' status-warn':'';
    var title=f.title?' title="'+esc(f.title)+'" tabindex="0" aria-label="'+esc(f.label+': '+f.value+'. '+f.title)+'"':'';
    var cached=f.cached?' <span class="cached-tag">(cached)</span>':'';
    var explanation=f.title?'<span class="fact-explanation" aria-hidden="true">'+esc(f.title)+'</span>':'';
    rows+='<span class="prof-pop-label">'+esc(f.label)+'</span>'
      +'<span class="prof-pop-value'+tone+'"'+title+'>'+esc(f.value)+cached+explanation+'</span>';
  }
  return '<span class="prof-info">'
    +'<span class="prof-info-dot" tabindex="0" role="button" aria-label="Details for '+esc(entry.id)+'">i</span>'
    +'<span class="prof-pop" role="tooltip">'
    +'<span class="prof-pop-type">'+esc(type||'claude-max')+'</span>'
    +'<span class="prof-pop-grid">'+rows+'</span>'
    +'<a class="prof-pop-link" href="'+esc(profileHref(entry.id))+'">Open in Profiles \\u2192</a>'
    +'</span></span>';
}

// Retain the active element across a switch to another application too:
// activeElement survives that switch even when CSS :focus-within does not.
function infoPopOpen(){
  var active=document.activeElement;
  return !!document.querySelector('.prof-info:hover, .prof-info:focus-within')
    || !!(active && active.closest('.prof-info'));
}

function profileSection(q,s,pl,h){
  var byProfile=(s&&s.costEstimate&&s.costEstimate.byProfile)||{};
  var quotaByProfile={};
  var spentByProfile={};
  if(q&&Array.isArray(q.profiles))for(var i=0;i<q.profiles.length;i++){var qid=q.profiles[i].id||q.profiles[i].profile||'default';quotaByProfile[qid]=q.profiles[i];if(q.profiles[i].spent)spentByProfile[qid]=q.profiles[i].spent}
  var profs=[];var seen={};
  var configured=(pl&&Array.isArray(pl.profiles))?pl.profiles:[];
  var multi=configured.length>1;
  var entryById={};for(var i=0;i<configured.length;i++)entryById[configured[i].id]=configured[i];
  if(configured.length>0){\n    // Real profiles exist: show exactly those. Traffic that predates
    // per-profile attribution (the synthetic "default" bucket) still
    // counts in the totals strip but doesn't render as a fake account.
    // The whole entry rides along so the details overlay reads it directly —
    // a copied field list here would have to grow every time profileFacts does.
    for(var i=0;i<configured.length;i++){var p=configured[i];profs.push({id:p.id,label:p.id,type:p.type,isActive:!!p.isActive,loggedIn:p.loggedIn,configured:true,allowance:p.allowance,planLabel:p.planLabel,rateLimitTier:p.rateLimitTier,entry:p});seen[p.id]=1}
  }else if(servesClaude(h,pl)){
    // Single-account setup: the ambient Claude login is the one account,
    // labeled with its email. Any other id in telemetry is past usage.
    var email=(h&&h.auth&&h.auth.loggedIn&&h.auth.email)||'';
    profs.push({id:'default',label:email||'account',configured:false});
  }
  if(profs.length===0){
    if(!(pl&&pl.chatgpt))return {html:'',shown:[]};
    return {shown:[],html:'<div class="section"><div class="section-head"><div class="section-title">Accounts</div></div>'
      +'<div class="empty-accounts">No ChatGPT seat is connected yet. Name one under <a href="/profiles">Add a profile</a>, then choose <strong>Connect with ChatGPT</strong>.</div></div>'};
  }
  // The persisted order is the base order everywhere. /profiles writes it;
  // this page read config order instead, so the two disagreed after a drag.
  profs=meridianReorder.sortProfiles(profs);
  function spentOf(p){
    var quota=quotaByProfile[p.id]||{};
    return computeProfileSpend({windows:quota.windows,error:quota.error,loggedIn:p.loggedIn,provider:p.entry&&p.entry.provider}).fraction;
  }
  profs=sortProfilesForView(profs,viewSort,spentOf);
  // One grid, a group per provider. Grouping keeps the order each card
  // arrived in, so the view sort above applies within every group.
  var groups=meridianProviders.group(profs,function(p){return meridianProviders.providerOf(p.entry||p)});
  var slots=meridianProviders.slots(groups);
  var grouped=groups.length>1;
  providersPresent=groups.map(function(g){return g.provider});
  var reorderable=multi&&!meridianReorder.envPinned()&&viewSort==='configured';
  var cards='';
  var shown=[];
  var pos=0;
  for(var i=0;i<slots.length;i++){
    var slot=slots[i];
    var update=slot.item.entry?meridianCardStatus.updateOf(slot.item.entry,null):null;
    var updating=!!(update&&update.state==='updating');
    var providerHidden=!meridianProviders.visible(slot.provider,providersPresent);
    if(grouped&&slot.place===0)cards+=meridianProviders.headingHtml(slot.group,providerHidden);
    var p=slot.item;var cost=profileCost(byProfile,p);
    var chat=isChatGptProfile(p.entry);
    var quota=quotaByProfile[p.id]||{};
    var wins=(quota.windows||[]).filter(function(w){return w.utilization!=null});
    var spend=computeProfileSpend({windows:quota.windows,error:quota.error,loggedIn:p.loggedIn,provider:p.entry&&p.entry.provider});
    if(!p.configured&&wins.length===0&&!cost)continue;
    shown.push(p);
    var rows='';
    for(var j=0;j<wins.length;j++){
      var w=wins[j];var pct=Math.round(w.utilization*100);
      rows+='<div class="usage-row"><span class="w-label">'+esc(winLabel(w.type))+'</span>'
        +'<div class="w-bar"><div class="w-fill" style="width:'+Math.min(pct,100)+'%;background:'+utilColor(w.utilization)+'"></div></div>'
        +'<span class="w-pct" style="color:'+utilColor(w.utilization)+'">'+pct+'%</span>'
        +'<span class="w-reset">'+resetIn(w.resetsAt)+'</span></div>';
    }
    var weekly=null;
    for(var j=0;j<wins.length;j++){if(wins[j].type==='seven_day')weekly=wins[j]}
    var pc=weekly?weeklyPace(weekly.utilization,weekly.resetsAt):null;
    if(pc){\n      // Visual actual-vs-expected: fill = actual usage (status-colored),
      // tick marker = where even pace would be. The gap IS the pace.
      var paceTip=paceText(pc)+' · '+pc.actual+'% used vs '+pc.expected+'% expected'+(pc.proj!=null?' · ~'+pc.proj+'% by reset':'');
      var deltaLabel=pc.status==='over'?(pc.proj!=null?pc.proj+'%':'100%'):(pc.delta>=0?'+':'−')+Math.abs(pc.delta)+'%';
      rows+='<div class="usage-row pace-row" title="'+paceTip+'"><span class="w-label">pace</span>'
        +'<div class="w-bar"><div class="w-fill" style="width:'+Math.min(pc.actual,100)+'%;background:'+paceColor(pc)+'"></div>'
        +'<div class="pace-marker" style="left:'+Math.min(pc.expected,100)+'%" title="expected at even pace ('+pc.expected+'%)"></div></div>'
        +'<span class="w-pct" style="color:'+paceColor(pc)+'">'+deltaLabel+'</span>'
        +'<span class="w-reset">'+(pc.status==='over'?'runs out before reset':pc.proj!=null?'~'+pc.proj+'% by reset':'')+'</span></div>';
    }
    if(!rows){
      var gap=chat?chatGptUsageGap(quota.error):'';
      rows='<div class="no-usage">'+(gap?'no reading \u2014 '+esc(gap):'no usage data yet')+'</div>';
    }
    // The same facts as the /profiles card's credits block, from the same view.
    var credits=chat?codexCreditsView(quota.credits,quota):null;
    if(credits)rows+='<div class="usage-row credits-row" title="'+esc(credits.note)+'"><span class="w-label">credits</span>'
      +'<span class="w-credits'+(credits.serving?' serving':'')+'">'+esc(credits.value)+'</span>'
      +'<span class="w-credits-note">'+esc(credits.serving?'serving on credits':credits.policy||credits.note)+'</span></div>'
      +(credits.pace?'<div class="usage-row credits-row" title="'+esc(credits.pace.title)+'"><span class="w-label">lasts</span>'
        +'<span class="w-credits-note credits-pace">'+esc(credits.pace.text)+'</span></div>':'');
    var isPriority=pl&&pl.routing==='priority';
    // active+priority keeps the active profile meaningful - switching it is how
    // you move traffic, so the card stays clickable, unlike in pure priority.
    var isActivePriority=pl&&pl.routing==='active+priority';
    var follow=pl&&pl.follow;
    // A ChatGPT seat has an active pointer of its own that neither priority
    // routing nor follow mode takes over, so it is switchable in every mode.
    var switchable=multi&&p.configured&&!p.isActive&&(chat||(!isPriority&&!follow));
    var badge=isPriority&&!chat?'':p.isActive?'<span class="active-pill">Active</span>':switchable?'<span class="switch-hint">Click to activate</span>':'';
    if(follow&&p.isActive&&!chat)badge+=' <span class="pool-chip">'+(follow.activeProfile?'following '+esc(follow.url):'local — '+esc(follow.url)+' unreachable')+(follow.stale?' · stale':'')+'</span>';
    // Sits beside the name because it qualifies the percentages below it: 70%
    // of a 20x account is several times the work left in 70% of a 5x one.
    if(p.allowance)badge+='<span class="plan-chip" title="'+esc((p.planLabel||'')+(p.rateLimitTier?' · '+p.rateLimitTier:''))+'">'+esc(p.allowance)+'</span>';
    if(isPriority||isActivePriority){
      // Positions count within one provider: a Claude turn never falls over
      // to a ChatGPT seat. A seat is always tried after the active seat, so
      // its place is a fallback one in either mode.
      var poolOrder=(pl.profileOrder||[]).filter(function(id){return !!entryById[id]&&isChatGptProfile(entryById[id])===chat});
      var orderIdx=poolOrder.indexOf(p.id);
      if(orderIdx>=0)badge+='<span class="pool-chip">'+(isActivePriority||chat?'#'+(orderIdx+1)+' fallback':'#'+(orderIdx+1)+' in pool')+'</span>';
      var exh=(pl.exhausted||[]).filter(function(e){return e.id===p.id})[0];
      // Suppressed when a refusal is being reported below: both say the same
      // thing, and the banner says it better.
      if(exh&&!spentByProfile[p.id]){\n        // A billing refusal has no reset to wait for — the pool re-probes on the
        // same timer, but nothing changes until a human fixes the account.
        // Showing it as 'resets in 9m' promises a recovery that never comes.
        badge+=exh.reason==='billing_error'
          ?' <span class="pool-chip exhausted" title="Subscription or payment refused — this does not clear on its own">subscription refused</span>'
          :exh.reason==='requires_reauth'
            ?' <span class="pool-chip exhausted" title="chatgpt.com refused this seat\u2019s access token; it is tried again then">token refused · retry '+resetIn(exh.until)+'</span>'
            :' <span class="pool-chip exhausted">exhausted · resets '+resetIn(exh.until)+'</span>';
      }
    }
    if(credits&&credits.serving)badge+=' <span class="pool-chip on-credits" title="This seat\u2019s plan usage is spent; its turns are paid with Codex credits">on credits</span>';
    var sp=spentByProfile[p.id];
    var spentBanner='';
    if(sp){\n      var spBucket=(sp.diagnosis&&sp.diagnosis.bucket)?winLabel(sp.diagnosis.bucket):'its limit';
      var spGuess=(sp.diagnosis&&sp.diagnosis.reported)?'':' (guess)';
      var refused=refusalSubject(p.entry);
      badge+=' <span class="pool-chip exhausted">out of '+esc(spBucket+spGuess)+'</span>';
      // A full-width line immediately above the usage bars, not a chip beside
      // the name: measured in review, a 10px chip wraps to four lines in a
      // narrow card and loses to the large "67%" rendered right below it -
      // which is the exact misreading this whole feature exists to stop.
      spentBanner='<div class="spent-banner" title="'+esc((sp.diagnosis&&sp.diagnosis.rationale)||'')+'">'
        +'<strong>⚠ '+refused.vendor+' is refusing this '+refused.noun+'</strong> - out of '+esc(spBucket+spGuess)
        +(sp.until?', back '+resetIn(sp.until):'')
        +'<div class="spent-banner-sub">figures below are the last successful read, not live</div></div>';
    }
    var access=spend.reason==='unusable'?profileAccessHelp(p.entry||p):null;
    if(access)badge+=' '+(p.configured
      ?'<a class="spend-pill needs-login" href="'+esc(profileHref(p.id))+'" title="'+esc(chat?access.summary:'Open this profile to log in again')+'">'+esc(access.pill)+'</a>'
      :'<span class="spend-pill needs-login">'+esc(access.pill)+'</span>');
    else if(spend.state==='spent')badge+=' <span class="spend-pill">spent</span>';
    // A free-plan seat serves unpinned work after the paid ones even while it
    // is the active seat, which the active badge alone would hide.
    var freeFact=chat&&p.entry&&p.entry.planTier==='free'?profileFacts(p.entry).filter(function(f){return f.label==='Routing'})[0]:null;
    if(p.entry)badge+=' '+meridianCardStatus.duplicateBadgeHtml(p.entry,'pool-chip');
    if(freeFact)badge+=' <span class="spend-pill" title="'+esc(freeFact.value+'. '+freeFact.title)+'">'+esc(p.entry.freeSeatDeferred?'free \u00b7 paid seats first':'free plan')+'</span>';
    var spendClass=spend.reason==='unusable'?' needs-login':spend.fade>0?' spend-'+spend.state:'';
    var spendStyle=spend.fade>0?' style="--spend-fade:'+spend.fade.toFixed(2)+'"':'';
    var spendTip=access?' title="'+esc(access.summary)+'"'
      :spend.fraction!=null&&spend.fade>0?' title="'+Math.round(spend.fraction*100)+'% of this '+(chat?'seat\u2019s allowance':'account\u2019s 5h / 7d allowance')+' is used"':'';
    // A provider's only card has nowhere to move, so it gets no handle.
    var draggable=reorderable&&p.configured&&slot.size>1;
    cards+='<div class="profile-card provider-'+esc(slot.provider)+(p.isActive?' active':'')+(switchable?' switchable':'')+spendClass+(updating?' updating" aria-busy="true':'')+'"'+spendStyle+spendTip
      +' data-key="card:'+esc(p.id)+'"'
      +' data-group="'+esc(slot.provider)+'"'+(providerHidden?' hidden':'')
      +(p.configured?' data-id="'+esc(p.id)+'" data-index="'+pos+'"':'')
      +(switchable?' data-profile="'+esc(p.id)+'" role="button" tabindex="0"':'')+'>'
      +'<div class="profile-head"><span class="profile-name">'+(draggable?meridianReorder.handleHtml(p.id,pos,slot.place,slot.size):'')+'<span class="prof-dot"></span>'+(p.entry?infoIcon(p.entry,p.type):'')+''+esc(p.label||p.id)+' '+meridianProviders.badgeHtml(slot.provider,'provider-pill')+badge+'</span>'
      +'<span class="profile-cost">'+usd(cost?cost.estimatedUsd:0)+'</span></div>'
      +'<div class="profile-sub">'+(cost?cost.requests+' request'+(cost.requests===1?'':'s')+' · est. API value · 24h':'no traffic · 24h')+'</div>'
      +meridianCardStatus.updateHtml(update)+spentBanner+rows+'</div>';
    if(p.configured)pos++;
  }
  if(!cards)return {html:'',shown:shown};
  return {shown:shown,html:'<div class="section"><div class="section-head"><div class="section-title">'+(profs.length===1?'Account':'Accounts')+'</div>'+sortTabs(profs.length)+'</div>'
    +meridianProviders.chipsHtml(groups)
    +(multi?meridianReorder.noteHtml(reorderable,configured.some(isChatGptProfile),grouped):'')
    +(grouped?meridianProviders.noneShownHtml(meridianProviders.anyShown(providersPresent)):'')
    +'<div class="profile-grid">'+cards+'</div></div>'};
}

function strip(items){
  var o='<div class="strip">';
  for(var i=0;i<items.length;i++){var it=items[i];
    o+='<div class="strip-item"><div class="strip-label">'+it[0]+'</div><div class="strip-value '+(it[2]||'')+'">'+it[1]+'</div>'+(it[3]?'<div class="strip-detail '+(it[4]||'')+'">'+it[3]+'</div>':'')+'</div>';
  }
  return o+'</div>';
}

async function refresh(){
  if(infoPopOpen())return;
  try{
    const [health,stats,quota,profiles,routing]=await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/telemetry/summary?window=86400000').then(r=>r.json()),
      fetch('/v1/usage/quota/all').then(r=>r.json()).catch(function(){return null}),
      fetch('/profiles/list').then(r=>r.json()).catch(function(){return null}),
      fetch('/settings/api/routing').then(r=>r.json()).catch(function(){return null})
    ]);
    if(infoPopOpen())return;
    meridianReorder.adopt(routing);
    render(health,stats,quota,profiles);
  }catch(e){if(!infoPopOpen())document.getElementById('content').innerHTML='<div style="color:var(--red);padding:40px;text-align:center">Could not connect</div>'}
}

function tokens(v){if(v==null)return '—';if(v>=1e6)return (v/1e6).toFixed(1)+'M';if(v>=1e3)return (v/1e3).toFixed(1)+'k';return String(v)}

function render(h,s,q,pl){
  lastData=[h,s,q,pl];
  var refocusId=meridianReorder.focusAnchor();
  var focused=document.activeElement;
  var refocusChip=focused&&focused.getAttribute?focused.getAttribute('data-provider-chip'):null;
  let o='';
  o+=introSection(h,pl);

  // Accounts — per-profile usage + est cost; click a card to switch
  var accounts=profileSection(q,s,pl,h);
  o+=accounts.html;

  // Last 24 hours — meaningful signals only. Errors and envelope
  // violations appear only when there is something to report.
  var tu=s.tokenUsage||{};
  var cache=tu.avgCacheHitRate!=null?Math.round(tu.avgCacheHitRate*100)+'%':'—';
  var items=[\n    // The big number is the TOTAL — never error-colored (a red 1714 reads as
    // 1714 failures). The error signal lives on the detail line only.
    ['Requests',String(s.totalRequests),'',s.errorCount>0?s.errorCount+' error'+(s.errorCount===1?'':'s'):'no errors',s.errorCount>0?'red':''],
    ['Tokens Out',tokens(tu.totalOutputTokens),'',tokens(tu.totalInputTokens)+' in'],
    ['Cache Hit',cache,tu.avgCacheHitRate>=0.5?'green':'','prompt cache'],
    ['Est. API Value',usd(s.costEstimate?.totalUsd),'','list prices'],
    ['Median Response',ms(s.totalDuration?.p50),'','p95 '+ms(s.totalDuration?.p95)]
  ];
  if(s.envelopeViolationCount>0)items.push(['Envelope',String(s.envelopeViolationCount),'red','wire-contract violations']);
  o+='<div class="section"><div class="section-title">Last 24 Hours</div>'+strip(items)+'</div>';
  o+=pastUsageSection(pastUsage((s.costEstimate&&s.costEstimate.byProfile)||{},accounts.shown));

  o+='<div class="footer">Meridian · <a href="https://github.com/rynfar/meridian">GitHub</a> · Built on the <a href="https://github.com/anthropics/claude-agent-sdk-typescript">Claude Agent SDK</a></div>';
  // Patched in place: a find-in-page highlight, a selection and scroll survive.
  meridianPatch.html(document.getElementById('content'),o);
  meridianReorder.restoreFocus(refocusId);
  if(refocusChip){var chip=document.querySelector('.provider-chip[data-provider-chip="'+refocusChip+'"]');if(chip)chip.focus()}
}

function switchProfile(id){
  fetch('/profiles/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:id})})
    .then(function(r){return r.json()})
    .then(function(data){if(data.success){refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh()}else if(data.error)alert(data.error)})
    .catch(function(){});
}
// The handle sits inside a card that is itself a switch button, so without
// this every grab of the handle would also change the active account.
function onHandle(e){return !!(e.target.closest&&e.target.closest('.drag-handle'))}
// A chip click rewrites only the current history entry, so going back to an
// earlier one can bring a different ?provider= with it.
window.addEventListener('popstate',function(){meridianProviders.fromLocation();applyProviderFilter()});
document.getElementById('content').addEventListener('click',function(e){
  // Before the selection check: pressing a button leaves a selection standing,
  // and a chip that does nothing while some text is selected looks broken.
  var chip=meridianProviders.onClick(e.target);
  if(chip){
    applyProviderFilter();
    if(chip==='*'){var first=document.querySelector('.provider-chip');if(first)first.focus()}
    return;
  }
  if(onHandle(e))return;
  // The card is itself the switch button, so the icon inside one has to opt
  // out of it or reading an account would move all traffic to that account.
  if(e.target.closest('.prof-info'))return;
  // Same for a link to the account's /profiles entry: following it is not a switch.
  if(e.target.closest('a'))return;
  var tab=e.target.closest('.sort-tab');
  if(tab&&tab.dataset.sort){setViewSort(tab.dataset.sort);return}
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile)switchProfile(card.dataset.profile);
});
document.getElementById('content').addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' ')return;
  if(onHandle(e))return;
  if(e.target.closest('.prof-info')||e.target.closest('a'))return;
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile){e.preventDefault();switchProfile(card.dataset.profile)}
});
viewSort=readStoredSort()||viewSort;
meridianReorder.init({onSaved:refresh});
refresh();
setInterval(function(){if(!meridianReorder.dragging() && !infoPopOpen())refresh()},10000);
` + profileBarJs + `
</script>
</body>
</html>`
