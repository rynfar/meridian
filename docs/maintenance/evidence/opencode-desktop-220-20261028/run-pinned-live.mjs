import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {observeChildClosure,stopAndJoinChild} from '/Volumes/DevSSD/meridian/worktrees/opencode-2.2-desktop/scripts/lib/e2eProcessCustody.mjs'
import {streamResponse,requireLiveAdmission} from '/Volumes/DevSSD/meridian/worktrees/opencode-2.2-desktop/scripts/lib-opencode-v2-evidence.mjs'
const root=mkdtempSync('/private/var/folders/ks/xnz659y11jl44j80b_lfws6r0000gn/T/opencode/meridian-220-merge-')
const owner='http://127.0.0.1:3456',profileID='personal'
const repo='/Volumes/DevSSD/meridian/worktrees/opencode-2.2-desktop'
const installation='/Volumes/DevSSD/meridian/opencode-desktop-2.2-20261028/node_modules/@rynfar/meridian'
const native='/Users/rynfar/.local/bin/claude'
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const json=async path=>{const response=await fetch(owner+path,{signal:AbortSignal.timeout(20000)});assert(response.ok);return response.json()}
const inventory=await json('/profiles/list'),quotas=await json('/v1/usage/quota/all')
const selected=inventory.profiles.find(profile=>profile.id===profileID)
const quota=quotas.profiles.find(profile=>profile.id===profileID)
assert(selected,'The owner-selected profile is absent')
requireLiveAdmission({profiles:[selected],activeProfile:profileID},quota,Date.now())
const nativeBefore=digest(native)
const version=Bun.spawnSync([native,'--version'])
assert.equal(version.exitCode,0)
const report={result:'RUNNING',root,scope:'Actual Desktop-bundled CLI / installed client package / owner Meridian; isolated client state and forced single-profile relay',
  ownerProxyVersion:(await json('/health')).version,sourceProfileCount:inventory.profiles.length,
  profilePinAppliedAfterClientPlugin:true,profileID,extraUsageEnabled:false,
  nativeVersion:new TextDecoder().decode(version.stdout).trim(),nativeSha256:nativeBefore,wire:[]}
