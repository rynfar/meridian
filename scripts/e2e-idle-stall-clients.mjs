#!/usr/bin/env bun
// Actual pinned client → built Meridian → real SDK, with output-stall injection.
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const client = process.env.E2E_OPENCODE_BIN
assert(client,'Set E2E_OPENCODE_BIN to a pinned client executable')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const v1 = process.argv.includes('--v1')
const root = realpathSync(mkdtempSync(join(tmpdir(),'meridian-idle-client-')))
const config = join(root,'config','opencode')
const clientHome = join(root,'client-home')
mkdirSync(config,{recursive:true});mkdirSync(clientHome)
const flag = join(root,'hold-sdk-output')
const sdkLog = join(root,'sdk-events.jsonl')
writeFileSync(flag,'stall');writeFileSync(sdkLog,'')
const env = {...process.env}
for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_') || key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete env[key]
for (const kind of ['CONFIG','DATA','CACHE','STATE']) env[`XDG_${kind}_HOME`] = join(root,kind.toLowerCase())
Object.assign(env,{HOME:clientHome,PWD:root,INIT_CWD:root,OPENCODE_CONFIG_DIR:config,OPENCODE_DISABLE_AUTOUPDATE:'1',MERIDIAN_CONFIG_DIR:join(root,'meridian')})
const proxyEnv = {...process.env}
for (const key of Object.keys(proxyEnv)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete proxyEnv[key]
Object.assign(proxyEnv,{MERIDIAN_CONFIG_DIR:env.MERIDIAN_CONFIG_DIR,MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_WORKDIR:root,MERIDIAN_PASSTHROUGH:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_UPSTREAM_IDLE_MS:'8000',MERIDIAN_UPSTREAM_IDLE_MAX_CONSECUTIVE:'3',E2E_IDLE_FLAG:flag,E2E_IDLE_LOG:sdkLog,E2E_PROXY_MODULE:pathToFileURL(join(repo,'dist/server.js')).href})
let resolvePort,rejectPort
const readiness = new Promise((yes,no)=>{resolvePort=yes;rejectPort=no})
const proxy = Bun.spawn([process.execPath,join(import.meta.dir,'e2e-idle-stall-host.mjs')],{cwd:root,env:proxyEnv,stdout:'pipe',stderr:'pipe',ipc(message){if(message.port)resolvePort(message.port)}})
const proxyOutput = Promise.all([new Response(proxy.stdout).text(),new Response(proxy.stderr).text()])
proxy.exited.then(code=>rejectPort(new Error(`Proxy exited ${code}`)))
const readyTimer = setTimeout(()=>rejectPort(new Error('Proxy readiness timed out')),30000)
let activeClient
const requests=[]
let endpoint
const parse = text=>text.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
async function run(args,expectedFailure=false) {
  const child=Bun.spawn(args,{cwd:root,env,stdout:'pipe',stderr:'pipe'})
  activeClient=child
  const timer=setTimeout(()=>child.kill(),120000)
  try {
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
    console.log(JSON.stringify({args,code,stdout,stderr}))
    if(expectedFailure) assert([0,1].includes(code),'Client exceeded the retry bound or failed abnormally')
    else assert.equal(code,0)
    return stdout
  }finally {clearTimeout(timer);activeClient=undefined}
}
try {
  const port=await readiness;clearTimeout(readyTimer)
  endpoint=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const body=await request.json()
    const primary=request.headers.get('x-opencode-agent-name')==='build'
    const row={primary,requestKey:JSON.stringify(body),status:0}
    // Only body hashes are logged; do not record subscription credentials.
    row.requestKey=new Bun.CryptoHasher('sha256').update(row.requestKey).digest('hex')
    requests.push(row)
    const response=await fetch(`http://127.0.0.1:${port}${new URL(request.url).pathname}`,{method:'POST',headers:request.headers,body:JSON.stringify(body),signal:request.signal})
    row.status=response.status
    if(primary && requests.filter(r=>r.primary).length>=4 && response.status===200 && readFileSync(sdkLog,'utf8').includes('"stalled":true')) {
      // A fourth SDK attempt already disproves the before-code guarantee.
      const events=parse(readFileSync(sdkLog,'utf8'))
      if(events.filter(e=>e.event==='query' && e.stalled).length>3) setTimeout(()=>activeClient?.kill(),100)
    }
    return new Response(response.body,{status:response.status,headers:response.headers})
  }})
  const version=(await run([client,'--version'])).trim()
  assert(v1?version==='1.18.11':['opencode2 v0.0.0-beta-18314','opencode2 v0.0.0-beta-18866'].includes(version))
  // beta18314 does not auto-retry upstream_timeout SSE errors. Its control
  // checks first-stall behavior and recovery, not the three-attempt ceiling.
  const firstStallOnly = version === 'opencode2 v0.0.0-beta-18314'
  const expectedStalls = firstStallOnly ? 1 : 3
  await run(['node',join(repo,'dist/cli.js'),'setup',v1?'--v1':'--v2','--opencode-bin',client])
  const path=join(config,'opencode.json');const data=JSON.parse(readFileSync(path,'utf8'))
  const settings={apiKey:'local-fixture-key',baseURL:`http://127.0.0.1:${endpoint.port}/v1`}
  if(v1)data.provider={anthropic:{options:settings}}
  else data.providers={anthropic:{settings}}
  writeFileSync(path,JSON.stringify(data))
  const base=[client,'run',...(v1?[]:['--standalone']),'--format','json','--model','anthropic/claude-haiku-4-5-20251001']
  const output=parse(await run([...base,'Reply READY.'],true))
  assert(output.some(event=>event.type==='error' && (firstStallOnly ? /upstream_timeout/i : /invalid.request|retry limit/i).test(JSON.stringify(event))))
  const failedRequests=requests.filter(row=>row.primary)
  assert.equal(failedRequests.length,v1?4:expectedStalls)
  assert.equal(new Set(failedRequests.map(row=>row.requestKey)).size,1,'Retries changed request body')
  if(v1)assert.equal(failedRequests.at(-1).status,400)
  const sdkEvents=parse(readFileSync(sdkLog,'utf8'))
  assert.equal(sdkEvents.filter(event=>event.event==='query' && event.stalled).length,expectedStalls)
  assert.equal(sdkEvents.filter(event=>event.event==='real-startup' && !event.done).length,expectedStalls)
  assert.equal(sdkEvents.filter(event=>event.event==='closed-stalled-query').length,expectedStalls)
  const session=output.find(event=>event.sessionID)?.sessionID;assert(session)
  unlinkSync(flag)
  const receipt=`RECOVERED_${crypto.randomUUID()}`
  const recovered=parse(await run([...base,'--session',session,'--agent','build',`The stalled attempt is over. Reply with exactly ${receipt}.`]))
  assert(!recovered.some(event=>event.type==='error'))
  assert(recovered.some(event=>event.type==='text' && event.part?.text.includes(receipt)))
  console.log(JSON.stringify({result:'PASS',version,firstStallOnly,root,failedRequests,sdkEvents,recovered:true}))
}finally {
  clearTimeout(readyTimer)
  console.log(JSON.stringify({requests,root,sdkEvents:parse(readFileSync(sdkLog,'utf8'))}))
  proxy.kill()
  const killTimer=setTimeout(()=>proxy.kill('SIGKILL'),20000)
  endpoint?.stop(true)
  try{await proxy.exited;console.log(JSON.stringify({proxyOutput:await proxyOutput,requests,root}))}finally{clearTimeout(killTimer)}
}
