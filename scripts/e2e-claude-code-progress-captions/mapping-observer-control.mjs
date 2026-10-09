import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const w=resolve(here,'../..');
const {claudeCodeAdapter:adapter}=await import(pathToFileURL(join(w,'src/proxy/adapters/claudecode.ts')).href);
const {Context}=await import(pathToFileURL(createRequire(join(w,'src/proxy/server.ts')).resolve('hono')).href);
const {selectWorkingMapping,MappingObservationError}=await import(pathToFileURL(join(w,'scripts/e2e-claude-code-progress-captions/working-mapping.ts')).href);
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const idDigest=v=>typeof v==='string'&&v?digest(v):null;
class GateError extends Error { constructor(code,status='FAIL'){super(code);this.code=code;this.status=status;} }
const need=(condition,code,status)=>{if(!condition)throw new GateError(code,status);};
const PROFILE='taskoauth-token', privateRoot='/owned-control/private';
const body={metadata:{user_id:JSON.stringify({session_id:'native-parent'})}};
const headers=new Headers({'x-claude-code-agent-id':'working-child'});
const wire={session:'native-parent',agent:'working-child',headers,body};
const key=adapter.getSessionId(new Context(new Request('http://control.invalid',{headers})),body);
need(key&&key!==wire.session,'derived-agent-identity-required');
const rootKey=`${PROFILE}:${wire.session}`,agentKey=`${PROFILE}:${key}`;
const base={currentTranscript:{configDir:join(privateRoot,'config','profiles',PROFILE),projectDir:join(privateRoot,'backend-work')},lineageHash:'lineage',messageCount:1};
let mappings, generations, args=[];
const state={readSessionStoreSnapshot:()=>mappings,readSessionStoreGenerationSnapshot:(id,profiles)=>{args.push({id,profiles});return {[`${profiles[0]}:${id}`]:generations[`${profiles[0]}:${id}`]};}};
const sdk={listSessions:async()=>[{sessionId:'root-sdk'},{sessionId:'agent-sdk'}],getSessionMessages:async id=>[{message:{role:'user',content:id}}]};
function compile(path){
 const source=readFileSync(path,'utf8'),start=source.indexOf('  async function snapshot('),terminator=source.indexOf('  function exactPreserved(',start),end=terminator===-1?source.length:terminator;
 need(start>=0&&end>start,'snapshot-source-extraction-required');
 const text=source.slice(start,end);
 return {sha256:digest(text),snapshot:new Function('state','adapter','Context','selectWorkingMapping','MappingObservationError','GateError','need','PROFILE','privateRoot','join','sdk','digest','idDigest',`${text};return snapshot;`)(state,adapter,Context,selectWorkingMapping,MappingObservationError,GateError,need,PROFILE,privateRoot,join,sdk,digest,idDigest)};
}
const old=compile(join(here,'historical-snapshot.txt')),current=compile(join(w,'scripts/e2e-claude-code-progress-captions/caption-native-gate.mjs'));
need(old.sha256==='57677ad97fc91eee6bbf403c22f8cf44df344c74a4a1b341350d313a4e1c876d','historical-snapshot-identity-changed');
function fixture(rootRevision,agentRevision){mappings={[rootKey]:{...base,claudeSessionId:'root-sdk',messageCount:rootRevision},[agentKey]:{...base,claudeSessionId:'agent-sdk',messageCount:agentRevision}};generations={[rootKey]:rootRevision,[agentKey]:agentRevision};}
const preserved=(a,b)=>digest(a.mapping)===digest(b.mapping)&&digest(a.generations)===digest(b.generations)&&digest(a.history)===digest(b.history);
fixture(1,1);const oldBefore=await old.snapshot(wire.session),newBefore=await current.snapshot(wire);
fixture(1,2);const oldAgentAfter=await old.snapshot(wire.session),newAgentAfter=await current.snapshot(wire);
need(preserved(oldBefore,oldAgentAfter),'historical-false-pass-not-reproduced');need(!preserved(newBefore,newAgentAfter),'corrected-agent-mutation-not-observed');
fixture(2,1);const oldRootAfter=await old.snapshot(wire.session),newRootAfter=await current.snapshot(wire);
need(!preserved(oldBefore,oldRootAfter),'historical-false-failure-not-reproduced');need(preserved(newBefore,newRootAfter),'corrected-root-isolation-not-observed');
need([args[1],args[3],args[5]].every(x=>x.id===key&&x.profiles.length===1&&x.profiles[0]===PROFILE),'corrected-generation-key-not-bound');
const report={status:'PASS',scope:'Executed exact extracted snapshot functions with credential-free state/public-SDK fixtures; not a native/model acceptance claim',historicalSnapshotSha256:old.sha256,currentSnapshotSha256:current.sha256,historicalFalsePassReproduced:true,historicalFalseFailureReproduced:true,correctedAgentMutationDetected:true,correctedRootMutationIgnored:true,correctedGenerationIdentityExact:true,actualAdapterAndHonoSource:true,modelCalls:0,nativeChildren:0};
console.log(JSON.stringify(report));
