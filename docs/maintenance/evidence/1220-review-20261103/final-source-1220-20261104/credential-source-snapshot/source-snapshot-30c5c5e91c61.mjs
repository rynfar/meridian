import {createPlatformCredentialStore} from "/Volumes/DevSSD/meridian/validation.noindex/1505-corrected-20261104/src/proxy/tokenRefresh.ts";
import {readFileSync,writeFileSync} from 'node:fs';
const failed=JSON.parse(readFileSync("/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/personal-extra-off/personal-grant.json",'utf8'))[0].oauthToken;
const accounts=[{"id": "personal", "claudeConfigDir": "/Users/rynfar/.config/meridian/profiles/personal"}, {"id": "kraken", "claudeConfigDir": "/Users/rynfar/.config/meridian/profiles/kraken"}];
const rows=await Promise.all(accounts.map(async p=>{
 const credentials=await createPlatformCredentialStore({claudeConfigDir:p.claudeConfigDir}).read();const o=credentials?.claudeAiOauth;
 const row={account:p.id,accessTokenPresent:Boolean(o?.accessToken),expiresAt:o?.expiresAt??null,currentAccessTokenUnexpired:Boolean(o?.expiresAt>Date.now()),sameAsFailedPersonalGrant:o?.accessToken===failed,credentialWrites:0,refreshCalls:0,networkCalls:0};
 if(o?.accessToken&&o.expiresAt>Date.now()&&o.accessToken!==failed){writeFileSync("/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/source-snapshot"+'/'+p.id+'-grant.json',JSON.stringify([{id:'owned-1220',name:'Owned1220verification',type:'oauth-token',oauthToken:o.accessToken}]),{mode:0o600,flag:'wx'});row.differentAccessOnlyGrantCopied=true;}
 return row;
}));writeFileSync("/Volumes/DevSSD/meridian/evidence/final-source-1220-20261104/credential-source-snapshot/source-snapshot.json",JSON.stringify({reason:'Comparecurrentownerauthorizedstoreswithfailedcopiedgrant; no secrets/tokendigestretained',accounts:rows},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(rows));
