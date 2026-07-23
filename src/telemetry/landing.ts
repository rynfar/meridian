/**
 * Meridian landing page.
 *
 * The at-a-glance dashboard: a short how-it-works intro, per-account cards
 * (usage + est. cost, click to switch the active profile), and a compact
 * 24h traffic strip. Site chrome (logo, nav, status) lives in the shared
 * header from profileBar.ts. Fetches /health, /telemetry/summary,
 * /v1/usage/quota/all and /profiles/list client-side for live data.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"

export const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian</title>
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
  .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 18px 20px; position: relative; transition: border-color 0.15s; }
  .profile-card.switchable { cursor: pointer; }
  .profile-card.switchable:hover { border-color: var(--accent); }
  .profile-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .profile-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  .profile-name { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
  .profile-name .prof-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .profile-card.active .prof-dot { background: var(--accent); box-shadow: 0 0 6px rgba(88,166,255,0.5); }
  .active-pill { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--accent); background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.35);
    border-radius: 10px; padding: 1px 8px; }
  .switch-hint { font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); opacity: 0; transition: opacity 0.15s; }
  .profile-card.switchable:hover .switch-hint { opacity: 1; }
  .profile-cost { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
  .profile-sub { font-size: 11px; color: var(--muted); text-align: right; margin-bottom: 12px; }
  .usage-row { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 4px 0; }
  .usage-row .w-label { color: var(--muted); width: 64px; flex-shrink: 0; }
  .usage-row .w-bar { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
  .usage-row .w-fill { height: 100%; border-radius: 3px; }
  .pace-row { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
  .pace-row .pace-text { flex: 1; font-weight: 600; font-size: 11px; }
  .pool-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--surface2); color: var(--muted); margin-left: 6px; vertical-align: middle; }
  .pool-chip.exhausted { color: var(--red); background: rgba(248,81,73,0.12); }
  .usage-row .w-pct { width: 38px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .usage-row .w-reset { color: var(--muted); font-size: 11px; width: 76px; text-align: right; }
  .no-usage { font-size: 12px; color: var(--muted); padding: 4px 0; }

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
</div>
<script>
function ms(v){if(v==null||v===0)return '—';return v<1000?v+'ms':(v/1000).toFixed(1)+'s'}
function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function usd(v){if(v==null)return '—';if(v>0&&v<0.01)return '$'+v.toFixed(4);if(v<100)return '$'+v.toFixed(2);return '$'+Math.round(v).toLocaleString()}

var WIN_LABELS={five_hour:'5h',seven_day:'7d',seven_day_opus:'7d Opus',seven_day_sonnet:'7d Sonnet',seven_day_fable:'7d Fable',seven_day_oauth_apps:'7d Apps',seven_day_cowork:'7d Cowork',seven_day_omelette:'7d Omelette'};
function winLabel(t){if(WIN_LABELS[t])return WIN_LABELS[t];return t.replace(/^seven_day_/,'7d ').replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase()})}
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

function introSection(h){
  var meta=[];
  if(h.auth&&h.auth.loggedIn)meta.push(esc(h.auth.email||'')+(h.auth.subscriptionType?' ('+esc(h.auth.subscriptionType)+')':''));
  meta.push(h.mode||'internal');
  meta.push('port '+location.port);
  return '<div class="intro">'
    +'<h2>Harness Claude, your way.</h2>'
    +'<p>Meridian bridges any Anthropic-API agent to your Claude subscription — point the agent’s <code>ANTHROPIC_BASE_URL</code> at <code>http://'+esc(location.host)+'</code> and every request routes through the active account below. Setup guides for each agent live in the <a href="https://github.com/rynfar/meridian/blob/main/docs/agents.md">Agent Setup guide</a>.</p>'
    +'<div class="intro-meta">'+meta.join(' · ')+'</div>'
    +'</div>';
}

function profileSection(q,s,pl,h){
  var byProfile=(s&&s.costEstimate&&s.costEstimate.byProfile)||{};
  var quotaByProfile={};
  if(q&&Array.isArray(q.profiles))for(var i=0;i<q.profiles.length;i++){var qid=q.profiles[i].id||q.profiles[i].profile||'default';quotaByProfile[qid]=q.profiles[i].windows||[]}
  var profs=[];var seen={};
  var configured=(pl&&Array.isArray(pl.profiles))?pl.profiles:[];
  var multi=configured.length>1;
  if(configured.length>0){
    // Real profiles exist: show exactly those. Traffic that predates
    // per-profile attribution (the synthetic "default" bucket) still
    // counts in the totals strip but doesn't render as a fake account.
    for(var i=0;i<configured.length;i++){var p=configured[i];profs.push({id:p.id,label:p.id,type:p.type,isActive:!!p.isActive,configured:true});seen[p.id]=1}
  }else{
    // Single-account setup: one card, labeled with the logged-in email.
    var email=(h&&h.auth&&h.auth.loggedIn&&h.auth.email)||'';
    for(var k in quotaByProfile){profs.push({id:k,label:k==='default'?(email||'account'):k,configured:false});seen[k]=1}
    for(var k in byProfile){if(!seen[k])profs.push({id:k,label:k==='default'?(email||'account'):k,configured:false});seen[k]=1}
  }
  if(profs.length===0)return '';
  var cards='';
  for(var i=0;i<profs.length;i++){
    var p=profs[i];var cost=byProfile[p.id];
    var wins=(quotaByProfile[p.id]||[]).filter(function(w){return w.utilization!=null});
    if(!p.configured&&wins.length===0&&!cost)continue;
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
    if(pc)rows+='<div class="usage-row pace-row"><span class="w-label">pace</span>'
      +'<span class="pace-text" style="color:'+paceColor(pc)+'">'+paceText(pc)+'</span>'
      +'<span class="w-reset">'+(pc.proj!=null?'~'+pc.proj+'% by reset':'')+'</span></div>';
    if(!rows)rows='<div class="no-usage">no usage data yet</div>';
    var isPriority=pl&&pl.routing==='priority';
    var switchable=multi&&p.configured&&!p.isActive&&!isPriority;
    var badge=isPriority?'':p.isActive?'<span class="active-pill">Active</span>':switchable?'<span class="switch-hint">Click to activate</span>':'';
    if(isPriority){
      var orderIdx=(pl.profileOrder||[]).indexOf(p.id);
      if(orderIdx>=0)badge+='<span class="pool-chip">#'+(orderIdx+1)+' in pool</span>';
      var exh=(pl.exhausted||[]).filter(function(e){return e.id===p.id})[0];
      if(exh)badge+=' <span class="pool-chip exhausted">exhausted · resets '+resetIn(exh.until)+'</span>';
    }
    cards+='<div class="profile-card'+(p.isActive?' active':'')+(switchable?' switchable':'')+'"'+(switchable?' data-profile="'+esc(p.id)+'" role="button" tabindex="0"':'')+'>'
      +'<div class="profile-head"><span class="profile-name"><span class="prof-dot"></span>'+esc(p.label||p.id)+' '+badge+'</span>'
      +'<span class="profile-cost">'+usd(cost?cost.estimatedUsd:0)+'</span></div>'
      +'<div class="profile-sub">'+(cost?cost.requests+' request'+(cost.requests===1?'':'s')+' · est. API value · 24h':'no traffic · 24h')+'</div>'
      +rows+'</div>';
  }
  if(!cards)return '';
  return '<div class="section"><div class="section-title">'+(profs.length===1?'Account':'Accounts')+'</div><div class="profile-grid">'+cards+'</div></div>';
}

function strip(items){
  var o='<div class="strip">';
  for(var i=0;i<items.length;i++){var it=items[i];
    o+='<div class="strip-item"><div class="strip-label">'+it[0]+'</div><div class="strip-value '+(it[2]||'')+'">'+it[1]+'</div>'+(it[3]?'<div class="strip-detail '+(it[4]||'')+'">'+it[3]+'</div>':'')+'</div>';
  }
  return o+'</div>';
}

async function refresh(){
  try{
    const [health,stats,quota,profiles]=await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/telemetry/summary?window=86400000').then(r=>r.json()),
      fetch('/v1/usage/quota/all').then(r=>r.json()).catch(function(){return null}),
      fetch('/profiles/list').then(r=>r.json()).catch(function(){return null})
    ]);
    render(health,stats,quota,profiles);
  }catch(e){document.getElementById('content').innerHTML='<div style="color:var(--red);padding:40px;text-align:center">Could not connect</div>'}
}

function tokens(v){if(v==null)return '—';if(v>=1e6)return (v/1e6).toFixed(1)+'M';if(v>=1e3)return (v/1e3).toFixed(1)+'k';return String(v)}

function render(h,s,q,pl){
  let o='';
  o+=introSection(h);

  // Accounts — per-profile usage + est cost; click a card to switch
  o+=profileSection(q,s,pl,h);

  // Last 24 hours — meaningful signals only. Errors and envelope
  // violations appear only when there is something to report.
  var tu=s.tokenUsage||{};
  var cache=tu.avgCacheHitRate!=null?Math.round(tu.avgCacheHitRate*100)+'%':'—';
  var items=[
    // The big number is the TOTAL — never error-colored (a red 1714 reads as
    // 1714 failures). The error signal lives on the detail line only.
    ['Requests',String(s.totalRequests),'',s.errorCount>0?s.errorCount+' error'+(s.errorCount===1?'':'s'):'no errors',s.errorCount>0?'red':''],
    ['Tokens Out',tokens(tu.totalOutputTokens),'',tokens(tu.totalInputTokens)+' in'],
    ['Cache Hit',cache,tu.avgCacheHitRate>=0.5?'green':'','prompt cache'],
    ['Est. API Value',usd(s.costEstimate?.totalUsd),'','list prices'],
    ['Median Response',ms(s.totalDuration?.p50),'','p95 '+ms(s.totalDuration?.p95)]
  ];
  if(s.envelopeViolationCount>0)items.push(['Envelope',String(s.envelopeViolationCount),'red','wire-contract violations']);
  o+='<div class="section"><div class="section-title">Last 24 Hours</div>'+strip(items)+'</div>';

  o+='<div class="footer">Meridian · <a href="https://github.com/rynfar/meridian">GitHub</a> · Built on the <a href="https://github.com/anthropics/claude-agent-sdk-typescript">Claude Agent SDK</a></div>';
  document.getElementById('content').innerHTML=o;
}

function switchProfile(id){
  fetch('/profiles/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:id})})
    .then(function(r){return r.json()})
    .then(function(data){if(data.success){refresh();if(window.meridianHeaderRefresh)window.meridianHeaderRefresh()}})
    .catch(function(){});
}
document.getElementById('content').addEventListener('click',function(e){
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile)switchProfile(card.dataset.profile);
});
document.getElementById('content').addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' ')return;
  var card=e.target.closest('.profile-card.switchable');
  if(card&&card.dataset.profile){e.preventDefault();switchProfile(card.dataset.profile)}
});
refresh();setInterval(refresh,10000);
` + profileBarJs + `
</script>
</body>
</html>`
