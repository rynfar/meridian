import {createPlatformCredentialStore} from "/Volumes/DevSSD/meridian/validation.noindex/1505-corrected-20261104/src/proxy/tokenRefresh.ts";
import {oauthUserAgent} from "/Volumes/DevSSD/meridian/validation.noindex/1505-corrected-20261104/src/proxy/oauthUsage.ts";
import {writeFileSync} from 'node:fs';
const accounts=[{"id": "personal", "claudeConfigDir": "/Users/rynfar/.config/meridian/profiles/personal"}];
const reports=await Promise.all(accounts.map(async p=>{
 const row={account:p.id,scope:'read-only auth/quota; no inference',credentialWrites:0,refreshCalls:0,modelCalls:0,result:'BLOCKED'};
 const credentials=await createPlatformCredentialStore({claudeConfigDir:p.claudeConfigDir}).read();
 const oauth=credentials?.claudeAiOauth;
 row.accessTokenPresent=Boolean(oauth?.accessToken);row.expiresAt=oauth?.expiresAt??null;
 row.subscriptionType=oauth?.subscriptionType??null;
 if(!oauth?.accessToken||!(oauth.expiresAt>Date.now())){row.reason='missing_or_expired_access_token';return row;}
 try{
  const response=await fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1',{headers:{Authorization:`Bearer ${oauth.accessToken}`,'anthropic-beta':'oauth-2025-04-20','User-Agent':oauthUserAgent()},signal:AbortSignal.timeout(20000)});
  row.status=response.status;
  const data=await response.json();
  row.extraUsageEnabled=data.extra_usage?.is_enabled??null;
  row.windows=Object.fromEntries(Object.entries(data).filter(([key])=>['five_hour','seven_day','seven_day_opus'].includes(key)).map(([key,value])=>[key,value&&{utilization:value.utilization,resetsAt:value.resets_at}]));
  row.result=response.ok&&row.extraUsageEnabled===false&&!Object.values(row.windows).some(w=>w&&w.utilization>=100)?'PASS':'BLOCKED';
  row.reason=row.result==='PASS'?null:!response.ok?'usage_endpoint_rejected':row.extraUsageEnabled!==false?'extra_usage_not_confirmed_off':'included_usage_exhausted';
  if(row.result==='PASS'){
   const grant="/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/personal-extra-off"+'/'+p.id+'-grant.json';
   writeFileSync(grant,JSON.stringify([{id:'owned-1220',name:'Owned 1220 verification',type:'oauth-token',oauthToken:oauth.accessToken}]),{mode:0o600,flag:'wx'});
   row.accessOnlyGrantCreated=true;
  }
 }catch(e){row.reason=e?.name==='TimeoutError'?'usage_timeout':'usage_request_failed';}
 return row;
}));
writeFileSync("/Volumes/DevSSD/meridian/evidence/model-pin-final-20261104/authorized-accounts-20261104/personal-extra-off/read-only-account-preflight.json",JSON.stringify({authorization:'Owner authorized personal and kraken live testing',credentialPolicy:'No refresh, no owner credential writes; private access-only grant copies only',accounts:reports},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(reports));
