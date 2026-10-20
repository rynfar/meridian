#!/usr/bin/env node
// Actual OpenCode or Pi -> Meridian -> SDK/native CLI. E85 return/rewind gate. Default upstream
// is an owned loopback model responder; --live requires a private access-only
// grant and explicit opt-in. No private SDK transcripts are read or edited.
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import {createRequire,syncBuiltinESMExports} from 'node:module'
import {StringDecoder} from 'node:string_decoder'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,statSync,realpathSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {resolveOpenCodeScrub,configureOpenCodeScrub,verifyOpenCodeScrub} from './lib-opencode-scrub-preflight.mjs'
import {observeChildClosure,stopAndJoinChild} from './lib/e2eProcessCustody.mjs'
import {validateProfileHistoryAdmission} from './lib/profileHistoryAdmission.mjs'

assert(!process.versions.bun,'Run with Node to observe original subprocess handles')
const repo=resolve(process.env.E2E_MERIDIAN_ROOT??'.'), client=process.env.E2E_OPENCODE_BIN, native=process.env.E2E_NATIVE_BIN
assert(native?.startsWith('/'),'Absolute native binary required')
const clientVersion=process.env.E2E_OPENCODE_VERSION??'2.0.21'
assert(['2.0.21','2.0.31'].includes(clientVersion),'Pin an explicitly qualified OpenCode agent-switch host')
const piClient=process.argv.includes('--pi')
const scrub=piClient?undefined:resolveOpenCodeScrub(process.env.E2E_PLUGIN_PATH,process.env.E2E_SCRUB_VERSION)
const live=process.argv.includes('--live'), aliases=live||process.argv.includes('--aliases'), expected=process.env.E2E_EXPECT??'candidate'
const rewind=process.argv.includes('--rewind');assert(!rewind||!piClient,'Use OpenCode for the explicit client rewind control')
const diagnose=process.argv.includes('--diagnose')
assert(!diagnose||live,'--diagnose requires the live transport; it denies every generation before forwarding')
assert(['baseline','candidate'].includes(expected))
const output=resolve(process.env.E2E_EVIDENCE_DIR??'local-evidence/agent-switch')
mkdirSync(output,{recursive:true})
const root=realpathSync(mkdtempSync('/tmp/meridian-agent-switch-'))
for(const dir of ['home','project','config','sessions','client','data','cache','state'])mkdirSync(join(root,dir),{mode:0o700})
const work=join(root,'project'),nonce=randomBytes(12).toString('hex'),history='OWNED_HISTORY_'+randomUUID(),model='claude-haiku-5-5'
const primarySystem='OWNED_PRIMARY_SYSTEM_'+randomUUID()
const report={scope:live?'actual OpenCode/SDK/native/model':'actual OpenCode/SDK/native, loopback model responder only',expected,diagnose,platform:process.platform,arch:process.arch,node:process.version,model,requests:[],upstreamRequests:[],provider:[],nativeModels:[],nativeInitializers:[],actors:[],turns:[],discovery:0,refusal:false}
report.flow=piClient?'Pi keyless A-B-B-A return':rewind?'actual client rewind to turn 2':'keyed A-B-B-A return';report.scope=live?'actual client/SDK/native/model':'actual client/SDK/native, loopback responder only'
report.proxyRequestLines=[]
const childWitnesses=new Map()
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})])}finally{clearTimeout(timer)}}
const consoleMethods=['log','debug','warn','error'],originalConsole=Object.fromEntries(consoleMethods.map(name=>[name,console[name]]))
for(const name of consoleMethods)console[name]=(...args)=>{const line=args.map(String).join(' '),match=line.match(/^\[PROXY\] (\S+) adapter=(\S+)/);if(match)report.proxyRequestLines.push({requestId:match[1],adapter:match[2],profile:line.match(/profile=([^\s(]+)/)?.[1],lineage:line.match(/lineage=(\S+)/)?.[1],diverged:line.match(/diverged=(\S+)/)?.[1]})}
let stopped=false,maximumGenerations=12
let profiles
if(live){
 assert.equal(process.env.E2E_ALLOW_LIVE_MODEL,'1')
 const guardPath=process.env.E2E_USAGE_GUARD_FILE
 const guard=JSON.parse(readFileSync(guardPath,'utf8'))
 const admission=validateProfileHistoryAdmission(guard);maximumGenerations=admission.maximumGenerations
 report.usageGuard={...admission,...(admission.includedCapacityKnown?{windows:guard.windows}:{})}
 const grant=process.env.E2E_LIVE_PROFILE_FILE
 assert.equal(statSync(grant).mode&0o077,0)
 const granted=JSON.parse(readFileSync(grant,'utf8'))
 assert(granted.length===1&&granted[0].type==='oauth-token'&&granted[0].oauthToken&&!granted[0].refreshToken)
 profiles=['pool-a','pool-b'].map(id=>({id,type:'oauth-token',oauthToken:granted[0].oauthToken}))
 report.profileAliasesShareGrant=true
}
if(aliases&&!live){profiles=['pool-a','pool-b'].map(id=>({id,type:'oauth-token',oauthToken:'owned-offline-not-a-provider-token'}));report.profileAliasesShareGrant=true}
for(const key of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENCODE_)/.test(key))delete process.env[key]
Object.assign(process.env,{HOME:join(root,'home'),PWD:work,INIT_CWD:work,MERIDIAN_CONFIG_DIR:join(root,'config'),MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_WORKDIR:work,MERIDIAN_PASSTHROUGH:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_OPENCODE_ATTESTATION_KEY:randomBytes(32).toString('base64url'),MERIDIAN_HAIKU_MODEL:model,MERIDIAN_ROUTING:'active',MERIDIAN_PROFILE_ORDER:'pool-a,pool-b',MERIDIAN_SESSION_PROFILE_COPY_PRUNE:'0',MERIDIAN_SESSION_GC_INTERVAL_MS:'0',MERIDIAN_SESSION_GC_GRACE_MS:'3600000'})
process.chdir(work)
const spawn=cp.spawn
cp.spawn=function(...args){
 const child=spawn.apply(this,args),row={pid:child.pid,configDir:args[2]?.env?.CLAUDE_CONFIG_DIR,exited:false,spawnFailed:false,closed:false,stdoutClosed:!child.stdout,stderrClosed:!child.stderr};report.actors.push(row);childWitnesses.set(child,observeChildClosure(child))
 child.once('exit',()=>row.exited=true);child.once('error',()=>row.spawnFailed=child.pid===undefined)
 child.once('close',(code,signal)=>Object.assign(row,{closed:true,code,signal}));child.stdout?.once('close',()=>row.stdoutClosed=true);child.stderr?.once('close',()=>row.stderrClosed=true)
 if(child.stdin){const write=child.stdin.write;let pending=''
  child.stdin.write=function(...args){const bytes=args[0];pending+=typeof bytes==='string'?bytes:Buffer.from(bytes).toString('utf8');assert(pending.length<1048576,'SDK control observation exceeded bound');let end
   while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let value;try{value=JSON.parse(line)}catch{continue}
    if(value.type==='control_request'&&value.request?.subtype==='initialize'){
     const request=value.request,whole=request.systemPrompt??request.system_prompt,append=request.appendSystemPrompt??request.append_system_prompt
     report.nativeInitializers.push({pid:child.pid,keys:Object.keys(request),wholeKind:whole===undefined?'missing':typeof whole,appendKind:append===undefined?'missing':typeof append,wholeLength:typeof whole==='string'?whole.length:0,appendLength:typeof append==='string'?append.length:0,primaryMarker:JSON.stringify([whole,append]).includes(primarySystem),wholeSha:typeof whole==='string'?createHash('sha256').update(whole).digest('hex'):null,appendSha:typeof append==='string'?createHash('sha256').update(append).digest('hex'):null})
    }
   }return write.apply(this,args)
  }
 }
 // Observe each emitted chunk in place without adding a data listener or
 // changing flowing mode. The native transport can emit directly from its
 // pipe, bypassing Readable.read; forwarding emit preserves its consumer.
 if(child.stdout){const emit=child.stdout.emit,decoder=new StringDecoder('utf8');let pending=''
  child.stdout.emit=function(event,...eventArgs){
   if(event==='data'){const bytes=eventArgs[0];pending+=typeof bytes==='string'?bytes:decoder.write(bytes)
    if(pending.length>1048576){report.nativeObservationFailure='Native observation line exceeded bound';stopped=true;pending=''}
    let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let value;try{value=JSON.parse(line)}catch{continue}
     let entry
     if(value.type==='system'&&value.subtype==='init')entry={type:'init',model:value.model}
     if(value.type==='assistant')entry={type:'assistant',id:value.message?.id,model:value.message?.model}
     if(value.type==='stream_event'&&value.event?.type==='message_start')entry={type:'message_start',id:value.event.message?.id,model:value.event.message?.model}
     if(entry){report.nativeModels.push({...entry,pid:child.pid,session:value.session_id});if(typeof entry.model==='string'&&entry.model!==model){report.nativeModelMismatch=true;stopped=true}}
     if(value.type==='rate_limit_event'){const info=value.rate_limit_info??{};(report.rateLimitEvents??=[]).push({status:info.status,isUsingOverage:info.isUsingOverage??null,overageStatus:info.overageStatus??null});if(info.isUsingOverage===true||info.status==='rejected'){report.overageObserved=info.isUsingOverage===true;report.includedCapacityRejected=info.status==='rejected';stopped=true;for(const c of upstreamControllers)c.abort()}}
     if(value.type==='result')for(const actualModel of Object.keys(value.modelUsage??{})){report.nativeModels.push({type:'result_usage',model:actualModel,pid:child.pid,session:value.session_id});if(actualModel!==model){report.nativeModelMismatch=true;stopped=true}}
    }
   }return emit.call(this,event,...eventArgs)
  }
 }
 return child
}
syncBuiltinESMExports()
let proxy,server,proxyUrl,piSession,modelRuntime,finalClientText
const upstreamControllers=new Set()
const handleUpstream=async(req,res,ownedProfile)=>{
 const controller=new AbortController();upstreamControllers.add(controller)
 res.once('close',()=>{if(!res.writableFinished)controller.abort()})
 let transport,body,row
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const payload=Buffer.concat(chunks),url=new URL(req.url,'https://api.anthropic.com')
  assert.equal(url.origin,'https://api.anthropic.com')
  transport={method:req.method,path:url.pathname};report.upstreamRequests.push(transport)
  let json
  if(req.method==='POST'&&payload.length){try{json=JSON.parse(payload)}catch{transport.nonJsonBody=true}}
  const generation=req.method==='POST'&&(url.pathname==='/v1/messages'||(typeof json?.model==='string'&&Array.isArray(json?.messages)))
  if(generation){
   body=json??JSON.parse(payload)
   const text=JSON.stringify(body.messages),turns=[...text.matchAll(/OWNED_RETURN_TRIP_TURN_(\d)/g)].map(m=>Number(m[1]))
   row={turn:turns.length?Math.max(...turns):null,primary:JSON.stringify(body.system).includes(primarySystem),model:body.model,systemHasCanary:JSON.stringify(body.system).includes(nonce),historyPresent:text.includes(history),profile:ownedProfile??String(req.headers['x-api-key']??'').replace('owned-loopback-',''),payloadText:text}
   if(diagnose||stopped||url.pathname!='/v1/messages'||body.model!==model||report.provider.length>=maximumGenerations){
    transport.deniedBeforeForward=true;stopped=true;report.diagnosticStop=diagnose
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Owned probe model/attempt boundary reached'}}))
    if(server)void stopAndJoinChild(server,childWitnesses.get(server),{graceMs:2000,forceMs:3000});return
   }
   if(aliases){const bearer=String(req.headers.authorization??'').replace(/^Bearer\s+/i,''),key=String(req.headers['x-api-key']??'');row.ownedCredential=profiles.some(p=>p.oauthToken===bearer||p.apiKey===key);assert(row.ownedCredential,'Credential outside the owned included-usage fixture')}
   report.provider.push(row);writeFileSync(join(output,'forward-journal.json'),JSON.stringify({requests:report.upstreamRequests,provider:report.provider},null,2)+'\n')
  }
  if(!live){
   if(!generation){res.setHeader('content-type','application/json');res.end('{}');return}
   const actualTokens=[...new Set([...row.payloadText.matchAll(/TOKEN:[a-f0-9]{16}/g)].map(match=>match[0]))]
   const text=row.primary&&[1,2].includes(row.turn)?'TOKEN:'+randomBytes(8).toString('hex'):row.primary&&row.turn===3?(actualTokens.length>=2?actualTokens.slice(-2).join(' '):'MISSING_PRIOR_TOKEN_REPLIES'):'OWNED_PROVIDER_ANSWER_'+randomUUID();row.answerMarker=text
   const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:1}}
   Object.assign(row,{responseId:message.id,responseModel:message.model,stopReason:message.stop_reason})
   if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return}
   const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}]
   res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));return
  }
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value&&!['host','connection','content-length','transfer-encoding','accept-encoding'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value)
  const response=await fetch(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:payload,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])})
  transport.status=response.status
  row&&(row.status=response.status);writeFileSync(join(output,'forward-journal.json'),JSON.stringify({requests:report.upstreamRequests,provider:report.provider},null,2)+'\n')
  const responseHeaders={};for(const [name,value]of response.headers)if(!['content-length','content-encoding','transfer-encoding','connection'].includes(name))responseHeaders[name]=value
  res.writeHead(response.status,responseHeaders)
  if(!response.ok){if(row)stopped=true;else (report.auxiliaryHttpFailures??=[]).push({path:url.pathname,status:response.status});res.end(Buffer.from(await response.arrayBuffer()));return}
  if(!response.body){res.end();return} // The OAuth native CLI begins with HEAD /api/hello.
  let buffer='',answer=''
  for await(const chunk of response.body){
   if(generation){buffer+=Buffer.from(chunk).toString().replaceAll('\r','');assert(buffer.length<1048576);let end
    while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of frame.split('\n'))if(line.startsWith('data: ')){let event;try{event=JSON.parse(line.slice(6))}catch{continue}
     if(event.type==='message_start'){row.responseModel=event.message?.model;row.responseId=event.message?.id;assert.equal(row.responseModel,model)}
     if(event.type==='content_block_delta'&&event.delta?.type==='text_delta'){answer+=event.delta.text;assert(answer.length<1048576)}
     if(event.type==='message_delta'&&event.delta?.stop_reason){row.stopReason=event.delta.stop_reason;if(row.stopReason==='refusal'){report.refusal=true;stopped=true}}
    }}
   }res.write(Buffer.from(chunk))
  }if(row){row.answerHasCanary=answer.includes(nonce);row.answerMarker=answer.trim()}res.end()
 }catch(error){
  // Native startup may cancel its optional HEAD health probe. Cancellation
  // must abort that fetch without turning it into a model-access diagnosis.
  if(req.method==='HEAD'&&controller.signal.aborted){if(transport)transport.clientCancelled=true;return}
  stopped=true;report.upstreamFailure={name:error.name,code:error.code,causeCode:error.cause?.code,causeName:error.cause?.name};if(transport)transport.failed=true;if(!res.headersSent)res.writeHead(400);res.end();if(server)void stopAndJoinChild(server,childWitnesses.get(server),{graceMs:2000,forceMs:3000})
 }
 finally{upstreamControllers.delete(controller)}
}
const upstream=createServer((req,res)=>void handleUpstream(req,res))
const listeners=[],profileOrigins={}
if(aliases){for(const profile of ['pool-a','pool-b']){const listener=createServer((req,res)=>void handleUpstream(req,res,profile));await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));listeners.push(listener);profileOrigins[profile]='http://127.0.0.1:'+listener.address().port}}
else{await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));listeners.push(upstream)}
const trampoline=join(root,'native-relay.cjs')
process.env.E2E_NATIVE_ARGS_FILE=join(output,'native-args.jsonl')
const nativeRelay="#!/usr/bin/env node\nconst fs=require('node:fs'),crypto=require('node:crypto');const args=process.argv.slice(2),readFlag=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]};const append=readFlag('--append-system-prompt'),whole=readFlag('--system-prompt');fs.appendFileSync(process.env.E2E_NATIVE_ARGS_FILE,JSON.stringify({pid:process.pid,configDir:process.env.CLAUDE_CONFIG_DIR,session:readFlag('--session-id'),resume:readFlag('--resume'),flags:args.filter(arg=>/^--[a-zA-Z][a-zA-Z0-9-]*$/.test(arg)),appendPreset:append!==undefined,wholePrompt:whole!==undefined,appendLength:append?.length??0,wholeLength:whole?.length??0,appendSha:append===undefined?null:crypto.createHash('sha256').update(append).digest('hex'),wholeSha:whole===undefined?null:crypto.createHash('sha256').update(whole).digest('hex')})+'\\n');process.execve(__OWNED_NATIVE_PATH__,[__OWNED_NATIVE_PATH__,...args],{...process.env,ANTHROPIC_BASE_URL:__OWNED_UPSTREAM_URL__});\n"
const profileOriginExpression=aliases?'(()=>{const profile=require("node:path").basename(process.env.CLAUDE_CONFIG_DIR??"");const origins='+JSON.stringify(profileOrigins)+';if(!origins[profile])throw new Error("Native model process has no owned profile namespace");return origins[profile]})()':JSON.stringify('http://127.0.0.1:'+upstream.address().port)
const safeRelay=nativeRelay.replace("process.execve(__OWNED_NATIVE_PATH__","if(args.includes('--version')||(args[0]==='auth'&&args[1]==='status'))process.execve(__OWNED_NATIVE_PATH__,[__OWNED_NATIVE_PATH__,...args],process.env);process.execve(__OWNED_NATIVE_PATH__")
writeFileSync(trampoline,safeRelay.replaceAll('__OWNED_NATIVE_PATH__',JSON.stringify(native)).replaceAll('__OWNED_UPSTREAM_URL__',profileOriginExpression),{mode:0o700})
process.env.MERIDIAN_CLAUDE_PATH=trampoline
const env={PATH:process.env.PATH,HOME:process.env.HOME,PWD:work,INIT_CWD:work,MERIDIAN_CONFIG_DIR:process.env.MERIDIAN_CONFIG_DIR,MERIDIAN_OPENCODE_ATTESTATION_KEY:process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY,OPENCODE_CONFIG_DIR:join(root,'client'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_SERVER_PASSWORD:randomUUID()}
for(const kind of ['CONFIG','DATA','CACHE','STATE'])env[`XDG_${kind}_HOME`]=join(root,kind.toLowerCase())
async function run(command,args){const child=cp.spawn(command,args,{cwd:work,env,stdio:['ignore','pipe','pipe']}),witness=childWitnesses.get(child);let text='',error='';child.stdout.on('data',b=>{text=(text+b).slice(-1048576)});child.stderr.on('data',b=>{error=(error+b).slice(-1048576)});try{await bounded(witness.joined,30000,'Owned client setup/version deadline');assert.equal(witness.state.exitCode,0,error.slice(-500));return text.trim()}finally{if(!witness.state.joined)await stopAndJoinChild(child,witness,{graceMs:2000,forceMs:3000})}}
try{
 report.native=await run(native,['--version']);assert.equal(report.native.split(' ')[0],process.env.E2E_NATIVE_VERSION??'2.1.301','Pin the qualified native CLI version');report.nativeSha256=createHash('sha256').update(readFileSync(native)).digest('hex')
 const packageRequire=createRequire(join(repo,'package.json')),sdkMetadata=JSON.parse(readFileSync(resolve(packageRequire.resolve('@anthropic-ai/claude-agent-sdk'),'..','package.json')));report.sdk=sdkMetadata.version;assert.equal(report.sdk,'0.2.141','Pin the qualified SDK shape')
 if(piClient){
 const piDir=process.env.E2E_PI_PACKAGE,metadata=JSON.parse(readFileSync(join(piDir,'package.json')));assert.equal(metadata.name,'@earendil-works/pi-coding-agent');assert.equal(metadata.version,'1.3.0');report.client='Pi '+metadata.version+' actual session engine';
 const pi=await import(pathToFileURL(join(piDir,metadata.exports['.'].import)))
 const {startProxyServer}=await import(pathToFileURL(join(repo,'dist/server.js')))
 proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:false,profiles,defaultProfile:'pool-a'});if(!proxy.server.listening)await once(proxy.server,'listening');proxyUrl=`http://127.0.0.1:${proxy.server.address().port}`
 proxy.server.prependListener('request',req=>{if(new URL(req.url,'http://localhost').pathname!=='/v1/messages')return;const requestId='pi-trip-'+randomUUID();req.headers['x-request-id']=requestId;req.rawHeaders.push('x-request-id',requestId);const row={requestId,agent:req.headers['x-meridian-agent'],affinity:req.headers['x-session-affinity']??null,session:req.headers['x-opencode-session']??req.headers['x-session-id']??null};report.requests.push(row);let text='';const emit=req.emit;req.emit=function(event,...args){if(event==='data')text+=args[0];if(event==='end'){const body=JSON.parse(text);let identity=body.metadata?.user_id;if(typeof identity==='string'){try{identity=JSON.parse(identity)}catch{identity=null}}row.bodySessionId=identity?.session_id??null}return emit.call(this,event,...args)}})
 const agentDir=join(root,'pi');mkdirSync(agentDir);const modelsPath=join(agentDir,'models.json'),authPath=join(agentDir,'auth.json');writeFileSync(authPath,'{}',{mode:0o600});writeFileSync(modelsPath,JSON.stringify({providers:{'owned-meridian':{api:'anthropic-messages',baseUrl:proxyUrl,apiKey:'owned-loopback',headers:{'x-meridian-agent':'pi','user-agent':'pi-coding-agent/'+metadata.version},models:[{id:model,name:'Owned E85 Haiku 5.5',reasoning:false,input:['text'],contextWindow:1000000,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}),{mode:0o600})
 modelRuntime=await pi.ModelRuntime.create({authPath,modelsPath,allowModelNetwork:false});const selected=modelRuntime.getModel('owned-meridian',model);assert(selected?.baseUrl===proxyUrl)
 const loader={getExtensions:()=>({extensions:[],errors:[],runtime:pi.createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>`${primarySystem}\nCurrent working directory: ${work}\nReply without tools.`,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}}
 piSession=(await pi.createAgentSession({cwd:work,agentDir,modelRuntime,model:selected,thinkingLevel:'off',resourceLoader:loader,sessionManager:pi.SessionManager.create(work,join(root,'pi-sessions')),settingsManager:pi.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0}},cacheWarming:'off',enableInstallTelemetry:false}),tools:[]})).session;assert.deepEqual(piSession.getActiveToolNames(),[])

 for(let turn=0;turn<4;turn++){
  const profile=turn===0||turn===3?'pool-a':'pool-b'
  const switched=await fetch(proxyUrl+'/profiles/active',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile})});assert.equal(switched.status,200)
  const task=turn===0?'Remember '+history+'. Reply ACK.':turn===3?'Without tools, repeat exactly both TOKEN: values you produced in your previous two replies. No other words.':'Choose a fresh random sixteen-character hexadecimal token, different from your previous replies. Reply exactly TOKEN: followed immediately by the token. Do not use tools.'
  await bounded(piSession.prompt(`OWNED_RETURN_TRIP_TURN_${turn}. ${task}`),120000,'Owned Pi prompt deadline');await bounded(piSession.waitForIdle(),10000,'Owned Pi turn idle deadline')
  const last=piSession.messages.filter(row=>row.role==='assistant').at(-1);assert(last&&!['error','aborted'].includes(last.stopReason),last?.errorMessage)
  assert(!report.refusal&&!stopped,'Upstream refusal/model/attempt boundary; never retry')
  const rows=report.provider.filter(row=>row.turn===turn&&row.primary);assert.equal(rows.length,1);assert.equal(rows[0].profile,profile)
  assert(typeof rows[0].answerMarker==='string'&&rows[0].answerMarker.length>0)
  if([1,2].includes(turn)){rows[0].answerToken=rows[0].answerMarker.match(/\bTOKEN:\s*([a-f0-9]{16})\b/i)?.[1];assert(rows[0].answerToken,'Nonce must come from completed model reply')}
  report.turns.push(rows[0])
 }
 const lastPi=piSession.messages.filter(row=>row.role==='assistant').at(-1);assert(lastPi&&!['error','aborted'].includes(lastPi.stopReason));finalClientText=lastPi.content.filter(block=>block.type==='text').map(block=>block.text).join('')
 }else{
 report.client=await run(client,['--version']);assert.equal(report.client,`opencode v${clientVersion}`)
 profiles??=['pool-a','pool-b'].map(id=>({id,type:'api',apiKey:'owned-loopback-'+id,baseUrl:`http://127.0.0.1:${upstream.address().port}`}))
 const {startProxyServer}=await import(pathToFileURL(join(repo,'dist/server.js')))
 proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:false,profiles,defaultProfile:profiles[0].id,...configureOpenCodeScrub(root,scrub)})
 if(!proxy.server.listening)await once(proxy.server,'listening')
 proxyUrl=`http://127.0.0.1:${proxy.server.address().port}`
 report.scrubPreflight=verifyOpenCodeScrub(await(await fetch(proxyUrl+'/plugins/list')).json(),scrub)
 proxy.server.prependListener('request',(req)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  if(pathname==='/v1/models')report.discovery++
  if(pathname!='/v1/messages')return
  const requestId='agent-switch-'+randomUUID();req.headers['x-request-id']=requestId;req.rawHeaders.push('x-request-id',requestId)
  const row={requestId,source:req.headers['x-meridian-source'],agent:req.headers['x-opencode-agent-name'],mode:req.headers['x-opencode-agent-mode'],session:req.headers['x-opencode-session'],attested:Boolean(req.headers['x-meridian-opencode-turn'])};report.requests.push(row)
  // Observe data without attaching a flowing-mode listener ahead of Hono's
  // async body consumer; doing so can steal the body from the real request.
  let text='';const emit=req.emit
  req.emit=function(event,...args){if(event==='data')text+=args[0];if(event==='end'){try{const body=JSON.parse(text);row.model=body.model;row.systemHasCanary=JSON.stringify(body.system).includes(nonce)}catch{row.invalidBody=true}}return emit.call(this,event,...args)}
 })
 writeFileSync(join(root,'client','opencode.json'),JSON.stringify({model:`anthropic/${model}`,share:'disabled',providers:{anthropic:{settings:{apiKey:'owned-loopback',baseURL:proxyUrl+'/v1'}}},agents:{build:{system:`${primarySystem}. You are the build agent. Follow the user's task.`},reviewer:{mode:'all',system:`${primarySystem}. CANARY-${nonce}. You review a change.`}}}))
 await run(process.execPath,[join(repo,'dist/cli.js'),'setup','--v2','--opencode-bin',client])
 const config=JSON.parse(readFileSync(join(root,'client','opencode.json')))
 assert.deepEqual(config.plugins.map(p=>realpathSync(p)),[realpathSync(join(repo,'dist/meridian-v2'))]);report.plugin=realpathSync(join(repo,'dist/meridian-v2'))
 server=cp.spawn(client,['serve','--hostname','127.0.0.1','--port','0'],{cwd:work,env,stdio:['ignore','pipe','pipe']})
 const address=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('OpenCode readiness timeout')),30000);server.stdout.on('data',b=>{text+=b;const match=text.match(/server listening on (\S+)/);if(match){clearTimeout(timer);resolve(match[1])}});server.once('close',()=>{clearTimeout(timer);reject(Error('OpenCode exited before readiness'))})})
 server.stderr.resume()
 const headers={'content-type':'application/json',authorization:'Basic '+Buffer.from('opencode:'+env.OPENCODE_SERVER_PASSWORD).toString('base64')}
 const where='?directory='+encodeURIComponent(work)
 const api=async(method,path,body)=>{const response=await fetch(new URL(path,address),{method,headers,body:body&&JSON.stringify(body),signal:AbortSignal.timeout(120000)});const text=await response.text();assert(response.ok,`${method} ${path} ${response.status}: ${text.slice(0,300)}`);return text?JSON.parse(text):undefined}
 // Require the actual host catalog to expose Meridian's full effort set.
 // This is read-only and spends no model request.
 let discovered
 for(let attempt=0;attempt<100;attempt++){
  const catalog=await api('GET','/api/model'+where)
  discovered=catalog.data.find(m=>m.providerID==='anthropic'&&m.id===model)
  if(discovered?.variants?.some(v=>v.id==='xhigh'))break
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 assert(discovered?.variants?.some(v=>v.id==='xhigh'),'Meridian discovery was not adopted by the actual client catalog')
 report.adoptedCatalog={id:discovered.id,variants:discovered.variants.map(v=>v.id)}
 for(const endpoint of ['/api/openapi.json','/openapi.json','/api/doc']){try{const response=await fetch(new URL(endpoint,address),{headers,signal:AbortSignal.timeout(3000)});if(!response.ok)continue;const data=await response.json();if(data.paths){report.rewindApi=Object.keys(data.paths).filter(path=>/session/.test(path)&&/rewind|revert|message|prompt|fork/.test(path));writeFileSync(join(output,'client-openapi.json'),JSON.stringify(data,null,2)+'\n');break}}catch{continue}}
 const session=(await api('POST','/api/session',{location:{directory:work},model:{providerID:'anthropic',id:model}})).data
 report.session=session.id
 for(let turn=0;turn<4;turn++){
  const profile=turn===0||turn===3?'pool-a':'pool-b'
  const switched=await fetch(proxyUrl+'/profiles/active',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile})});assert.equal(switched.status,200)
  if(rewind&&turn===3){const messages=await api('GET',`/api/session/${session.id}/message${where}&type=user&order=asc&limit=20`);assert.equal(messages.data.length,3);const boundary=messages.data[1].id;const staged=await api('POST',`/api/session/${session.id}/revert/stage${where}`,{messageID:boundary,files:false});assert.equal(staged.data.messageID,boundary);report.actualClientRevert={boundary,originalUserMessages:messages.data.length}}
  const task=rewind&&turn===3?'Edited second question. Reply ACK without tools.':turn===0?'Remember '+history+'. Reply ACK.':turn===3?'Without tools, repeat exactly both TOKEN: values you produced in your previous two replies. No other words.':'Choose a fresh random sixteen-character hexadecimal token, different from your previous replies. Reply exactly TOKEN: followed immediately by the token. Do not use tools.'
  const text=`OWNED_RETURN_TRIP_TURN_${turn}. ${task}`
  await api('POST',`/api/session/${session.id}/prompt${where}`,{text})
  await api('POST',`/api/experimental/session/${session.id}/wait${where}`)
  assert(!report.refusal&&!stopped,'Upstream refusal/model/attempt boundary; never retry')
  const rows=report.provider.filter(r=>r.turn===turn&&r.primary)
  assert.equal(rows.length,1,'Require exactly one primary native generation per user turn')
  assert.equal(rows[0].profile,profile)
  assert(typeof rows[0].answerMarker==='string'&&rows[0].answerMarker.length>0,'Actual completed assistant reply missing')
  if([1,2].includes(turn)){rows[0].answerToken=rows[0].answerMarker.match(/\bTOKEN:\s*([a-f0-9]{16})\b/i)?.[1];assert(rows[0].answerToken,'Nonce reply must be generated by the model, not copied from the user prompt')}
  report.turns.push(rows[0])
  if(turn===0){const first=report.requests.filter(r=>r.session===session.id)[0],metrics=await(await fetch(proxyUrl+'/telemetry/requests?limit=100')).json();report.originalASource=metrics.find(r=>r.requestId===first.requestId)?.sdkSessionId;assert(report.originalASource,'Original A SDK session source missing')}
 }

 const clientReplies=await api('GET',`/api/session/${session.id}/message${where}&type=assistant&order=desc&limit=1`);assert.equal(clientReplies.data.length,1);const lastReply=clientReplies.data[0];assert.equal(lastReply.type,'assistant');assert(!lastReply.error&&lastReply.finish!=='error','Actual client did not accept final reply');finalClientText=lastReply.content.filter(block=>block.type==='text').map(block=>block.text).join('')
 }
 const primary=piClient?report.requests:report.requests.filter(r=>r.session===report.session)
 const metrics=await(await fetch(proxyUrl+'/telemetry/requests?limit=100')).json()
 report.telemetry=primary.map(p=>metrics.filter(r=>r.requestId===p.requestId).map(r=>({isResume:r.isResume,lineageType:r.lineageType,status:r.status,sdkSessionId:r.sdkSessionId,profile:r.profileId})))
 if(piClient){assert.equal(primary.length,4);assert(primary.every(row=>row.agent==='pi'&&!row.affinity&&!row.session&&!row.bodySessionId),'Actual Pi must remain keyless');report.keyless=true}else{report.scrubFinal=verifyOpenCodeScrub(await(await fetch(proxyUrl+'/plugins/list')).json(),scrub,true);assert(report.discovery>0,'Actual client model discovery missing');assert(primary.every(row=>row.agent==='build'&&row.attested),'Matching plugin attestation missing')}
 assert(report.turns.every(r=>r.historyPresent),'Original client history marker lost')
 const foreign=report.turns.slice(1,3).map(r=>r.answerToken);assert.equal(new Set(foreign).size,2,'Independent model reply nonces must differ')
 report.foreignAnswersOnReturn=foreign.map(marker=>report.turns[3].payloadText.includes(marker))
 assert.deepEqual(report.foreignAnswersOnReturn,rewind||expected==='baseline'?[false,false]:[true,true])
 report.finalReplyRecalls=foreign.map(token=>report.turns[3].answerMarker.includes(token))
 assert.deepEqual(report.finalReplyRecalls,rewind||expected==='baseline'?[false,false]:[true,true])
 report.clientFinalReplyRecalls=foreign.map(token=>finalClientText.includes(token));assert.deepEqual(report.clientFinalReplyRecalls,rewind||expected==='baseline'?[false,false]:[true,true])
 assert(!report.nativeObservationFailure&&!report.nativeModelMismatch&&!report.overageObserved&&!report.refusal&&!stopped,'Native/provider/model/overage boundary failed')
 if(live)assert(report.provider.every(r=>r.ownedCredential&&r.status===200&&r.responseModel===model&&r.stopReason==='end_turn'),'Live provider completion missing')
 const require=createRequire(join(repo,'package.json')),sdk=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')))
 const previousConfig=process.env.CLAUDE_CONFIG_DIR
 report.storedModels=[]
 // Read the application's own mapping, then use the public SDK API under its
 // exact transcript namespace. API and OAuth profiles need not share a path.
 const mappings=JSON.parse(readFileSync(join(root,'sessions','sessions.json'),'utf8'))
 const configDirs=[...new Set(Object.values(mappings).map(row=>row?.currentTranscript?.configDir).filter(Boolean))]
 assert.equal(configDirs.length,aliases?2:1,'Each OAuth alias must retain its own native SDK namespace')
 report.mappingCustody=Object.entries(mappings).filter(([,row])=>row.claudeSessionId).map(([key,row])=>({key,session:row.claudeSessionId,lastUsedAt:row.lastUsedAt,profile:row.currentTranscript?.configDir?.split('/').at(-1)}));assert(['pool-a','pool-b'].every(profile=>report.mappingCustody.some(row=>piClient?row.profile===profile:row.key.startsWith(profile+':')&&row.key.includes(report.session))),'Both profile mappings must remain; no pruning/eviction shortcut');if(piClient)assert(report.telemetry.slice(2).every(rows=>report.mappingCustody.some(row=>row.session===rows[0].sdkSessionId&&row.profile===rows[0].profile)),'Retained keyless mappings must name observed final A/B SDK targets')
 assert(configDirs.every(dir=>resolve(dir).startsWith(root+'/')),'SDK namespace escaped the owned fixture')
 const nativeLaunches=readFileSync(process.env.E2E_NATIVE_ARGS_FILE,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));report.nativeNamespaceWitness='Owned original-PID pre-exec metadata; native execve preserves CLAUDE_CONFIG_DIR'
 const pairs=new Map()
 for(const row of report.nativeModels){if(!row.session)continue;const actor=report.actors.find(actor=>actor.pid===row.pid);const configDir=nativeLaunches.find(launch=>launch.pid===row.pid)?.configDir??(!aliases?configDirs[0]:undefined);if(actor)actor.configDir=configDir;assert(configDir&&configDirs.includes(configDir),'Native session must name its observed original profile namespace');pairs.set(configDir+'\0'+row.session,{configDir,session:row.session})}
 try{for(const {configDir,session} of pairs.values()){process.env.CLAUDE_CONFIG_DIR=configDir
  const rows=[];await sdk.importSessionToStore(session,{async append(_key,records){rows.push(...records.filter(row=>row.type==='assistant').map(row=>({session,id:row.message?.id,model:row.message?.model,profile:configDir.split('/').at(-1)}))) }},{dir:work,includeSubagents:false})
  report.storedModels.push(...rows)
 }}finally{if(previousConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previousConfig}
 assert(report.provider.length>0&&report.storedModels.length>0,'Model correlation requires owned SDK history')
 assert(report.storedModels.every(row=>row.model===model),'Owned SDK history contains an unexpected model')
 for(const row of report.provider){
  assert(report.nativeModels.some(native=>native.type==='message_start'&&native.id===row.responseId&&native.model===model),'Provider response missing from native boundary')
  assert(report.storedModels.some(stored=>stored.id===row.responseId&&stored.model===model&&(!aliases||stored.profile===row.profile)),'Provider response missing from its exact owned profile SDK history')
 }
 report.providerNativeStoredCorrelated=true
 report.logWitness=primary.map(request=>{const matches=report.proxyRequestLines.filter(line=>line.requestId===request.requestId);assert.equal(matches.length,1,'Actual request log must identify this exact client request');return matches[0]})
 assert.deepEqual(report.logWitness.map(row=>row.profile),['pool-a','pool-b','pool-b','pool-a'])
 assert.equal(report.logWitness[2].lineage,'continuation')
 assert.equal(report.logWitness[3].lineage,rewind||expected==='baseline'?'continuation':'new')
 assert.equal(report.logWitness[3].diverged,rewind||expected==='baseline'?undefined:'moved-on-elsewhere')
 assert.deepEqual(report.telemetry.map(rows=>rows[0]?.profile),['pool-a','pool-b','pool-b','pool-a'])
 assert.deepEqual(report.telemetry.map(rows=>{assert.equal(rows.length,1);assert.equal(rows[0].status,200);return rows[0].isResume}),rewind||expected==='baseline'?[false,false,true,true]:[false,false,true,false])
 if(rewind){const finalNative=report.nativeModels.find(row=>row.type==='message_start'&&row.id===report.turns[3].responseId);assert(finalNative);report.rewindResumeWitness=nativeLaunches.find(row=>row.pid===finalNative.pid);assert.equal(report.rewindResumeWitness?.resume,report.originalASource,'Actual edited turn must resume original A SDK session, not replay or a later target')}
 report.result=rewind?'PASS':expected==='baseline'?'EXPECTED_BASELINE_FAILURE':'PASS'
}catch(error){report.result=report.diagnosticStop?'DIAGNOSTIC_STOP':'FAIL';report.failure=String(error)}finally{
 stopped=true
 for(const controller of upstreamControllers)controller.abort()
 try{if(piSession){await bounded(piSession.abort(),10000,'Owned Pi abort deadline');await bounded(piSession.waitForIdle(),10000,'Owned Pi idle deadline');piSession.dispose()}if(modelRuntime?.dispose)await bounded(modelRuntime.dispose(),10000,'Owned Pi runtime close deadline')}catch(error){report.result='FAIL';report.piCloseFailure=String(error)}
 if(server)report.clientClosure=await stopAndJoinChild(server,childWitnesses.get(server),{graceMs:20000,forceMs:3000})
 try{await bounded(Promise.resolve(proxy?.close()),25000,'Owned proxy close deadline')}catch(error){report.result='FAIL';report.closeFailure=String(error)}
 for(const [child,witness]of childWitnesses)if(!witness.state.joined)await stopAndJoinChild(child,witness,{graceMs:2000,forceMs:3000})
 try{await bounded((async()=>{while(upstreamControllers.size)await new Promise(resolve=>setTimeout(resolve,25))})(),10000,'Owned upstream requests did not settle after abort')}catch(error){report.result='FAIL';report.upstreamCloseFailure=String(error)}
 for(const listener of listeners){listener.closeAllConnections();try{await bounded(new Promise(resolve=>listener.close(resolve)),3000,'Owned listener close deadline')}catch(error){report.result='FAIL';report.listenerCloseFailure=String(error)}}
 report.originalChildClosure=[...childWitnesses.values()].map(witness=>({...witness.state}))
 report.joined=report.originalChildClosure.every(row=>row.joined)&&report.actors.every(a=>(a.exited||a.spawnFailed)&&a.closed&&a.stdoutClosed&&a.stderrClosed)
 if(!report.joined)report.result='FAIL'
 for(const row of report.provider)delete row.payloadText
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
 for(const name of consoleMethods)console[name]=originalConsole[name]
 console.log(JSON.stringify({result:report.result,failure:report.failure,joined:report.joined,evidence:output}))
 process.exitCode=['PASS','EXPECTED_BASELINE_FAILURE','DIAGNOSTIC_STOP'].includes(report.result)?0:1
}
