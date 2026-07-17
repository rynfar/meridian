/**
 * Meridian landing page.
 * Shows system status, account info, quick stats, and agent setup snippets.
 * Fetches /health and /telemetry/summary client-side for live data.
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
         background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }

  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 6px; }
  .header h1 { font-size: 28px; font-weight: 700; letter-spacing: 3px; }
  .tagline { color: var(--muted); font-size: 14px; margin-bottom: 32px; letter-spacing: 0.5px; }

  .status-banner { display: flex; align-items: center; gap: 12px; padding: 16px 20px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 24px; }
  .status-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.healthy { background: var(--green); box-shadow: 0 0 8px rgba(63,185,80,0.4); }
  .status-dot.degraded { background: var(--yellow); }
  .status-dot.unhealthy { background: var(--red); }
  .status-text { font-size: 14px; font-weight: 500; }
  .status-detail { font-size: 12px; color: var(--muted); margin-left: auto; }

  /* Profile cards — the centerpiece: usage + cost per account */
  .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .profile-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
  .profile-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  .profile-name { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
  .profile-name .prof-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px rgba(88,166,255,0.5); }
  .profile-cost { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
  .profile-sub { font-size: 11px; color: var(--muted); text-align: right; margin-bottom: 12px; }
  .usage-row { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 4px 0; }
  .usage-row .w-label { color: var(--muted); width: 64px; flex-shrink: 0; }
  .usage-row .w-bar { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }
  .usage-row .w-fill { height: 100%; border-radius: 3px; }
  .usage-row .w-pct { width: 38px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .usage-row .w-reset { color: var(--muted); font-size: 11px; width: 76px; text-align: right; }

  /* Traffic strip — one compact surface instead of five chunky cards */
  .strip { display: flex; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px 4px; margin-bottom: 24px; }
  .strip-item { flex: 1; min-width: 120px; padding: 2px 18px; border-right: 1px solid var(--border); }
  .strip-item:last-child { border-right: none; }
  .strip-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .strip-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .strip-value.green { color: var(--green); }
  .strip-value.red { color: var(--red); }
  .strip-detail { font-size: 11px; color: var(--muted); }

  /* Model chips — compact inline row */
  .chip-row { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 14px; font-size: 12px; display: flex; align-items: baseline; gap: 8px; }
  .chip .chip-model { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; color: var(--text); }
  .chip .chip-meta { color: var(--muted); font-size: 11px; }

  .section { margin-bottom: 24px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 12px; }
  .info-grid { display: grid; grid-template-columns: 120px 1fr; gap: 8px 16px; font-size: 13px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; }
  .info-label { color: var(--muted); }
  .info-value { color: var(--text); font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }

  .snippet { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 20px; margin-top: 12px; }
  .snippet code { display: block; font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    font-size: 12px; color: var(--accent2); line-height: 1.8; white-space: pre-wrap; word-break: break-all; }
  .snippet-tabs { display: flex; gap: 0; margin-bottom: 12px; }
  .snippet-tab { padding: 6px 14px; font-size: 11px; font-weight: 500; cursor: pointer;
    color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-bottom: none; }
  .snippet-tab:first-child { border-radius: 8px 0 0 0; }
  .snippet-tab:last-child { border-radius: 0 8px 0 0; }
  .snippet-tab.active { color: var(--accent); background: var(--surface2); border-color: var(--accent); }

  .links { display: flex; gap: 12px; margin-top: 32px; flex-wrap: wrap; }
  .link { padding: 10px 20px; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 500;
    transition: border-color 0.2s; }
  .link:hover { border-color: var(--accent); }

  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--muted); text-align: center; }
  .footer a { color: var(--accent); text-decoration: none; }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
  <div class="header">
    <svg width="40" height="40" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="64" height="64" rx="14" fill="#1C1830"/>
      <line x1="32" y1="10" x2="32" y2="54" stroke="#58A6FF" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M16 20 A18 18 0 0 1 48 20" fill="none" stroke="#C4B5FD" stroke-width="1.2" opacity="0.4"/>
      <path d="M16 44 A18 18 0 0 0 48 44" fill="none" stroke="#C4B5FD" stroke-width="1.2" opacity="0.4"/>
      <path d="M20 30 A14 14 0 0 1 44 30" fill="none" stroke="#C4B5FD" stroke-width="0.8" opacity="0.2"/>
      <path d="M20 34 A14 14 0 0 0 44 34" fill="none" stroke="#C4B5FD" stroke-width="0.8" opacity="0.2"/>
      <circle cx="32" cy="10" r="3.5" fill="#C4B5FD"/><circle cx="32" cy="54" r="3.5" fill="#C4B5FD"/>
      <circle cx="32" cy="32" r="3" fill="#58A6FF"/>
    </svg>
    <h1>MERIDIAN</h1>
  </div>
  <div class="tagline">Harness Claude, your way.</div>
  <div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading\u2026</div></div>
