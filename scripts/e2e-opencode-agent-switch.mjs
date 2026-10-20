#!/usr/bin/env node
// Real OpenCode -> matching Meridian plugin -> SDK/native CLI. Default upstream
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

assert(!process.versions.bun,'Run with Node to observe original subprocess handles')
const repo=resolve(process.env.E2E_MERIDIAN_ROOT??'.'), client=process.env.E2E_OPENCODE_BIN, native=process.env.E2E_NATIVE_BIN
assert(client?.startsWith('/')&&native?.startsWith('/'),'Absolute client/native binaries required')
const clientVersion=process.env.E2E_OPENCODE_VERSION??'2.0.21'
assert(['2.0.21','2.0.31'].includes(clientVersion),'Pin an explicitly qualified OpenCode agent-switch host')
const scrub=resolveOpenCodeScrub(process.env.E2E_PLUGIN_PATH,process.env.E2E_SCRUB_VERSION)
const live=process.argv.includes('--live'), expected=process.env.E2E_EXPECT??'candidate'
const diagnose=process.argv.includes('--diagnose')
assert(!diagnose||live,'--diagnose requires the live transport; it denies every generation before forwarding')
assert(['baseline','candidate'].includes(expected))
const output=resolve(process.env.E2E_EVIDENCE_DIR??'local-evidence/agent-switch')
mkdirSync(output,{recursive:true})
const root=realpathSync(mkdtempSync('/tmp/meridian-agent-switch-'))
for(const dir of ['home','project','config','sessions','client','data','cache','state'])mkdirSync(join(root,dir),{mode:0o700})
const work=join(root,'project'),nonce=randomBytes(12).toString('hex'),history='OWNED_HISTORY_'+randomUUID(),model='claude-haiku-5-5'
const primarySystem='OWNED_PRIMARY_SYSTEM_'+randomUUID()
const report={scope:live?'actual OpenCode/SDK/native/model':'actual OpenCode/SDK/native, loopback model responder only',expected,diagnose,platform:process.platform,arch:process.arch,node:process.version,model,requests:[],upstreamRequests:[],provider:[],nativeModels:[],actors:[],turns:[],discovery:0,refusal:false}
let stopped=false
let profiles
if(live){
 assert.equal(process.env.E2E_ALLOW_LIVE_MODEL,'1')
 const guardPath=process.env.E2E_USAGE_GUARD_FILE
 const guard=JSON.parse(readFileSync(guardPath,'utf8'))
 assert(guard.canInfer&&guard.extraUsageEnabled===false&&guard.refreshCalls===0,'Fresh read-only included-usage guard required')
 assert(Date.now()-statSync(guardPath).mtimeMs<300000,'Usage guard is older than five minutes')
 report.usageGuard={extraUsageEnabled:guard.extraUsageEnabled,windows:guard.windows}
 const grant=process.env.E2E_LIVE_PROFILE_FILE
 assert.equal(statSync(grant).mode&0o077,0)
 profiles=JSON.parse(readFileSync(grant,'utf8'))
 assert(profiles.length===1&&profiles[0].type==='oauth-token'&&profiles[0].oauthToken&&!profiles[0].refreshToken)
}
for(const key of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENCODE_)/.test(key))delete process.env[key]
Object.assign(process.env,{HOME:join(root,'home'),PWD:work,INIT_CWD:work,MERIDIAN_CONFIG_DIR:join(root,'config'),MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_WORKDIR:work,MERIDIAN_PASSTHROUGH:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_OPENCODE_ATTESTATION_KEY:randomBytes(32).toString('base64url'),MERIDIAN_HAIKU_MODEL:model})
process.chdir(work)
const spawn=cp.spawn
cp.spawn=function(...args){
 const child=spawn.apply(this,args),row={pid:child.pid,closed:false,stdoutClosed:!child.stdout,stderrClosed:!child.stderr};report.actors.push(row)
 child.once('close',(code,signal)=>Object.assign(row,{closed:true,code,signal}));child.stdout?.once('close',()=>row.stdoutClosed=true);child.stderr?.once('close',()=>row.stderrClosed=true)
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
     if(value.type==='result')for(const actualModel of Object.keys(value.modelUsage??{})){report.nativeModels.push({type:'result_usage',model:actualModel,pid:child.pid,session:value.session_id});if(actualModel!==model){report.nativeModelMismatch=true;stopped=true}}
    }
   }return emit.call(this,event,...eventArgs)
  }
 }
 return child
}
syncBuiltinESMExports()
let proxy,server
const upstreamControllers=new Set()
const upstream=createServer(async(req,res)=>{
 const controller=new AbortController();upstreamControllers.add(controller)
 res.once('close',()=>{if(!res.writableFinished)controller.abort()})
 let transport
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const payload=Buffer.concat(chunks),url=new URL(req.url,'https://api.anthropic.com')
  assert.equal(url.origin,'https://api.anthropic.com')
  transport={method:req.method,path:url.pathname};report.upstreamRequests.push(transport)
  let json
  if(req.method==='POST'&&payload.length){try{json=JSON.parse(payload)}catch{transport.nonJsonBody=true}}
  const generation=req.method==='POST'&&(url.pathname==='/v1/messages'||(typeof json?.model==='string'&&Array.isArray(json?.messages)))
  let body,row
  if(generation){
   body=json??JSON.parse(payload)
   const text=JSON.stringify(body.messages),turns=[...text.matchAll(/OWNED_AGENT_SWITCH_TURN_(\d)/g)].map(m=>Number(m[1]))
   row={turn:turns.length?Math.max(...turns):null,primary:JSON.stringify(body.system).includes(primarySystem),model:body.model,systemHasCanary:JSON.stringify(body.system).includes(nonce),historyPresent:text.includes(history)}
   if(diagnose||stopped||url.pathname!='/v1/messages'||body.model!==model||report.provider.length>=12){
    transport.deniedBeforeForward=true;stopped=true;report.diagnosticStop=diagnose
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Owned probe model/attempt boundary reached'}}))
    setTimeout(()=>server?.kill('SIGTERM'),0).unref();return
   }
   report.provider.push(row)
  }
  if(!live){
   if(!generation){res.setHeader('content-type','application/json');res.end('{}');return}
   const text=row.systemHasCanary?nonce:'NONE'
   const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:1}}
   Object.assign(row,{responseId:message.id,responseModel:message.model,stopReason:message.stop_reason})
   if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return}
   const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}]
   res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));return
  }
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value&&!['host','connection','content-length','transfer-encoding','accept-encoding'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value)
  const response=await fetch(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:payload,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])})
  transport.status=response.status
  row&&(row.status=response.status)
  const responseHeaders={};for(const [name,value]of response.headers)if(!['content-length','content-encoding','transfer-encoding','connection'].includes(name))responseHeaders[name]=value
  res.writeHead(response.status,responseHeaders)
  if(!response.ok){stopped=true;res.end(Buffer.from(await response.arrayBuffer()));return}
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
  }if(row)row.answerHasCanary=answer.includes(nonce);res.end()
 }catch(error){
  // Native startup may cancel its optional HEAD health probe. Cancellation
  // must abort that fetch without turning it into a model-access diagnosis.
  if(req.method==='HEAD'&&controller.signal.aborted){if(transport)transport.clientCancelled=true;return}
  stopped=true;report.upstreamFailure={name:error.name,code:error.code,causeCode:error.cause?.code,causeName:error.cause?.name};if(transport)transport.failed=true;if(!res.headersSent)res.writeHead(400);res.end();setTimeout(()=>server?.kill('SIGTERM'),0).unref()
 }
 finally{upstreamControllers.delete(controller)}
})
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
const trampoline=join(root,'native-relay.cjs')
writeFileSync(trampoline,'#!/usr/bin/env node\nprocess.execve('+JSON.stringify(native)+',['+JSON.stringify(native)+',...process.argv.slice(2)],{...process.env,ANTHROPIC_BASE_URL:'+JSON.stringify(`http://127.0.0.1:${upstream.address().port}`)+'});\n',{mode:0o700})
process.env.MERIDIAN_CLAUDE_PATH=trampoline
const env={PATH:process.env.PATH,HOME:process.env.HOME,PWD:work,INIT_CWD:work,MERIDIAN_CONFIG_DIR:process.env.MERIDIAN_CONFIG_DIR,MERIDIAN_OPENCODE_ATTESTATION_KEY:process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY,OPENCODE_CONFIG_DIR:join(root,'client'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_SERVER_PASSWORD:randomUUID()}
for(const kind of ['CONFIG','DATA','CACHE','STATE'])env[`XDG_${kind}_HOME`]=join(root,kind.toLowerCase())
async function run(command,args){const child=cp.spawn(command,args,{cwd:work,env,stdio:['ignore','pipe','pipe']});let text='',error='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>error+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000);const [code]=await once(child,'close');clearTimeout(timer);assert.equal(code,0,error.slice(-500));return text.trim()}
try{
 report.client=await run(client,['--version']);assert.equal(report.client,`opencode v${clientVersion}`)
 report.native=await run(native,['--version'])
 report.nativeSha256=createHash('sha256').update(readFileSync(native)).digest('hex')
 profiles??=[{id:'owned-agent-switch',type:'api',apiKey:'owned-loopback',baseUrl:`http://127.0.0.1:${upstream.address().port}`}]
 const {startProxyServer}=await import(pathToFileURL(join(repo,'dist/server.js')))
 proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:true,profiles,defaultProfile:profiles[0].id,...configureOpenCodeScrub(root,scrub)})
 if(!proxy.server.listening)await once(proxy.server,'listening')
 const proxyUrl=`http://127.0.0.1:${proxy.server.address().port}`
 report.scrubPreflight=verifyOpenCodeScrub(await(await fetch(proxyUrl+'/plugins/list')).json(),scrub)
 proxy.server.prependListener('request',(req)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  if(pathname==='/v1/models')report.discovery++
  if(pathname!='/v1/messages')return
  const requestId='agent-switch-'+randomUUID();req.headers['x-request-id']=requestId;req.rawHeaders.push('x-request-id',requestId)
  const row={requestId,agent:req.headers['x-opencode-agent-name'],mode:req.headers['x-opencode-agent-mode'],session:req.headers['x-opencode-session'],attested:Boolean(req.headers['x-meridian-opencode-turn'])};report.requests.push(row)
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
 const session=(await api('POST','/api/session',{location:{directory:work},model:{providerID:'anthropic',id:model}})).data
 report.session=session.id
 for(let turn=0;turn<4;turn++){
  if(turn===1||turn===3)await api('POST',`/api/session/${session.id}/agent${where}`,{agent:turn===1?'reviewer':'build'})
  const text=`OWNED_AGENT_SWITCH_TURN_${turn}. ${turn===0?'Remember '+history+'. ':''}Without tools: your current system prompt may contain a code in the format CANARY- followed by hexadecimal digits. If it does, reply with just those digits. Otherwise reply with just NONE.`
  await api('POST',`/api/session/${session.id}/prompt${where}`,{text})
  await api('POST',`/api/experimental/session/${session.id}/wait${where}`)
  assert(!report.refusal&&!stopped,'Upstream refusal/model/attempt boundary; never retry')
  const rows=report.provider.filter(r=>r.turn===turn&&r.primary)
  assert.equal(rows.length,1,'Require exactly one primary native generation per user turn')
  report.turns.push(rows[0])
 }
 const primary=report.requests.filter(r=>r.session===session.id)
 const metrics=await(await fetch(proxyUrl+'/telemetry/requests?limit=100')).json()
 report.telemetry=primary.map(p=>metrics.filter(r=>r.requestId===p.requestId).map(r=>({isResume:r.isResume,lineageType:r.lineageType,status:r.status,sdkSessionId:r.sdkSessionId})))
 report.scrubFinal=verifyOpenCodeScrub(await(await fetch(proxyUrl+'/plugins/list')).json(),scrub,true)
 assert(report.discovery>0,'Actual client model discovery missing')
 assert(primary.some(r=>r.agent==='build'&&r.attested),'Required signed build turn missing')
 // The plugin deliberately withholds human-turn authority for mode:all agents.
 assert(primary.some(r=>r.agent==='reviewer'&&r.mode==='primary'&&r.systemHasCanary),'New agent instructions/matching-plugin identity did not reach Meridian')
 assert(report.turns.every(r=>r.historyPresent),'Original client history was lost')
 if(live)assert(report.provider.every(r=>r.status===200&&r.responseModel===model&&r.stopReason==='end_turn'),'Actual provider identity or terminal result missing')
 assert(!report.nativeObservationFailure&&!report.nativeModelMismatch,'Native model boundary failed')
 const require=createRequire(join(repo,'package.json')),sdk=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')))
 const previousConfig=process.env.CLAUDE_CONFIG_DIR
 report.storedModels=[]
 // Read the application's own mapping, then use the public SDK API under its
 // exact transcript namespace. API and OAuth profiles need not share a path.
 const mappings=JSON.parse(readFileSync(join(root,'sessions','sessions.json'),'utf8'))
 const configDirs=[...new Set(Object.values(mappings).map(row=>row?.currentTranscript?.configDir).filter(Boolean))]
 assert.equal(configDirs.length,1,'Owned model proof requires one explicit SDK namespace')
 assert(resolve(configDirs[0]).startsWith(root+'/'),'SDK namespace escaped the owned fixture')
 try{process.env.CLAUDE_CONFIG_DIR=configDirs[0]
  for(const session of new Set(report.nativeModels.map(row=>row.session).filter(Boolean))){
   const rows=await sdk.getSessionMessages(session,{dir:work})
   report.storedModels.push(...rows.filter(row=>row.type==='assistant').map(row=>({session,id:row.message?.id,model:row.message?.model})))
  }
 }finally{if(previousConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previousConfig}
 assert(report.provider.length>0&&report.storedModels.length>0,'Model correlation requires owned SDK history')
 assert(report.storedModels.every(row=>row.model===model),'Owned SDK history contains an unexpected model')
 for(const row of report.provider){
  assert(report.nativeModels.some(native=>native.type==='message_start'&&native.id===row.responseId&&native.model===model),'Provider response missing from native boundary')
  assert(report.storedModels.some(stored=>stored.id===row.responseId&&stored.model===model),'Provider response missing from owned SDK history')
 }
 report.providerNativeStoredCorrelated=true
 assert.deepEqual(report.turns.map(r=>r.systemHasCanary),expected==='baseline'?[false,false,false,false]:[false,true,true,false])
 assert.deepEqual(report.telemetry.map(rows=>{assert.equal(rows.length,1);assert.equal(rows[0].status,200);return rows[0].isResume}),expected==='baseline'?[false,true,true,true]:[false,false,true,false])
 report.result=expected==='baseline'?'EXPECTED_BASELINE_FAILURE':'PASS'
}catch(error){report.result=report.diagnosticStop?'DIAGNOSTIC_STOP':'FAIL';report.failure=String(error)}finally{
 stopped=true
 for(const controller of upstreamControllers)controller.abort()
 if(server&&server.exitCode===null){const closed=once(server,'close');server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);await closed;clearTimeout(timer)}
 try{await proxy?.close()}catch(error){report.result='FAIL';report.closeFailure=String(error)}
 upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))
 report.joined=report.actors.every(a=>a.closed&&a.stdoutClosed&&a.stderrClosed)
 if(!report.joined)report.result='FAIL'
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify({result:report.result,failure:report.failure,joined:report.joined,evidence:output}))
 process.exitCode=['PASS','EXPECTED_BASELINE_FAILURE','DIAGNOSTIC_STOP'].includes(report.result)?0:1
}
