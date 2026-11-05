import {getSessionMessages} from "/Users/rynfar/Library/Caches/meridian-validation.noindex/1220-final-after-1505-20261104/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import {writeFileSync} from 'node:fs';
process.env.CLAUDE_CONFIG_DIR="/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/personal-extra-off/tmp/meridian-probe-proxy-xpyacg/meridian-config/profiles/owned-1220";
const rows=await getSessionMessages('a5f77845-4d9c-4c0b-a2d9-245d2fc22547',{dir:"/Volumes/DevSSD/meridian/private-live-accounts-20261104-0910/personal-extra-off/tmp/meridian-probe-proxy-xpyacg"});
const out=rows.filter(r=>r.uuid==='d9784a56-f5b1-4d07-90df-a93c1cbef5ac').map(r=>({uuid:r.uuid,type:r.type,model:r.message?.model,stop_reason:r.message?.stop_reason,stop_details:r.message?.stop_details??null}));
writeFileSync("/Volumes/DevSSD/meridian/evidence/focused-completion-20261104/refusal-trigger-investigation/supported-native-stop-details.json",JSON.stringify(out,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(out));
