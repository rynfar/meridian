import {readFileSync,writeFileSync} from 'node:fs';
import {oauthUserAgent} from "/Volumes/DevSSD/meridian/validation.noindex/1505-corrected-20261104/src/proxy/oauthUsage.ts";
const profiles=JSON.parse(readFileSync("/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/source-snapshot/personal-grant.json",'utf8'));
const response=await fetch('https://api.anthropic.com/api/oauth/usage?cedar_ember=1',{headers:{Authorization:`Bearer ${profiles[0].oauthToken}`,'anthropic-beta':'oauth-2025-04-20','User-Agent':oauthUserAgent()},signal:AbortSignal.timeout(20000)});
const data=await response.json();const windows=Object.fromEntries(Object.entries(data).filter(([k])=>['five_hour','seven_day','seven_day_opus'].includes(k)).map(([k,v])=>[k,v&&{utilization:v.utilization,resetsAt:v.resets_at}]));
const report={account:'personal',scope:'Currentdifferentaccess-onlygrantadmission',status:response.status,extraUsageEnabled:data.extra_usage?.is_enabled??null,windows,refreshCalls:0,ownerCredentialWrites:0,modelCalls:0};
report.result=response.ok&&report.extraUsageEnabled===false&&!Object.values(windows).some(w=>w&&w.utilization>=100)?'PASS':'BLOCKED';
writeFileSync("/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/credential-source-snapshot/new-grant-quota-preflight.json",JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
