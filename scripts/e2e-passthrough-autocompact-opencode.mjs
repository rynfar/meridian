#!/usr/bin/env node
// Live gate: the SDK never compacts a passthrough client's history.
//
// Actual OpenCode V1 (Meridian client plugin from `setup --v1`, OpenCode scrub
// on the server) grows one passthrough conversation on a 200k-window model in
// fixed-size user turns until it passes the window. OpenCode is told the
// window is 200k with a 1024-token output cap, so it compacts only at ~199k,
// above the Claude Code CLI's own auto-compact threshold.
//
//   E2E_EXPECT=sdk-compacts   unchanged main: the CLI summarizes the resumed
//                             session silently; the context OpenCode is shown
//                             collapses while OpenCode itself never compacted.
//   E2E_EXPECT=client-compacts with the fix: the context only grows; the turn
//                             over the window gets prompt-too-long, OpenCode
//                             compacts and the conversation continues.
//
// E2E_ALLOW_LIVE_MODEL=1 E2E_LIVE_PROFILE_FILE=<0600 [{id,type:"oauth-token",oauthToken}]>
// E2E_PLUGIN_PATH=<installed OpenCode scrub entrypoint> E2E_OPENCODE_BIN=<absolute binary>
// E2E_MERIDIAN_ROOT=<built checkout> E2E_EXPECT=<see above> node scripts/e2e-passthrough-autocompact-opencode.mjs
//
// Prints only token counts, lineage verdicts and identities; request bodies and
// client output stay in the private artifact directory.
import assert from 'node:assert/strict'
import {resolveOpenCodeScrub,configureOpenCodeScrub,verifyOpenCodeScrub} from './lib-opencode-scrub-preflight.mjs'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,realpathSync,statSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

assert.equal(process.env.E2E_ALLOW_LIVE_MODEL,'1')
const expect=process.env.E2E_EXPECT
assert(['sdk-compacts','client-compacts'].includes(expect),'Set E2E_EXPECT')
const repo=resolve(process.env.E2E_MERIDIAN_ROOT??'.'),client=process.env.E2E_OPENCODE_BIN
assert(client?.startsWith('/'),'E2E_OPENCODE_BIN must be absolute')
const scrub=resolveOpenCodeScrub(process.env.E2E_PLUGIN_PATH,process.env.E2E_SCRUB_VERSION)
const grant=process.env.E2E_LIVE_PROFILE_FILE
assert.equal(statSync(grant).mode & 0o077,0,'The grant must be private')
const profiles=JSON.parse(readFileSync(grant,'utf8'))
// An access-only token, or a live account directory: read-only mode below
// keeps this instance from refreshing or rewriting the owner's credentials.
assert(profiles.length===1 && !profiles[0].refreshToken
  && ((profiles[0].type==='oauth-token' && profiles[0].oauthToken) || (!profiles[0].type && profiles[0].claudeConfigDir)))
const model=process.env.E2E_MODEL??'claude-haiku-4-5-20251001',windowTokens=200000
const chunkWords=Number(process.env.E2E_CHUNK_WORDS??3600),maxTurns=Number(process.env.E2E_MAX_TURNS??20)

const root=realpathSync(mkdtempSync(join(tmpdir(),'meridian-autocompact-')))
for(const name of ['home','project','client','meridian','sessions','config','data','cache','state'])mkdirSync(join(root,name))
const project=join(root,'project'),config=join(root,'client')
const scrubConfig=configureOpenCodeScrub(root,scrub)
for(const key of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENCODE_|DISABLE_)/.test(key))delete process.env[key]
Object.assign(process.env,{HOME:join(root,'home'),MERIDIAN_CONFIG_DIR:join(root,'meridian'),MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_WORKDIR:project,MERIDIAN_PASSTHROUGH:'1',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_CLAUDE_PATH:process.env.E2E_NATIVE_BIN??join(repo,'node_modules/@anthropic-ai/claude-code/bin/claude.exe')})
const clientEnv={...process.env,OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1'}
for(const kind of ['CONFIG','DATA','CACHE','STATE'])clientEnv[`XDG_${kind}_HOME`]=join(root,kind.toLowerCase())

// Deterministic filler: distinct words, so every turn adds about the same tokens.
let seed=0x9e3779b9
const rand=()=>(seed=(Math.imul(seed^(seed>>>15),0x2c1b3c6d)+0x6d2b79f5)>>>0)
const syllables=['ka','lo','mi','te','su','ra','vin','dor','pel','qua','zen','bro','fia','gum','hex','jol']
const word=()=>Array.from({length:2+rand()%3},()=>syllables[rand()%syllables.length]).join('')
const filler=turn=>Array.from({length:chunkWords/12},(_,line)=>`T${turn}L${line}: `+Array.from({length:11},word).join(' ')).join('\n')

const report={result:'RUNNING',root,expect,model,windowTokens,chunkWords,platform:`${process.platform}/${process.arch}`,node:process.version,
  meridian:{root:repo,version:JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version},
  harnessSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),turns:[],requests:[]}