</div>
<script>
function ms(v){if(v==null||v===0)return '\u2014';return v<1000?v+'ms':(v/1000).toFixed(1)+'s'}
function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function usd(v){if(v==null)return '\u2014';if(v>0&&v<0.01)return '$'+v.toFixed(4);if(v<100)return '$'+v.toFixed(2);return '$'+Math.round(v).toLocaleString()}
function card(l,v,d,c){return '<div class="card"><div class="card-label">'+l+'</div><div class="card-value '+(c||'')+'">'+v+'</div>'+(d?'<div class="card-detail">'+d+'</div>':'')+'</div>'}

var WIN_LABELS={five_hour:'5h',seven_day:'7d',seven_day_opus:'7d Opus',seven_day_sonnet:'7d Sonnet',seven_day_fable:'7d Fable',seven_day_oauth_apps:'7d Apps',seven_day_cowork:'7d Cowork',seven_day_omelette:'7d Omelette'};
function winLabel(t){if(WIN_LABELS[t])return WIN_LABELS[t];return t.replace(/^seven_day_/,'7d ').replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase()})}
function utilColor(u){return u>=0.85?'var(--red)':u>=0.6?'var(--yellow)':'var(--green)'}
function resetIn(ts){if(ts==null)return '';var d=ts-Date.now();if(d<=0)return 'resetting\u2026';var m=Math.ceil(d/60000);if(m<60)return 'in '+m+'m';var h=Math.floor(m/60);if(h<24)return 'in '+h+'h'+(m%60?' '+(m%60)+'m':'');var days=Math.floor(h/24);return 'in '+days+'d'+(h%24?' '+(h%24)+'h':'')}
function profileSection(q,s){
  var byProfile=(s&&s.costEstimate&&s.costEstimate.byProfile)||{};
  var profs=[];var seen={};
  if(q&&Array.isArray(q.profiles))for(var i=0;i<q.profiles.length;i++){var id=q.profiles[i].id||q.profiles[i].profile||'default';profs.push({id:id,windows:q.profiles[i].windows||[]});seen[id]=1}
  for(var k in byProfile){if(!seen[k])profs.push({id:k,windows:[]})}
  if(profs.length===0)return '';
  var cards='';
  for(var i=0;i<profs.length;i++){
    var p=profs[i];var cost=byProfile[p.id];
    var wins=p.windows.filter(function(w){return w.utilization!=null});
    var rows='';
    for(var j=0;j<wins.length;j++){
      var w=wins[j];var pct=Math.round(w.utilization*100);
      rows+='<div class="usage-row"><span class="w-label">'+esc(winLabel(w.type))+'</span>'
        +'<div class="w-bar"><div class="w-fill" style="width:'+Math.min(pct,100)+'%;background:'+utilColor(w.utilization)+'"></div></div>'
        +'<span class="w-pct" style="color:'+utilColor(w.utilization)+'">'+pct+'%</span>'
        +'<span class="w-reset">'+resetIn(w.resetsAt)+'</span></div>';
    }
    if(!rows&&!cost)continue;
    cards+='<div class="profile-card">'
      +'<div class="profile-head"><span class="profile-name"><span class="prof-dot"></span>'+esc(p.id)+'</span>'
      +'<span class="profile-cost">'+usd(cost?cost.estimatedUsd:null)+'</span></div>'
      +'<div class="profile-sub">'+(cost?cost.requests+' request'+(cost.requests===1?'':'s')+' \u00b7 est. API value \u00b7 24h':'no traffic in window')+'</div>'
      +rows+'</div>';
  }
  if(!cards)return '';
  return '<div class="section"><div class="section-title">Accounts</div><div class="profile-grid">'+cards+'</div></div>';
}

function strip(items){
  var o='<div class="strip">';
  for(var i=0;i<items.length;i++){var it=items[i];
    o+='<div class="strip-item"><div class="strip-label">'+it[0]+'</div><div class="strip-value '+(it[2]||'')+'">'+it[1]+'</div>'+(it[3]?'<div class="strip-detail">'+it[3]+'</div>':'')+'</div>';
  }
  return o+'</div>';
}

