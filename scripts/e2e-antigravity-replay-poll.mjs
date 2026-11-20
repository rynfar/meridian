// Actual Pi + provider-specific Meridian retry plugin + official agy proof for the replay guard (#1340).
// Run separately against an unchanged server build, the previous guard and the candidate. No auth mutation.
//
// Pi polls a status file that says "running". After Pi's first read completes, the relay changes the file to "done"
// and replaces the backend before forwarding that result, so the next request is a completed-history replay. A
// re-read after the replay is a legitimate poll: the replayed native conversation must never receive the recorded
// "running" as a fresh result, and a read after the replay must reach Pi and return "done".
//
//   node scripts/e2e-antigravity-replay-poll.mjs <server.js> <pi-integration.js> <pi-cli.js> <official-agy> <new-report.json> <label>
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'
const [serverPath, pluginPath, piPath, executable, reportPath, label] = process.argv.slice(2)
assert(reportPath && label, 'Expected server, plugin, Pi CLI, official agy, report, label')
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const nativeHash = await hash(executable)
assert.equal(nativeHash, '8c01ef82307dc01455418eb2e6e82f2989a3fa8b815c4b192efaaa89a55bef8d', 'Unqualified official executable')
const pluginHash = await hash(pluginPath)
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-replay-poll-'))
const model = 'gemini-3.8-flash-low'
process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
const localKey = randomUUID()
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENROUTER_|AZURE_OPENAI_|GOOGLE_API_KEY$|GEMINI_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_GENAI_USE_|GOOGLE_GEMINI_BASE_URL$)/.test(key)) delete process.env[key]
process.env.MERIDIAN_API_KEY = localKey
const children = [], originalSpawn = cp.spawn
cp.spawn = function(...args) {
 const child = originalSpawn.apply(this,args)
 const fact = { pid: child.pid ?? null, close: false, stdoutEof: !child.stdout, stderrEof: !child.stderr }
 const closed = new Promise(resolve => child.once('close', (code, signal) => { Object.assign(fact,{close:true,code,signal}); resolve() }))
 child.stdout?.once('end', () => { fact.stdoutEof=true }); child.stderr?.once('end', () => { fact.stderrEof=true })
 children.push({child,closed,fact}); return child
}
syncBuiltinESMExports()
// The guard logs one JSON line per intercepted repeat (tool name only); count them.
let guardEvents = 0
const log = console.log
console.log = (...args) => { if (args.map(String).join(' ').includes('"agy_replay_duplicate"')) guardEvents++; log(...args) }
const { startProxyServer } = await import(pathToFileURL(serverPath).href)
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
async function within(promise, ms, message) {
 let timer
 try { return await Promise.race([promise,new Promise((_,reject) => {timer=setTimeout(()=>reject(new Error(message)),ms)})]) }
 finally {clearTimeout(timer)}
}
const report = { label, result:'INCOMPLETE', model, platform:process.platform, arch:process.arch, node:process.version, nativeHash, pluginHash, clientPreflight:false, metrics:[], requests:[], restarted:false, clientReads:[], guardEvents:0, replayedEnvelopes:null, children:[], joined:false }
let proxy, relay, client, failure
async function startClient(url, name, tools) {
 const project = join(root,name), config = join(project,'config')
 await mkdir(config,{recursive:true})
 await writeFile(join(config,'models.json'),JSON.stringify({providers:{'meridian-agy':{baseUrl:url,apiKey:localKey,api:'anthropic-messages',models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:128000,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}))
 await writeFile(join(config,'settings.json'),JSON.stringify({retry:{enabled:false},compaction:{enabled:false}}))
 const env={...process.env,PI_CODING_AGENT_DIR:config,PI_OFFLINE:'1',PI_TELEMETRY:'0'}
 const toolArgs=tools?['--tools',tools]:['--no-builtin-tools']
 const child=cp.spawn(process.execPath,[piPath,'--provider','meridian-agy','--model',model,'--thinking','off','--mode','rpc','--no-session',...toolArgs,'--no-extensions','-e',pluginPath,'--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--system-prompt',tools?'You are a test assistant. Use the read tool as instructed and report tool results exactly.':'You are a test assistant. Answer briefly without using tools.'],{cwd:project,env,stdio:['pipe','pipe','pipe']})
 const events=[]; let buffer='',closed=false,parseError=false,stderrBytes=0
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
 child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())try{events.push(JSON.parse(line))}catch{parseError=true}}})
 child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk)})
 child.once('close',()=>{closed=true});child.on('error',()=>{closed=true})
 async function until(fn,name){const end=Date.now()+240000;while(Date.now()<end){assert(!parseError,'Malformed client RPC output');const result=fn();if(result)return result;assert(!closed,`Client closed during ${name}, stderr bytes ${stderrBytes}`);await delay(25)}throw new Error(`Client deadline: ${name}`)}
 async function command(type,fields={}){const id=randomUUID();child.stdin.write(JSON.stringify({id,type,...fields})+'\n');const reply=await until(()=>events.find(e=>e.type==='response'&&e.id===id),type);assert.equal(reply.success,true,`Client command failed: ${type}`);return reply.data}
 await command('get_state');await command('set_auto_retry',{enabled:false})
 return {project,child,async prompt(message){const start=events.length;await command('prompt',{message});const end=await until(()=>events.slice(start).find(e=>e.type==='agent_end'),'agent end');assert(!end.messages?.some(m=>m.stopReason==='error'),'Actual client returned a model error');const last=end.messages?.filter(m=>m.role==='assistant').at(-1);assert(last,'No assistant completion');return (Array.isArray(last.content)?last.content.filter(b=>b.type==='text').map(b=>b.text).join(''):String(last.content??''))},async close(){if(!closed)child.kill('SIGTERM');const owned=children.find(x=>x.child===child);let kill;try{kill=setTimeout(()=>{if(!closed)child.kill('SIGKILL')},1000);await within(owned.closed,10000,'Original Pi close missing')}finally{clearTimeout(kill)}}}
}
let fixtureRequests=0, malformedPlugin=false
try {
 relay=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const body=JSON.parse(Buffer.concat(chunks).toString())
  const qualified=typeof body.meridian_request_id==='string'&&/^[a-f\d-]{36}$/.test(body.meridian_request_id)
  if(!qualified){malformedPlugin=true;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Required Meridian Antigravity plugin identity missing'}}));return}
  fixtureRequests++
  const frames=[{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Fixture reply.'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}]
  res.writeHead(200,{'content-type':'text/event-stream'});for(const frame of frames)res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);res.end()
 })
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve))
 client=await startClient(`http://127.0.0.1:${relay.address().port}`,'preflight')
 await client.prompt('Reply briefly.');assert(!malformedPlugin&&fixtureRequests===1,'Client plugin preflight failed')
 await client.close();client=undefined;await new Promise(resolve=>relay.close(resolve));relay=undefined
 report.clientPreflight=true
 if(process.env.E2E_PREFLIGHT_ONLY==='1'){report.result='PREFLIGHT_PASS'}else{
 const plugin={name:'replay-poll-evidence',onRequest:({request})=>{assert(typeof request.meridian_request_id==='string','Required Antigravity client plugin missing before generation');report.requests.push({model:request.model,id:request.meridian_request_id,messageCount:request.messages.length});return request},onTelemetry:({metric})=>{report.metrics.push({model:metric.model,status:metric.status,continuation:metric.continuation,conversationId:metric.conversationId,inputTokens:metric.inputTokens,outputTokens:metric.outputTokens})}}
 const options={backend:'antigravity',port:0,silent:true,antigravity:{executable,allowToolBridge:true,plugins:[plugin]}}
 proxy=await startProxyServer(options)
 if(!proxy.server.listening)await once(proxy.server,'listening')
 let url=`http://127.0.0.1:${proxy.server.address().port}`
 const models=await fetch(url+'/v1/models',{headers:{'x-api-key':localKey}});assert.equal(models.status,200,'Read-only model readiness failed');assert((await models.json()).data.some(x=>x.id===model),'Actual account model unavailable')
 const project=join(root,'live'),statusPath=join(project,'build-status.txt')
 await mkdir(project,{recursive:true});await writeFile(statusPath,'running\n')
 const observed=[]
 relay=createServer(async(req,res)=>{
  const abort=new AbortController()
  res.once('close',()=>{if(!res.writableFinished)abort.abort()})
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const raw=Buffer.concat(chunks).toString('utf8'),body=raw?JSON.parse(raw):undefined
   if(body)observed.push(body)
   const returned=body?.messages?.at(-1)?.content
   if(!report.restarted&&Array.isArray(returned)&&returned.some(b=>b.type==='tool_result'&&!b.is_error&&JSON.stringify(b.content).includes('running'))){
    // The build finishes while the completed read is in flight; the next request is a history replay.
    report.restarted=true
    await writeFile(statusPath,'done\n')
    await within(proxy.close(),20000,'Proxy shutdown did not join')
    proxy=await startProxyServer(options)
    if(!proxy.server.listening)await once(proxy.server,'listening')
    url=`http://127.0.0.1:${proxy.server.address().port}`
   }
   const headers={};for(const [key,value] of Object.entries(req.headers))if(!['host','content-length','connection'].includes(key))headers[key]=value
   const response=await fetch(url+req.url,{method:req.method,headers,body:raw||undefined,signal:abort.signal})
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')})
   Readable.fromWeb(response.body).on('error',error=>res.destroy(error)).pipe(res)
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(String(error))}
 })
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve))
 client=await startClient(`http://127.0.0.1:${relay.address().port}`,'live','read')
 const answer=await client.prompt(`A build is running. Poll its status file ${statusPath} with your read tool until it says done: read it, and whenever it does not say done, read it again, because it is updated while you work. Read it at most 5 times. Then reply with exactly one line: FINAL_STATUS=<the status from your most recent read>.`)
 report.finalStatus=/FINAL_STATUS=(\w+)/.exec(answer)?.[1]??null
 const calls=new Map(),results=new Map()
 for(const body of observed)for(const message of body.messages){if(!Array.isArray(message.content))continue;for(const block of message.content){if(block.type==='tool_use')calls.set(block.id,block);if(block.type==='tool_result')results.set(block.tool_use_id,JSON.stringify(block.content))}}
 report.clientReads=[...calls.values()].filter(c=>c.name==='read').map(c=>results.get(c.id)?.includes('done')?'done':results.get(c.id)?.includes('running')?'running':'other')
 report.guardEvents=guardEvents
 // What the replayed native conversation received from Meridian's client MCP bridge, from the CLI's own transcript.
 const replayed=report.metrics.at(-1)?.conversationId
 if(replayed){
  const transcript=await readFile(join(homedir(),'.gemini','antigravity-cli','brain',replayed,'.system_generated','logs','transcript.jsonl'),'utf8')
  report.replayedEnvelopes=[...transcript.matchAll(/meridian_client_result\\*"\s*:\s*\\*"([A-Za-z]+)/g)].map(m=>m[1]==='Not'?'notice':['running','done'].includes(m[1])?m[1]:'other')
 }
 assert(report.restarted,'The backend must be replaced before the completed read is forwarded')
 assert(report.metrics.length>=2&&new Set(report.metrics.map(m=>m.conversationId)).size>=2,'The replay must run in a new native conversation')
 assert(report.metrics.every(x=>x.status===200&&x.model===model),'Actual model/status mismatch')
 assert.equal(report.clientReads[0],'running','First client read returns running')
 assert(report.clientReads.includes('done'),'A read after the replay must reach Pi and return the current status')
 assert(Array.isArray(report.replayedEnvelopes),'Replayed native transcript unavailable')
 assert(!report.replayedEnvelopes.includes('running'),'The replayed conversation received the recorded result as a fresh read')
 assert.equal(report.finalStatus,'done','The final report must use the current status')
 report.result='PASS'
 }
} catch(error){failure=error;report.result='FAIL';report.error=error.message}
finally{
 console.log=log
 try{await client?.close();if(proxy)await within(proxy.close(),20000,'Proxy shutdown did not join');if(relay){relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve))};await within(Promise.all(children.map(x=>x.closed)),10000,'Original process close missing');report.joined=children.every(x=>x.fact.close&&x.fact.stdoutEof&&x.fact.stderrEof);assert(report.joined,'Original process pipes not joined');report.finalNativeHash=await hash(executable);assert.equal(report.finalNativeHash,nativeHash,'Official binary changed')}catch(error){failure??=error;report.result='FAIL';report.cleanupError=error.message}
 report.children=children.map(x=>x.fact);await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({result:report.result,label,clientPreflight:report.clientPreflight,joined:report.joined,guardEvents:report.guardEvents,clientReads:report.clientReads,replayedEnvelopes:report.replayedEnvelopes,finalStatus:report.finalStatus,error:report.error,cleanupError:report.cleanupError,reportPath}));if(failure)process.exitCode=1
}