let proxy
async function run(label,args){
  const child=spawn(args[0],args.slice(1),{cwd:project,env:clientEnv,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c)
  const timer=setTimeout(()=>child.kill('SIGKILL'),600000)
  const [code]=await once(child,'close').finally(()=>clearTimeout(timer))
  writeFileSync(join(root,label+'.stdout'),stdout,{mode:0o600});writeFileSync(join(root,label+'.stderr'),stderr,{mode:0o600})
  const events=stdout.split('\n').filter(l=>l.startsWith('{')).flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}})
  return {code,stdout,events}
}
// What OpenCode recorded: per assistant step, the context it was shown, and its own compactions.
function history(session){
  const dir=join(root,'data','opencode')
  const file=readdirSync(dir).find(f=>/^opencode.*\.db$/.test(f))
  const db=new DatabaseSync(join(dir,file),{readOnly:true})
  try{
    return db.prepare('select id, data from message where session_id = ? order by time_created, id').all(session)
      .map(r=>({id:r.id,...JSON.parse(r.data)})).filter(m=>m.role==='assistant').map(m=>{
        const t=m.tokens??{}
        return {id:m.id,summary:m.summary===true,error:m.error?.name,finish:m.finish,
          context:(t.input??0)+(t.cache?.read??0)+(t.cache?.write??0),cacheRead:t.cache?.read??0,cacheWrite:t.cache?.write??0}
      })
  }finally{db.close()}
}
try{
  report.client=(await run('version',[client,'--version'])).stdout.trim()
  const {startProxyServer}=await import(pathToFileURL(join(repo,'dist/server.js')))
  proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:true,profiles,defaultProfile:profiles[0].id,...scrubConfig})
  if(!proxy.server.listening)await once(proxy.server,'listening')
  const url=`http://127.0.0.1:${proxy.server.address().port}`
  report.scrubPreflight=verifyOpenCodeScrub(await(await fetch(`${url}/plugins/list`)).json(),scrub)
  proxy.server.prependListener('request',(request,response)=>{
    if(!request.url?.endsWith('/messages'))return
    const row={session:Boolean(request.headers['x-opencode-session']),agent:request.headers['x-opencode-agent-name'],turnHeader:Boolean(request.headers['x-meridian-opencode-turn'])}
    report.requests.push(row)
    let buffer=''
    const observe=chunk=>{if(chunk==null||typeof chunk==='function')return;buffer+=Buffer.from(chunk).toString();let end
      while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
        for(const line of block.split('\n'))if(line.startsWith('data: ')){let event;try{event=JSON.parse(line.slice(6))}catch{continue}
          if(event.type==='message_start'){const u=event.message?.usage??{};row.context=(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0)}
          if(event.type==='error'){row.error=event.error?.type;row.promptTooLong=/prompt is too long/i.test(event.error?.message??'')}}}}
    const write=response.write,end=response.end
    response.write=function(chunk,...a){observe(chunk);return write.call(this,chunk,...a)}
    response.end=function(chunk,...a){observe(chunk);if(!row.error&&response.statusCode>=400&&typeof chunk!=='function'&&chunk){try{const e=JSON.parse(Buffer.from(chunk).toString());row.error=e.error?.type;row.promptTooLong=/prompt is too long/i.test(e.error?.message??'')}catch{}}return end.call(this,chunk,...a)}
    response.once('close',()=>row.status=response.statusCode)
  })
  writeFileSync(join(config,'opencode.json'),JSON.stringify({model:`anthropic/${model}`,small_model:`anthropic/${model}`,share:'disabled',permission:'deny',
    provider:{anthropic:{options:{apiKey:'owned-loopback',baseURL:url},models:{[model]:{name:model,limit:{context:windowTokens,output:1024},tool_call:true}}}}}))
  const setup=await run('setup',[process.execPath,join(repo,'dist/cli.js'),'setup','--v1'])
  assert.equal(setup.code,0,'meridian setup --v1 failed')
  const configured=JSON.parse(readFileSync(join(config,'opencode.json'),'utf8'))
  const expectedPlugin=realpathSync(join(repo,'dist/meridian'))
  assert.deepEqual(configured.plugin.map(p=>realpathSync(p)),[expectedPlugin],'Exactly one Meridian V1 client plugin from this checkout')
  report.plugin=expectedPlugin
  assert.equal(configured.provider.anthropic.options.baseURL,url,'Provider must target this proxy')

  let session,seen=0
  for(let turn=0;turn<maxTurns;turn++){
    const prompt=`Turn ${turn}. Below is reference material; do not summarize it. Reply with exactly "ACK ${turn}" and nothing else.\n\n${filler(turn)}`
    const out=await run(`turn-${turn}`,[client,'run','--format','json',...(session?['--session',session]:[]),prompt])
    session??=out.events.find(e=>typeof e.sessionID==='string')?.sessionID
    assert(session,'OpenCode did not report its session')
    const steps=await history(session)
    const fresh=steps.slice(seen);seen=steps.length
    const reqs=report.requests.splice(0)
    const row={turn,exit:out.code,ack:out.stdout.includes(`ACK ${turn}`),steps:fresh,proxy:reqs.map(({context,error,promptTooLong,status,agent})=>({agent,status,context,error,promptTooLong}))}
    report.turns.push(row)
    console.error(JSON.stringify({turn,exit:out.code,ack:row.ack,steps:fresh.map(s=>`${s.summary?'SUMMARY ':''}${s.context}${s.error?' '+s.error:''}`),proxy:row.proxy.map(r=>`${r.status}:${r.context??'-'}${r.promptTooLong?':too-long':''}`)}))
    const contexts=report.turns.flatMap(t=>t.steps.filter(s=>!s.summary&&s.context>0).map(s=>s.context))
    const clientCompacted=report.turns.some(t=>t.steps.some(s=>s.summary))
    const collapse=contexts.findIndex((c,i)=>i>0&&c<contexts[i-1]-50000)
    if(collapse>0&&!clientCompacted){report.sdkCompaction={from:contexts[collapse-1],to:contexts[collapse]};break}
    if(clientCompacted){
      const compactTurn=report.turns.findIndex(t=>t.steps.some(s=>s.summary))
      if(turn>compactTurn)break
    }
  }
  const rows=await fetch(`${url}/telemetry/requests?limit=500`).then(r=>r.json()).catch(error=>({requests:[],error:String(error)}))
  report.telemetry=(Array.isArray(rows)?rows:rows.requests??[]).map(r=>({lineage:r.lineageType,resume:r.isResume,input:r.inputTokens,cacheRead:r.cacheReadInputTokens,cacheWrite:r.cacheCreationInputTokens,status:r.status,error:r.error?String(r.error).slice(0,80):undefined}))
  report.scrubFinal=verifyOpenCodeScrub(await(await fetch(`${url}/plugins/list`)).json(),scrub,true)
  assert(report.turns.flatMap(t=>t.proxy).every(r=>r.agent),'Every request must carry the plugin agent header')
  const clientCompacted=report.turns.some(t=>t.steps.some(s=>s.summary))
  if(expect==='sdk-compacts'){
    assert(report.sdkCompaction,'Expected the CLI to collapse the context OpenCode is shown')
    assert(!clientCompacted,'OpenCode compacted before the CLI did')
  }else{
    assert(!report.sdkCompaction,'The CLI compacted client-owned history')
    assert(report.turns.some(t=>t.proxy.some(r=>r.promptTooLong)),'Expected prompt-too-long over the window')
    assert(clientCompacted,'OpenCode did not compact')
    const last=report.turns.at(-1)
    assert(last.exit===0&&last.ack&&last.steps.some(s=>!s.summary&&!s.error&&s.finish==='stop'),'Conversation did not continue after compaction')
  }
  report.result='PASS'
}catch(error){report.result='FAIL';report.failure=String(error)}finally{
  await proxy?.close()
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600})
  console.log(JSON.stringify({root,result:report.result,failure:report.failure,sdkCompaction:report.sdkCompaction}))
  process.exitCode=report.result==='PASS'?0:1
}