async function refresh(){
  try{
    const [health,stats,quota]=await Promise.all([fetch('/health').then(r=>r.json()),fetch('/telemetry/summary?window=86400000').then(r=>r.json()),fetch('/v1/usage/quota/all').then(r=>r.json()).catch(function(){return null})]);
    render(health,stats,quota);
  }catch(e){document.getElementById('content').innerHTML='<div style="color:var(--red);padding:40px;text-align:center">Could not connect</div>'}
}

function render(h,s,q){
  const st=h.status||'unknown',dot=st==='healthy'?'healthy':st==='degraded'?'degraded':'unhealthy';
  let o='';
  o+='<div class="status-banner"><div class="status-dot '+dot+'"></div><span class="status-text">'+(st==='healthy'?'Operational':st==='degraded'?'Degraded':'Offline')+'</span><span class="status-detail">'+(h.auth?.loggedIn?esc(h.auth.email||'')+' \u00b7 '+esc(h.auth.subscriptionType||'')+' \u00b7 ':'')+'port '+location.port+' \u00b7 '+(h.mode||'internal')+'</span></div>';

  // Accounts — per-profile usage + est cost (the reason to look at this page)
  o+=profileSection(q,s);

  // Traffic (24h) — one compact strip
  const er=s.totalRequests>0?((s.errorCount/s.totalRequests)*100).toFixed(1):'0';
  o+='<div class="section"><div class="section-title">Traffic (24h)</div>'+strip([
    ['Requests',String(s.totalRequests),'',''],
    ['Est. API Value',usd(s.costEstimate?.totalUsd),'','list prices'],
    ['Median Response',ms(s.totalDuration?.p50),'','p95 '+ms(s.totalDuration?.p95)],
    ['Median TTFB',ms(s.ttfb?.p50),'','p95 '+ms(s.ttfb?.p95)],
    ['Errors',er+'%',parseFloat(er)>5?'red':'green',s.errorCount+' of '+s.totalRequests]
  ])+'</div>';

  // Models — compact chips
  if(s.byModel&&Object.keys(s.byModel).length>0){
    o+='<div class="section"><div class="section-title">Models (24h)</div><div class="chip-row">';
    for(const[n,d]of Object.entries(s.byModel))o+='<div class="chip"><span class="chip-model">'+esc(n)+'</span><span class="chip-meta">'+d.count+' req \u00b7 avg '+ms(d.avgTotalMs)+'</span></div>';
    o+='</div></div>';
  }

  o+='<div class="section"><div class="section-title">Connect an Agent</div><div class="snippet"><div class="snippet-tabs"><div class="snippet-tab active" onclick="showTab(this,&apos;opencode&apos;)">OpenCode</div><div class="snippet-tab" onclick="showTab(this,&apos;crush&apos;)">Crush</div><div class="snippet-tab" onclick="showTab(this,&apos;generic&apos;)">Any Tool</div></div><div id="tab-opencode"><code>ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://'+location.host+' opencode</code></div><div id="tab-crush" style="display:none"><code>'+JSON.stringify({providers:{meridian:{type:"anthropic",base_url:"http://"+location.host,api_key:"x",models:[{id:"claude-sonnet-4-5-20250514",name:"Sonnet 4.5"}]}}},null,2)+'</code></div><div id="tab-generic" style="display:none"><code>export ANTHROPIC_API_KEY=x\\nexport ANTHROPIC_BASE_URL=http://'+location.host+'</code></div></div></div>';
  o+='<div class="links"><a href="/telemetry" class="link">\ud83d\udcca Telemetry</a><a href="/settings" class="link">\ud83d\udd27 Settings</a><a href="/profiles" class="link">\ud83d\udc64 Profiles</a><a href="/health" class="link">\ud83e\ude7a Health</a><a href="/telemetry/summary" class="link">\ud83d\udcc8 Stats API</a><a href="https://github.com/rynfar/meridian" class="link">\u2699\ufe0f GitHub</a></div>';
  o+='<div class="footer">Meridian \u00b7 Built on the <a href="https://github.com/anthropics/claude-code-sdk-js">Claude Code SDK</a></div>';
  document.getElementById('content').innerHTML=o;
}
function showTab(el,id){document.querySelectorAll('.snippet-tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');document.querySelectorAll('[id^="tab-"]').forEach(t=>t.style.display='none');document.getElementById('tab-'+id).style.display='block'}
refresh();setInterval(refresh,10000);
` + profileBarJs + `
</script>
</body>
</html>`