const pending=new Set(),controllers=new Set()
const pin=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(request){
 const url=new URL(request.url)
 if(url.pathname==='/profiles/list')return Response.json({...inventory,profiles:[selected],activeProfile:profileID,
   admissionScope:{policy:'forced-profile-relay',sourceProfileCount:inventory.profiles.length}})
 if(url.pathname==='/v1/usage/quota/all'){
   const current=await json('/v1/usage/quota/all')
   return Response.json({...current,profiles:current.profiles.filter(profile=>profile.id===profileID),activeProfile:profileID})
 }
 const headers=new Headers(request.headers)
 if(url.pathname==='/v1/messages'&&request.method==='POST'){
   headers.set('x-meridian-profile',profileID)
   const body=await request.clone().json()
   report.wire.push({requestId:headers.get('x-request-id'),model:body.model,
     session:headers.get('x-opencode-session'),agent:headers.get('x-opencode-agent-name'),mode:headers.get('x-opencode-agent-mode'),
     source:headers.get('x-meridian-source'),profilePin:headers.get('x-meridian-profile'),attestationPresent:headers.has('x-meridian-opencode-turn')})
 }
 const controller=new AbortController();controllers.add(controller)
 const signal=AbortSignal.any([controller.signal,request.signal,AbortSignal.timeout(120000)])
 try{
   const upstream=await fetch(owner+url.pathname+url.search,{method:request.method,headers,signal,
     ...(request.method==='GET'?{}:{body:request.body,duplex:'half'})})
   const forwarded=streamResponse(upstream,controller,{signal});pending.add(forwarded.done)
   void forwarded.done.then(()=>{pending.delete(forwarded.done);controllers.delete(controller)})
   return forwarded.response
 }catch(error){controllers.delete(controller);return new Response('Owned pin relay transport failed',{status:502})}
}})
let child,witness,out='',err=''
try{
 const env={...process.env,E2E_ALLOW_LIVE_MODEL:'1',E2E_PROXY_URL:`http://127.0.0.1:${pin.port}`,E2E_SCRUB_VERSION:'0.3.0',
   E2E_ATTESTATION_KEY:readFileSync(join(homedir(),'.config/meridian/opencode-turn.key'),'utf8').trim(),
   E2E_MERIDIAN_ROOT:installation,E2E_OPENCODE_VERSION:'2.2.0',E2E_OPENCODE_BIN:'/Applications/OpenCode.app/Contents/Resources/opencode-cli',
   E2E_MODEL:'claude-opus-5-5',E2E_MARKER:'OC2_STABLE_0b9fca2d-741c-4526-bfef-fc27009ff153',E2E_EXPECT_COMPACTION_MODEL:'opus[1m]'}
 child=spawn('bun',['scripts/e2e-opencode-v2-stable-live.mjs','--live'],{cwd:repo,env,stdio:['ignore','pipe','pipe']})
 witness=observeChildClosure(child);child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
 child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk)
 let timer
 const completed=await Promise.race([witness.joined.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),600000)})]).finally(()=>clearTimeout(timer))
 assert(completed,'Qualification deadline exceeded')
 assert.equal(witness.state.exitCode,0,'Actual-client live gate failed')
 report.client=JSON.parse(out.trim().split('\n').at(-1))
 const ids=new Set(report.wire.map(row=>row.requestId))
 report.telemetry=(await json('/telemetry/requests?limit=500')).filter(row=>ids.has(row.requestId)).map(row=>Object.fromEntries(
   ['requestId','profileId','requestModel','resolvedModel','model','isResume','lineageType','status','error','sdkSessionId','cacheReadInputTokens','cacheCreationInputTokens'].filter(key=>key in row).map(key=>[key,row[key]])))
 assert.equal(report.telemetry.length,report.wire.length,'Missing correlated server observations')
 assert(report.telemetry.every(row=>row.profileId===profileID&&row.status===200&&!row.error),'A test request escaped its grant or failed upstream')
 assert(report.telemetry.some(row=>row.requestModel==='claude-opus-5-5'&&row.isResume&&row.status===200))
 assert(report.wire.every(row=>row.profilePin===profileID))
 const selectedConfig=JSON.parse(readFileSync(join(homedir(),'.config/meridian/profiles.json'),'utf8')).find(profile=>profile.id===profileID)
 assert(selectedConfig?.claudeConfigDir,'Selected profile credential directory is not explicit')
 const require=createRequire('/Volumes/DevSSD/meridian/runtime-1.86.0/package.json')
 const sdk=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
 const previous=process.env.CLAUDE_CONFIG_DIR;report.publicSdkWitness=[]
 try{
  process.env.CLAUDE_CONFIG_DIR=selectedConfig.claudeConfigDir
  for(const id of new Set(report.telemetry.map(row=>row.sdkSessionId).filter(Boolean))){
   let messages=await sdk.getSessionMessages(id,{dir:join(report.client.root,'project')})
   if(!messages.length)messages=await sdk.getSessionMessages(id)
   report.publicSdkWitness.push({sdkSessionId:id,models:[...new Set(messages.filter(row=>row.type==='assistant').map(row=>row.message?.model).filter(Boolean))]})
  }
 }finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous}
 const witnesses=new Map(report.publicSdkWitness.map(row=>[row.sdkSessionId,row.models]))
 assert(report.telemetry.filter(row=>row.requestModel==='claude-opus-5-5').every(row=>witnesses.get(row.sdkSessionId)?.includes('claude-opus-5-5')),'Actual Opus5.5 native history witness missing')
 assert.equal(digest(native),nativeBefore,'Native executable changed during qualification')
 report.result='PASS'
}catch(error){report.result='FAIL';report.failure=error.message;process.exitCode=1}
finally{
 if(child){report.controllerChild=await stopAndJoinChild(child,witness,{graceMs:3000,forceMs:3000});if(!report.controllerChild.joined){report.result='FAIL';process.exitCode=1}}
 for(const controller of controllers)controller.abort()
 await pin.stop(true);await Promise.allSettled([...pending])
 writeFileSync(join(root,'client.stdout'),out);writeFileSync(join(root,'client.stderr'),err)
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({result:report.result,root,failure:report.failure,requests:report.wire.length,nativeVersion:report.nativeVersion}))
 if(report.result==='FAIL')console.error(err.slice(-4000))
}
