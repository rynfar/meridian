import { describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

const harness = resolve(import.meta.dir, '../../scripts/e2e-claude-code-auto-mode.mjs')
type Mode = { baseline?: boolean; missingClassifier?: boolean; markerInUser?: boolean; fast?: boolean; swapped?: boolean; startupChild?: boolean; pendingStartup?: boolean; wrongModel?: boolean; queryAtStartup?: boolean; hang?: boolean; errorMaxTurns?: boolean; terminalSse?: boolean; brokenTerminal?: boolean; refusal?: boolean; duplicateToolId?: boolean; borrowTerminal?: boolean; repeatHttpToolId?: boolean; missingErrorFlag?: boolean; falseMaxTurnsFlag?: boolean; missingStart?: boolean; earlyStop?: boolean; postTerminalContent?: boolean; duplicateIndex?: boolean; inputAfterClose?: boolean; sdkAlias?: boolean; wrongPin?: boolean; missingPin?: boolean; wrongSdkId?: boolean; unsupportedAlias?: boolean; wireWrongModel?: boolean; mixedModels?: boolean; classifierWrongPin?: boolean; classifierMissingPin?: boolean; classifierWrongSdkId?: boolean; classifierWrongServed?: boolean; mainWrongServed?: boolean; classifierWrongWire?: boolean; missingContext?: boolean; unmatchedContext?: boolean; duplicateRequest?: boolean; swappedContexts?: boolean; descriptorDrift?: boolean; unrestorableDescriptor?: boolean; cloneHang?: boolean; cloneError?: boolean }
function fixture(mode: Mode = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meridian-e71-controls-'))
  const target = join(root, 'target'), sdk = join(target, 'node_modules/@anthropic-ai/claude-agent-sdk'), proof = join(root, 'proof')
  mkdirSync(sdk, { recursive: true, mode: 0o700 }); mkdirSync(proof, { mode: 0o700 })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'meridian-harness-synthetic-fixture', version: '0.0.0', type: 'module' }))
  writeFileSync(join(target, 'mode.json'), JSON.stringify(mode))
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.2.141', type: 'module', main: 'sdk.mjs', meridianHarnessSynthetic: true }))
  // An independently generated non-auth SDK: invocation records and real
  // asynchronous receipts. It never imports the installed native dependency.
  writeFileSync(join(sdk, 'sdk.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../../../',import.meta.url),mode=JSON.parse(readFileSync(new URL('mode.json',root),'utf8'));let count=0;
export function query(input){writeFileSync(new URL('query-called',root),'synthetic only');const auxiliary=input.prompt==='synthetic',model=mode.mixedModels&&auxiliary?'claude-sonnet-5':'claude-sonnet-5-5',served=auxiliary&&mode.classifierWrongServed?'claude-sonnet-5-5':!auxiliary&&mode.mainWrongServed?'claude-sonnet-5':model;const destination=/date > ([^\x60]+)/.exec(input.prompt)?.[1],tool=mode.errorMaxTurns&&destination?{type:'tool_use',id:mode.duplicateToolId&&destination.endsWith('/stamp1.txt')?'synthetic-reused-tool':'synthetic-tool-'+(++count),name:'Bash',input:{command:'date > '+destination}}:undefined;return{close(){},async *[Symbol.asyncIterator](){yield{type:'assistant',...(mode.refusal?{error:'authentication_failed'}:{}),message:{model:mode.refusal?'<synthetic>':mode.wrongModel?'claude-sonnet-4-6':served,usage:{input_tokens:mode.refusal?0:12,output_tokens:mode.refusal?0:4},content:tool?[tool]:[]}};yield{type:'result',subtype:mode.refusal?'error_during_execution':tool?'error_max_turns':'success',...(mode.missingErrorFlag?{}:{is_error:tool&&mode.falseMaxTurnsFlag?false:!!tool||!!mode.refusal}),num_turns:1,total_cost_usd:0.001}}}}
`)
  writeFileSync(join(target, 'server.mjs'), `import assert from 'node:assert/strict';import{createServer}from'node:http';import{readFileSync,writeFileSync,statSync}from'node:fs';import{spawn}from'node:child_process';import{once}from'node:events';import{AsyncLocalStorage}from'node:async_hooks';import{query}from'@anthropic-ai/claude-agent-sdk';
const mode=JSON.parse(readFileSync(new URL('mode.json',import.meta.url),'utf8')),logger=new AsyncLocalStorage(),firstPair=[];let main=0,requests=0,contextRequests=0,toolTerminals=0,previousTool;
assert(!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN&&!process.env.CLAUDE_CODE_OAUTH_TOKEN&&!process.env.MERIDIAN_PROFILES&&!process.env.MERIDIAN_TELEMETRY_DB&&!process.env.CLAUDE_PROXY_CONFIG_DIR&&!process.env.AWS_PROFILE);
export async function startProxyServer(config){
 const account=config.profiles[0].claudeConfigDir,cred=JSON.parse(readFileSync(account+'/.credentials.json','utf8'));
 assert(config.port===0&&config.host==='127.0.0.1'&&config.defaultProfile==='e71-owned'&&config.silent===false);assert(!cred.claudeAiOauth.refreshToken);assert((statSync(account+'/.credentials.json').mode&511)===256);assert(process.env.MERIDIAN_CREDENTIALS_READONLY==='1');assert(account!==process.env.CLAUDE_CONFIG_DIR);
 writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify({account,work:process.env.MERIDIAN_WORKDIR,config:process.env.MERIDIAN_CONFIG_DIR,store:process.env.MERIDIAN_SESSION_DIR,plugins:config.pluginDir,home:process.env.HOME}));
 if(mode.pendingStartup)await new Promise(()=>{});
 if(mode.startupChild){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"],{cwd:process.env.MERIDIAN_WORKDIR,stdio:['ignore','pipe','ignore']});writeFileSync(new URL('startup-child-pid',import.meta.url),String(child.pid));await once(child.stdout,'data');throw new Error('synthetic startup failure after child readiness')}
 const input=body=>{const auxiliary=body&&!body.tools?.length;return{prompt:body?.messages?.[0]?.content??'synthetic',options:{model:mode.unsupportedAlias?'haiku':mode.sdkAlias?'sonnet':mode.wrongSdkId||auxiliary&&mode.classifierWrongSdkId?'claude-sonnet-4-6':body?.model??'claude-sonnet-5-5',maxTurns:1,env:{CLAUDE_CONFIG_DIR:account,...((mode.sdkAlias||mode.unsupportedAlias)&&!mode.missingPin&&!(auxiliary&&mode.classifierMissingPin)?{ANTHROPIC_DEFAULT_SONNET_MODEL:mode.wrongPin||auxiliary&&mode.classifierWrongPin?'claude-sonnet-4-6':body?.model??'claude-sonnet-5-5'}:{})},pathToClaudeCodeExecutable:process.env.MERIDIAN_CLAUDE_PATH,abortController:new AbortController()}}};
 if(mode.queryAtStartup)query(input());
 const server=createServer(async(req,res)=>{try{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),aux=!body.tools?.length;const execute=async()=>{
 let content=[];for await(const event of query(input(body)))if(event.type==='assistant')content=event.message.content;
 if(mode.duplicateRequest)for await(const event of query(input(body))){}
 if(content.length){toolTerminals++;const current=content[0];if(mode.repeatHttpToolId&&toolTerminals===2)content=[current,previousTool];previousTool=current;if(mode.borrowTerminal&&toolTerminals===2)content=[]}
 const reportedAux=mode.swapped&&++requests<=2?!aux:aux;const lineage=reportedAux||main===0||mode.baseline?'diverged':'continuation';const divergence=reportedAux?(mode.baseline?'unrelated-history':'independent-request:auxiliary-request'):main>0&&mode.baseline?'unrelated-history':undefined;if(!aux)main++;
 if(!config.silent)console.log('[PROXY] '+req.headers['x-request-id']+' adapter=claude-code msgCount='+body.messages.length+' tools='+(body.tools?.length??0)+' lineage='+lineage+(divergence?' diverged='+divergence:'')+' sessionWait=0ms private=synthetic-owner-secret');
 if(content.length){if(mode.terminalSse){const tool=content[0],events=[{type:'message_start',message:{type:'message',content:[]}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:tool.id,name:tool.name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(tool.input)}},...(mode.brokenTerminal?[]:[{type:'content_block_stop',index:0}]),{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}];if(mode.missingStart)events.shift();if(mode.earlyStop)events.splice(3,0,{type:'message_stop'});if(mode.postTerminalContent)events.push({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:''}});if(mode.duplicateIndex)events.splice(2,0,{...events[1]});if(mode.inputAfterClose)events.splice(4,0,{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:''}});res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+String.fromCharCode(10,10)).join(''))}else{if(mode.brokenTerminal)content[0].input.command='different synthetic tool';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'message',stop_reason:'tool_use',content}))}}else{res.writeHead(200,{'content-type':'application/json'});res.end('{}')}};const invoke=id=>mode.missingContext?execute():logger.run({requestId:mode.unmatchedContext?'synthetic-unmatched-request':id,endpoint:'/v1/messages'},execute);if(mode.swappedContexts&&++contextRequests<=2){let release;const wait=new Promise(resolve=>{release=resolve});firstPair.push({id:req.headers['x-request-id'],invoke,release});if(firstPair.length===2)await Promise.all(firstPair.map((item,index)=>item.invoke(firstPair[1-index].id).finally(item.release)));await wait}else await invoke(req.headers['x-request-id'])}catch{res.writeHead(500);res.end('{}')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,close:()=>new Promise(resolve=>server.close(()=>{if(mode.descriptorDrift||mode.unrestorableDescriptor){const descriptor=Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run');Object.defineProperty(AsyncLocalStorage.prototype,'run',{...descriptor,...(mode.unrestorableDescriptor?{configurable:false}:{enumerable:!descriptor.enumerable})})}resolve()}))}
}
`)
  const client = join(target, 'client')
  writeFileSync(client, `#!/usr/bin/env node
import assert from 'node:assert/strict';import{readFileSync,existsSync,writeFileSync}from'node:fs';
assert(!process.env.ANTHROPIC_API_KEY&&!process.env.CLAUDE_CODE_OAUTH_TOKEN&&!process.env.MERIDIAN_CONFIG_DIR&&!process.env.MERIDIAN_SESSION_DIR&&!process.env.CLAUDE_PROXY_CONFIG_DIR&&!process.env.AWS_PROFILE);
if(process.argv.includes('--version')){console.log('2.1.286 (Claude Code)');process.exit(0)}
assert(process.env.ANTHROPIC_AUTH_TOKEN==='meridian-e71-local-dummy');const mode=JSON.parse(readFileSync(new URL('mode.json',import.meta.url),'utf8'));
if(mode.hang){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);await new Promise(()=>{})}
const file=process.env.CLAUDE_CONFIG_DIR+'/turn.json';const turn=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(turn));
const headers={'content-type':'application/json'};if(process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS)headers['x-claude-code-request-class']='main';
const model=process.argv[process.argv.indexOf('--model')+1];
const session=process.argv[process.argv.indexOf(process.argv.includes('--resume')?'--resume':'--session-id')+1];
async function send(aux){const envelope='You are a security monitor for autonomous AI coding agents.\\n<cc_automode_permissions>\\nSynthetic permission rules.\\n</cc_automode_permissions>';const body={model:mode.wireWrongModel||aux&&mode.classifierWrongWire?'claude-sonnet-4-6':aux&&mode.mixedModels?'claude-sonnet-5':model,metadata:{user_id:JSON.stringify({session_id:session})},stream:false,messages:[{role:'user',content:mode.markerInUser?envelope:aux?'synthetic':process.argv[process.argv.indexOf('-p')+1]}],tools:aux?[]:[{name:'Read'}],...(aux?{stop_sequences:['</block>'],...(mode.markerInUser?{}:{system:[{type:'text',text:'Billing header first'},{type:'text',text:envelope}]})}:{})};if(aux&&mode.fast){delete body.stream;delete body.stop_sequences;body.messages.push({role:'user',content:'segment2'},{role:'user',content:'segment3'})}const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{...headers,...(aux&&headers['x-claude-code-request-class']?{'x-claude-code-request-class':'auxiliary'}:{})},body:JSON.stringify(body)});await response.text();assert(response.status===200)}
if(mode.swappedContexts&&turn===1){await Promise.all([send(false),send(true)]);await send(false)}else{await send(false);if(turn!==3&&!mode.missingClassifier){await send(true);await send(false)}}
const prompt=process.argv[process.argv.indexOf('-p')+1];if(prompt.includes('date > ')){const destination=prompt.split('date > ')[1].split(String.fromCharCode(96))[0];writeFileSync(destination,'Synthetic date receipt\\n')}
console.log(['ONE','TWO','THREE','FOUR'][turn-1]+' synthetic-owner-secret');
`)
  chmodSync(client, 0o700)
  const native = join(target, 'native')
  writeFileSync(native, '#!/usr/bin/env node\nconsole.log("2.1.284 (Claude Code)")\n'); chmodSync(native, 0o700)
  const grant = join(root, 'owned-grant.json')
  const bytes = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-owner-secret', refreshToken: 'synthetic-refresh-never-used', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] } })
  writeFileSync(grant, bytes, { mode: 0o400 })
  return { root, target, sdk, client, native, proof, grant, bytes, mode }
}
function commandFor(f: ReturnType<typeof fixture>, extras: string[] = [], timeout = '10000') {
  const classifierModel = f.mode.mixedModels ? 'claude-sonnet-5' : 'claude-sonnet-5-5'
  return [process.execPath, harness, '--synthetic', '--target-root', f.target, '--entry', 'server.mjs', '--client', f.client, '--client-version', '2.1.286', '--native-cli', f.native, '--native-cli-version', '2.1.284', '--sdk-version', '0.2.141', '--model', 'claude-sonnet-5-5', '--served-model', 'claude-sonnet-5-5', '--classifier-model', classifierModel, '--classifier-served-model', classifierModel, '--grant-file', f.grant, '--proof-dir', f.proof, '--max-queries', '20', '--max-cost-usd', '10', '--timeout-ms', timeout, ...extras]
}
async function run(mode: Mode = {}, extras: string[] = [], timeout = '10000') {
  const f = fixture(mode)
  let retainedSyntheticRuntime: string | undefined
  try {
    let command = commandFor(f, extras, timeout)
    const cloneMarker = join(f.root, 'clone-receipt-entered')
    const cloneCancelMarker = join(f.root, 'clone-cancellation-entered')
    if (mode.cloneHang || mode.cloneError) {
      const preload = join(f.root, 'clone-control.mjs')
      writeFileSync(preload, `import{spyOn}from'bun:test';import{writeFileSync}from'node:fs';const original=Response.prototype.clone;let injected=false;spyOn(Response.prototype,'clone').mockImplementation(function(){if(injected)return Reflect.apply(original,this,[]);injected=true;writeFileSync(${JSON.stringify(cloneMarker)},'synthetic clone-only receipt entered');return{body:{getReader(){return{read:()=>Promise.reject(new Error('synthetic cloned read failure')),cancel:()=>{writeFileSync(${JSON.stringify(cloneCancelMarker)},'synthetic clone cancellation entered');return ${mode.cloneHang ? 'new Promise(()=>{})' : 'Promise.resolve()'}},releaseLock(){}}}}}});`, { mode: 0o600 })
      command = [command[0]!, '--preload', preload, ...command.slice(1)]
    }
    const child = Bun.spawn(command, { cwd: f.target, env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-ambient', ANTHROPIC_AUTH_TOKEN: 'synthetic-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-ambient', MERIDIAN_PROFILES: 'synthetic-ambient', MERIDIAN_TELEMETRY_DB: '/synthetic-no-write', CLAUDE_PROXY_CONFIG_DIR: '/synthetic-no-read', AWS_PROFILE: 'synthetic-ambient' }, stdout: 'pipe', stderr: 'pipe' })
    let independentDeadline: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { independentDeadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Independent synthetic harness deadline')) }, Number(timeout) + 20000) })
    let collected: [string, string, number]
    try { collected = await Promise.race([Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), deadline]) }
    finally { clearTimeout(independentDeadline); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } }
    const [out, err, code] = collected
    const serialized = readFileSync(join(f.proof, 'claude-auto-mode-results.json'), 'utf8')
    const report = JSON.parse(serialized) as { result: string; acceptance: boolean; privateSnapshotCreated?: boolean; privateRuntimeRemoved: boolean; ownerGrantUnchanged: boolean; queries: Array<{ request: number; role: string; wireRequested: string; requested: string; versionPin?: string; nativeModels: string[] }>; checks: Record<string, boolean>; cleanupFailures: string[]; targetIdentityUnchanged?: boolean; failure?: string; loggerContextDescriptorRestored?: boolean; ownedResidualProcesses?: number; httpReceiptFailure?: boolean; relayOperationsJoined?: boolean; httpReceiptsJoined?: boolean; pendingHttpReceipts?: number; pendingRelayHandlers?: number; requestModelWitness?: { capturedRequests: number; missingContext: boolean; duplicateContext: boolean } }
    expect(serialized + out + err).not.toContain('synthetic-owner-secret')
    expect(serialized + out + err).not.toContain('synthetic-refresh-never-used')
    expect(serialized + out + err).not.toMatch(/e71-[a-f0-9-]{36}/)
    expect(report.acceptance).toBe(false)
    expect(report.ownerGrantUnchanged).toBe(true)
    const retained = !!(mode.pendingStartup || mode.descriptorDrift || mode.unrestorableDescriptor || mode.cloneHang)
    const cleanupEvidence = process.env.E71_CONTEXT_EVIDENCE_DIR
    if (mode.hang && cleanupEvidence) {
      mkdirSync(cleanupEvidence, { recursive: true, mode: 0o700 })
      writeFileSync(join(cleanupEvidence, 'hung-client-cleanup.json'), JSON.stringify({
        acceptance: report.acceptance,
        privateRuntimeRemoved: report.privateRuntimeRemoved,
        ownedResidualProcesses: report.ownedResidualProcesses,
        cleanupFailures: report.cleanupFailures,
        loggerContextDescriptorRestored: report.loggerContextDescriptorRestored,
        relayOperationsJoined: report.relayOperationsJoined,
        httpReceiptsJoined: report.httpReceiptsJoined,
        pendingHttpReceipts: report.pendingHttpReceipts,
        pendingRelayHandlers: report.pendingRelayHandlers,
      }, null, 2), { mode: 0o600, flag: 'wx' })
    }
    // Diagnose the concrete failed join before its derived retention assertion.
    // Every positive/retained-runtime assertion remains required.
    if (!retained) expect(report.cleanupFailures).toEqual([])
    expect(report.privateRuntimeRemoved).toBe(!retained)
    if (mode.pendingStartup) {
      expect(report.cleanupFailures).toContain('proxy startup join')
      expect(report.cleanupFailures).toContain('private runtime retained after cleanup failure')
    } else if (mode.cloneHang) {
      expect(report.ownedResidualProcesses).toBe(0); expect(report.cleanupFailures).toContain('HTTP receipt join')
      expect(report.cleanupFailures).toContain('logger context retained after unjoined work'); expect(report.cleanupFailures).toContain('private runtime retained after cleanup failure')
    } else if (mode.descriptorDrift || mode.unrestorableDescriptor) {
      expect(report.ownedResidualProcesses).toBe(0)
      expect(report.cleanupFailures).toContain('logger context restore')
      expect(report.cleanupFailures).toContain('private runtime retained after cleanup failure')
    }
    expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes)
    expect(statSync(f.grant).mode & 0o777).toBe(0o400)
    if (mode.cloneHang || mode.cloneError) { expect(existsSync(cloneMarker)).toBe(true); expect(existsSync(cloneCancelMarker)).toBe(true); expect(report.queries.length).toBeGreaterThan(0) }
    if (existsSync(join(f.target, 'audit.json'))) {
      const audit = JSON.parse(readFileSync(join(f.target, 'audit.json'), 'utf8')) as Record<string, string>
      expect(new Set(Object.values(audit)).size).toBe(Object.values(audit).length)
      for (const directory of Object.values(audit)) expect(existsSync(directory)).toBe(retained)
      if (retained) {
        const account = audit.account
        if (typeof account !== 'string' || account.length === 0) throw new Error('Synthetic retained-runtime audit lacks an account directory')
        const candidate = dirname(account)
        expect(basename(candidate).startsWith('meridian-e71-')).toBe(true)
        expect(Object.values(audit).every(directory => dirname(directory) === candidate)).toBe(true)
        retainedSyntheticRuntime = candidate
      }
    }
    if (existsSync(join(f.target, 'startup-child-pid'))) {
      const pid = Number(readFileSync(join(f.target, 'startup-child-pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }
    const evidence = process.env.E71_CONTEXT_EVIDENCE_DIR
    if (evidence && (mode.cloneHang || mode.cloneError)) {
      mkdirSync(evidence, { recursive: true, mode: 0o700 })
      const name = mode.cloneHang ? 'clone-hang' : 'clone-error'
      writeFileSync(join(evidence, `${name}.json`), serialized, { mode: 0o600, flag: 'wx' })
      writeFileSync(join(evidence, `${name}-preload.mjs`), readFileSync(join(f.root, 'clone-control.mjs')), { mode: 0o600, flag: 'wx' })
      writeFileSync(join(evidence, `${name}-marker.txt`), readFileSync(cloneMarker), { mode: 0o600, flag: 'wx' })
      writeFileSync(join(evidence, `${name}-cancel-marker.txt`), readFileSync(cloneCancelMarker), { mode: 0o600, flag: 'wx' })
    }
    return { report, code, queried: existsSync(join(f.target, 'query-called')) }
  } finally {
    // The independent controller owns this non-auth fixture. A retained
    // startup Promise has no child; descriptor failures have joined all work.
    if (retainedSyntheticRuntime) rmSync(retainedSyntheticRuntime, { recursive: true, force: true })
    rmSync(f.root, { recursive: true, force: true })
  }
}

async function actualTargetControl(kind: 'source' | 'compiled', mode: 'positive' | 'swap' | 'unmatched' | 'duplicate') {
  const repository = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'meridian-e71-actual-context-'))
  const manifest = kind === 'compiled' ? JSON.parse(readFileSync(join(repository, 'dist/build-provenance.json'), 'utf8')) as { build: { sha: string; dirty: boolean; certification: string }; artifacts: Record<string, string> } : undefined
  const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const entry = join(repository, kind === 'source' ? 'src/proxy/server.ts' : 'dist/server.js')
  let models = join(repository, 'src/proxy/models.ts')
  if (kind === 'compiled') {
    if (!manifest) throw new Error('Compiled control needs an existing certified build')
    expect(manifest.build.dirty).toBe(false); expect(manifest.build.certification).toBe('verified')
    const found = Object.keys(manifest.artifacts).find(file => file.endsWith('.js') && /export \{[^\n]*getClaudeAuthStatusAsync[^\n]*resolveClaudeExecutableAsync/.test(readFileSync(join(repository, 'dist', file), 'utf8')))
    if (!found) throw new Error('Certified compiled model module unavailable')
    models = join(repository, 'dist', found)
    const modelArtifactHash = manifest.artifacts[found], entryArtifactHash = manifest.artifacts['server.js']
    if (typeof modelArtifactHash !== 'string' || typeof entryArtifactHash !== 'string') throw new Error('Certified compiled artifact hashes unavailable')
    expect(digest(models)).toBe(modelArtifactHash); expect(digest(entry)).toBe(entryArtifactHash)
  }
  const resultFile = join(root, 'results.json'), script = join(root, 'control.mjs')
  writeFileSync(script, `import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mock,spyOn } from 'bun:test';
import { createRequestModelWitness } from ${JSON.stringify(harness)};
const root=${JSON.stringify(root)},entry=${JSON.stringify(entry)},modelEntry=${JSON.stringify(models)},mode=${JSON.stringify(mode)};
for(const key of Object.keys(process.env))if(/^(CLAUDE|ANTHROPIC|MERIDIAN|CLAUDE_PROXY|OPENAI|AWS_|GOOGLE_|VERTEX_|BEDROCK_|NODE_OPTIONS|BUN_OPTIONS|OPENCODE_)/.test(key))delete process.env[key];
for(const directory of ['home','config','store','work','claude','plugins'])mkdirSync(join(root,directory),{mode:0o700});
Object.assign(process.env,{HOME:join(root,'home'),CLAUDE_CONFIG_DIR:join(root,'claude'),MERIDIAN_CONFIG_DIR:join(root,'config'),MERIDIAN_SESSION_DIR:join(root,'store'),MERIDIAN_WORKDIR:join(root,'work'),MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE:'1',MERIDIAN_ROUTING:'active',MERIDIAN_PASSTHROUGH:'1',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_MAX_CONCURRENT:'4',MERIDIAN_SHUTDOWN_GRACE_MS:'1000'});
for(const kind of ['CONFIG','DATA','CACHE','STATE']){const directory=join(root,'xdg-'+kind);mkdirSync(directory,{mode:0o700});process.env['XDG_'+kind+'_HOME']=directory}
writeFileSync(join(root,'config/settings.json'),'{}');writeFileSync(join(root,'config/profiles.json'),'[]');writeFileSync(join(root,'plugins.json'),'{}');
const main={request:1,role:'main',requestedModel:'claude-sonnet-5-5'},classifier={request:2,role:'classifier',requestedModel:'claude-sonnet-5'};
const known=new Map([['synthetic-actual-main',main],['synthetic-actual-classifier',classifier]]),descriptor=Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run'),witness=createRequestModelWitness(known),observations=[],active=new Set(),controls=[];
let proxy,auth,executable,externalFetchAttempts=0,failed=false,restored=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname!=='127.0.0.1'){externalFetchAttempts++;throw new Error('External traffic fenced in actual-target synthetic control')}return originalFetch(input,options)};
const sdkPath=createRequire(entry).resolve('@anthropic-ai/claude-agent-sdk');
mock.module(sdkPath,()=>({
 query(input){const owned=witness.capture(),matched=input.options.model===owned.requestedModel||(input.options.model==='sonnet'&&input.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL===owned.requestedModel);observations.push({request:owned.request,role:owned.role,requested:owned.requestedModel,sdk:input.options.model,versionPin:input.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,matched});assert(matched,'Actual target SDK query differs from its exact logger-owned wire model');let release;const held=new Promise(resolve=>{release=resolve});controls.push(release);if(controls.length===2)controls.forEach(fn=>fn());const session=input.options.sessionId??input.options.resume??crypto.randomUUID();const generator=(async function*(){active.add(generator);try{yield{type:'system',subtype:'init',session_id:session};if(mode==='positive')await held;yield{type:'assistant',uuid:crypto.randomUUID(),session_id:session,message:{id:'synthetic-msg',type:'message',role:'assistant',model:owned.requestedModel,content:[{type:'text',text:'synthetic complete'}],usage:{input_tokens:12,output_tokens:4},stop_reason:'end_turn'}};yield{type:'result',subtype:'success',is_error:false,session_id:session,num_turns:1,total_cost_usd:0.001,usage:{input_tokens:12,output_tokens:4}}}finally{active.delete(generator)}})();return Object.assign(generator,{close:release})},
 createSdkMcpServer:input=>({type:'sdk',name:input.name,instance:{tool(){},registerTool(){return{}},connect(){}}}),tool:(name,description,inputSchema,handler)=>({name,description,inputSchema,handler})
}));
const targetModels=await import(pathToFileURL(modelEntry).href);
auth=spyOn(targetModels,'getClaudeAuthStatusAsync').mockResolvedValue({loggedIn:true,subscriptionType:'max'});
executable=spyOn(targetModels,'resolveClaudeExecutableAsync').mockResolvedValue(join(root,'never-executed-native'));
try{
 const {startProxyServer}=await import(pathToFileURL(entry).href);
 proxy=await startProxyServer({host:'127.0.0.1',port:0,silent:true,profiles:[{id:'fixture',type:'api',apiKey:'synthetic-non-auth-fixture'}],defaultProfile:'fixture',pluginDir:join(root,'plugins'),pluginConfigPath:join(root,'plugins.json')});
 const address=proxy.server.address();assert(address&&typeof address==='object');
 const session=crypto.randomUUID(),envelope='You are a security monitor for autonomous AI coding agents.\\n<cc_automode_permissions>\\nSynthetic rules.\\n</cc_automode_permissions>';
 const post=async(which,id)=>{const auxiliary=which.role==='classifier',body={model:which.requestedModel,max_tokens:128,stream:false,metadata:{user_id:JSON.stringify({session_id:mode==='duplicate'?crypto.randomUUID():session})},messages:[{role:'user',content:'synthetic '+which.role}],tools:[],...(auxiliary?{system:[{type:'text',text:envelope}],stop_sequences:['</block>']}:{})};const response=await fetch('http://127.0.0.1:'+address.port+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','user-agent':'claude-cli/2.1.286','x-request-id':id,'x-meridian-profile':'fixture',...(auxiliary?{'x-claude-code-request-class':'auxiliary'}:{'x-claude-code-request-class':'main'})},body:JSON.stringify(body)});await response.text();return response.status};
 const pairs=mode==='duplicate'?[[main,'synthetic-actual-main'],[main,'synthetic-actual-main']]:[[main,mode==='swap'?'synthetic-actual-classifier':'synthetic-actual-main'],[classifier,mode==='swap'?'synthetic-actual-main':mode==='unmatched'?'synthetic-unmatched':'synthetic-actual-classifier']];
 const statuses=await Promise.all(pairs.map(([which,id])=>post(which,id)));
 if(mode==='positive'){assert(statuses.every(status=>status===200));assert(observations.length===2&&observations.every(row=>row.matched));assert(witness.summary().capturedRequests===2)}
 else if(mode==='swap'){assert(statuses.every(status=>status>=500));assert(observations.length===2&&observations.every(row=>!row.matched))}
 else {assert(statuses.some(status=>status>=500));assert(witness.summary()[mode==='duplicate'?'duplicateContext':'missingContext'])}
 writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({kind:${JSON.stringify(kind)},mode,statuses,observations,summary:witness.summary(),entrySha256:${JSON.stringify(digest(entry))},modelModuleSha256:${JSON.stringify(digest(models))},compiledSourceHead:${JSON.stringify(manifest?.build.sha ?? null)}}));
}catch(error){failed=true;throw error}finally{
 controls.forEach(fn=>fn());if(proxy)await proxy.close();assert(active.size===0,'Synthetic SDK generator did not join');auth?.mockRestore();executable?.mockRestore();witness.restore();restored=witness.isRestored();assert.deepEqual(Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run'),descriptor);globalThis.fetch=originalFetch;
 if(!failed){const {readFileSync}=await import('node:fs');const report=JSON.parse(readFileSync(${JSON.stringify(resultFile)},'utf8'));Object.assign(report,{loggerDescriptorRestored:restored,joinedGenerators:true,externalFetchAttempts,authDiscovery:false,executableDiscovery:false});writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(report));assert(externalFetchAttempts===0)}
}
`, { mode: 0o600 })
  const child = Bun.spawn([process.execPath, script], { cwd: repository, stdout: 'pipe', stderr: 'pipe' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Actual target control deadline')) }, 15000) })
    const [out, err, code] = await Promise.race([Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), deadline])
    expect(code, out + err).toBe(0)
    const report = JSON.parse(readFileSync(resultFile, 'utf8')) as { loggerDescriptorRestored: boolean; joinedGenerators: boolean; externalFetchAttempts: number; observations: Array<{ request: number; matched: boolean }>; mode: string; compiledSourceHead: string | null }
    expect(report.loggerDescriptorRestored).toBe(true); expect(report.joinedGenerators).toBe(true); expect(report.externalFetchAttempts).toBe(0)
    const evidence = process.env.E71_CONTEXT_EVIDENCE_DIR
    if (evidence) {
      mkdirSync(evidence, { recursive: true, mode: 0o700 }); expect(statSync(evidence).mode & 0o077).toBe(0)
      writeFileSync(join(evidence, `${kind}-${mode}.json`), readFileSync(resultFile), { mode: 0o600, flag: 'wx' })
      writeFileSync(join(evidence, `${kind}-${mode}-runner.mjs`), readFileSync(script), { mode: 0o600, flag: 'wx' })
    }
    return report
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; rmSync(root, { recursive: true, force: true }) }
}

describe('E71 native harness containment and meaningful assertions', () => {
  it('joins failed clone reads but retains pending cancellation before descriptor restoration', async () => {
    const error = await run({ cloneError: true })
    expect(error.code).toBe(1); expect(error.report.httpReceiptFailure).toBe(true); expect(error.report.checks.nativeReceipts).toBe(false)
    expect(error.report.relayOperationsJoined).toBe(true); expect(error.report.httpReceiptsJoined).toBe(true); expect(error.report.pendingHttpReceipts).toBe(0); expect(error.report.pendingRelayHandlers).toBe(0); expect(error.report.loggerContextDescriptorRestored).toBe(true)
    const hanging = await run({ cloneHang: true }, [], '3000')
    expect(hanging.code).toBe(1); expect(hanging.report.relayOperationsJoined).toBe(true); expect(hanging.report.httpReceiptsJoined).toBe(false)
    expect(hanging.report.pendingHttpReceipts).toBe(1); expect(hanging.report.pendingRelayHandlers).toBe(0); expect(hanging.report.loggerContextDescriptorRestored).toBe(false)
  }, 30000)
  it('rejects symlink and nonregular grants before any content read or SDK invocation', async () => {
    for (const kind of ['symlink', 'directory']) {
      const f = fixture(), selected = join(f.root, 'invalid-grant'), marker = join(f.root, 'grant-read-observed'), preload = join(f.root, 'observe-reads.mjs')
      try {
        if (kind === 'symlink') symlinkSync(f.grant, selected)
        else mkdirSync(selected, { mode: 0o700 })
        writeFileSync(preload, `import * as fs from 'node:fs';import {spyOn} from 'bun:test';const selected=${JSON.stringify(selected)},target=${JSON.stringify(f.grant)},marker=${JSON.stringify(marker)},read=fs.readFileSync,open=fs.openSync,tracked=new Set();spyOn(fs,'openSync').mockImplementation((file,...args)=>{const fd=open(file,...args);if(file===selected||file===target)tracked.add(fd);return fd});spyOn(fs,'readFileSync').mockImplementation((file,...args)=>{if(file===selected||file===target||tracked.has(file))fs.writeFileSync(marker,'synthetic selected grant content read');return read(file,...args)});`, { mode: 0o600 })
        const command = commandFor(f); command[command.indexOf('--grant-file') + 1] = selected
        const child = Bun.spawn([command[0]!, '--preload', preload, ...command.slice(1)], { cwd: f.target, stdout: 'pipe', stderr: 'pipe' })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        const report = JSON.parse(readFileSync(join(f.proof, 'claude-auto-mode-results.json'), 'utf8')) as { queries: unknown[]; cleanupFailures: string[]; privateRuntimeRemoved: boolean }
        expect(code).toBe(1); expect(existsSync(marker)).toBe(false); expect(existsSync(join(f.target, 'query-called'))).toBe(false)
        expect(report.queries).toEqual([]); expect(report.cleanupFailures).toEqual([]); expect(report.privateRuntimeRemoved).toBe(true)
        expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes); expect(out + err).not.toContain('synthetic-owner-secret')
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
  }, 30000)
  it('binds actual source HTTP requests to SDK models with exact ALS restoration', async () => {
    for (const mode of ['positive', 'swap', 'unmatched', 'duplicate'] as const) {
      const report = await actualTargetControl('source', mode)
      expect(report.mode).toBe(mode)
      if (mode === 'positive') expect(report.observations.map(row => row.request).sort()).toEqual([1, 2])
      if (mode === 'swap') expect(report.observations.every(row => !row.matched)).toBe(true)
    }
  }, 150000)
  // Clean checkouts have no dist. This explicit lane consumes an existing
  // certified build; it never creates one or claims compiled proof when absent.
  ;(process.env.E71_COMPILED_CONTEXT_CONTROL === '1' ? it : it.skip)('binds existing certified compiled HTTP requests to SDK models with exact ALS restoration', async () => {
    for (const mode of ['positive', 'swap', 'unmatched', 'duplicate'] as const) {
      const report = await actualTargetControl('compiled', mode)
      expect(report.mode).toBe(mode); expect(report.compiledSourceHead).not.toBeNull()
      if (mode === 'positive') expect(report.observations.map(row => row.request).sort()).toEqual([1, 2])
      if (mode === 'swap') expect(report.observations.every(row => !row.matched)).toBe(true)
    }
  }, 150000)
  it('preserves actual ALS callback arguments, return/throw/store propagation and exact restoration', async () => {
    const { createRequestModelWitness } = await import(harness)
    const descriptor = Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')
    const main = { request: 1, turn: 1, role: 'main', requestedModel: 'claude-sonnet-5-5' }
    const requests = new Map([['synthetic-main', main]])
    const witness = createRequestModelWitness(requests), logger = new AsyncLocalStorage(), unrelated = new AsyncLocalStorage()
    try {
      const store = { requestId: 'synthetic-main', endpoint: '/v1/messages', extra: 'preserved' }
      const returned = await logger.run(store, async (first, second) => {
        expect(first).toBe(4); expect(second).toBe(9); expect(logger.getStore()).toBe(store)
        await Promise.resolve()
        return unrelated.run({ requestId: 'unknown-other-store', endpoint: '/v1/messages' }, () => { expect(logger.getStore()).toBe(store); expect(witness.capture()).toBe(main); return first + second })
      }, 4, 9)
      expect(returned).toBe(13)
      const error = new Error('synthetic callback error')
      expect(() => logger.run(store, () => { throw error })).toThrow(error)
      expect(logger.getStore()).toBeUndefined()
    } finally { witness.restore() }
    expect(Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')).toEqual(descriptor)
  })
  it('clears a borrowed outer witness for every malformed or unmatched nested run on the pinned logger', async () => {
    const { createRequestModelWitness } = await import(harness)
    for (const nested of [{ endpoint: '/v1/messages' }, { requestId: 123, endpoint: '/v1/messages' }, { requestId: 'synthetic-main', endpoint: '/wrong' }, { requestId: 'unknown', endpoint: '/v1/messages' }, null]) {
      const descriptor = Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run'), requests = new Map([['synthetic-main', { request: 1 }]])
      const witness = createRequestModelWitness(requests), logger = new AsyncLocalStorage()
      try {
        logger.run({ requestId: 'synthetic-main', endpoint: '/v1/messages' }, () => {
          expect(() => logger.run(nested, () => witness.capture())).toThrow('SDK query lacks an exact owned logger request context')
        })
        expect(witness.summary().capturedRequests).toBe(0); expect(witness.summary().missingContext).toBe(true)
      } finally { witness.restore() }
      expect(Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')).toEqual(descriptor)
    }
  })
  it('restores the original ALS descriptor before reporting restorable descriptor drift', async () => {
    const { createRequestModelWitness } = await import(harness)
    const descriptor = Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')
    if (!descriptor) throw new Error('Missing original ALS descriptor')
    const witness = createRequestModelWitness(new Map())
    Object.defineProperty(AsyncLocalStorage.prototype, 'run', { ...descriptor, value: descriptor.value, enumerable: !descriptor.enumerable })
    expect(() => witness.restore()).toThrow('Logger context descriptor changed before restoration')
    expect(witness.isRestored()).toBe(true)
    expect(Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype, 'run')).toEqual(descriptor)
  })
  it('reports actual descriptor restoration truthfully when joined cleanup detects drift or cannot restore', async () => {
    for (const mode of [{ descriptorDrift: true }, { unrestorableDescriptor: true }]) {
      const result = await run(mode)
      expect(result.code).toBe(1); expect(result.report.result).toBe('FAIL'); expect(result.report.checks.requestModelOwnership).toBe(true)
      expect(result.report.loggerContextDescriptorRestored).toBe(!mode.unrestorableDescriptor)
    }
  }, 30000)
  it('keeps unrestorable descriptor state and restoration status truthful in an isolated process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-e71-descriptor-control-')), script = join(root, 'control.mjs')
    writeFileSync(script, `import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';import {createRequestModelWitness} from ${JSON.stringify(harness)};const descriptor=Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run'),witness=createRequestModelWitness(new Map());Object.defineProperty(AsyncLocalStorage.prototype,'run',{...Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run'),configurable:false});assert.throws(()=>witness.restore());assert.equal(witness.isRestored(),false);const current=Object.getOwnPropertyDescriptor(AsyncLocalStorage.prototype,'run');assert.equal(current.configurable,false);assert.notEqual(current.value,descriptor.value);console.log(JSON.stringify({restored:false,configurable:false,originalFunction:false}));`, { mode: 0o600 })
    try {
      const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code, err).toBe(0); expect(JSON.parse(out)).toEqual({ restored: false, configurable: false, originalFunction: false })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects existing proof links and regular files before any query without changing their targets', async () => {
    for (const kind of ['symlink', 'hardlink', 'regular']) {
      const f = fixture(), resultFile = join(f.proof, 'claude-auto-mode-results.json'), target = kind === 'regular' ? resultFile : join(f.root, 'unrelated-owner-file')
      const bytes = 'synthetic existing output owner bytes\n'
      try {
        writeFileSync(target, bytes, { mode: 0o600 })
        if (kind === 'symlink') symlinkSync(target, resultFile)
        if (kind === 'hardlink') linkSync(target, resultFile)
        const before = statSync(target)
        const child = Bun.spawn(commandFor(f), { cwd: f.target, stdout: 'pipe', stderr: 'pipe' })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect(code).toBe(1)
        expect(readFileSync(target, 'utf8')).toBe(bytes)
        expect(statSync(target).ino).toBe(before.ino)
        expect(statSync(target).nlink).toBe(before.nlink)
        expect(existsSync(join(f.target, 'query-called'))).toBe(false)
        expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes)
        expect(out + err).not.toContain('synthetic-owner-secret')
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
  }, 30000)
  it('runs an independent synthetic client through dynamic HTTP ports with ambient auth rejected', async () => {
    const result = await run(); expect(result.code).toBe(0); expect(result.report.result).toBe('PASS'); expect(result.report.targetIdentityUnchanged).toBe(true); expect(result.report.queries.length).toBe(10)
  }, 30000)
  it('correlates distinct main and audited Sonnet5 classifier requests through full IDs and alias pins', async () => {
    for (const sdkAlias of [false, true]) {
      const result = await run({ mixedModels: true, sdkAlias, fast: true })
      expect(result.code, JSON.stringify(result.report)).toBe(0)
      expect(result.report.checks.requestModelOwnership).toBe(true)
      expect(result.report.loggerContextDescriptorRestored).toBe(true)
      expect(result.report.queries.filter(row => row.role === 'main').every(row => row.wireRequested === 'claude-sonnet-5-5' && row.nativeModels.every(model => model === 'claude-sonnet-5-5'))).toBe(true)
      expect(result.report.queries.filter(row => row.role === 'classifier').every(row => row.wireRequested === 'claude-sonnet-5' && row.nativeModels.every(model => model === 'claude-sonnet-5'))).toBe(true)
    }
  }, 30000)
  it('rejects wrong or absent classifier pins and role-specific requested/served swaps', async () => {
    for (const mode of [{ classifierWrongPin: true, sdkAlias: true }, { classifierMissingPin: true, sdkAlias: true }, { classifierWrongSdkId: true }, { classifierWrongServed: true }, { mainWrongServed: true }]) {
      const result = await run({ mixedModels: true, ...mode })
      expect(result.code).toBe(1); expect(result.report.checks.requestModelOwnership).toBe(true); expect(result.report.checks.nativeReceipts).toBe(false)
    }
    const wire = await run({ mixedModels: true, classifierWrongWire: true })
    expect(wire.code).toBe(1); expect(wire.report.checks.wireRequestedModel).toBe(false)
  }, 30000)
  it('rejects missing, unmatched and repeated SDK request contexts without borrowing receipts', async () => {
    for (const mode of [{ missingContext: true }, { unmatchedContext: true }, { duplicateRequest: true }]) {
      const result = await run(mode)
      expect(result.code).toBe(1); expect(result.report.checks.requestModelOwnership).toBe(false); expect(result.report.loggerContextDescriptorRestored).toBe(true)
      expect(result.report.requestModelWitness?.missingContext || result.report.requestModelWitness?.duplicateContext).toBe(true)
      if (!mode.duplicateRequest) { expect(result.queried).toBe(false); expect(result.report.queries).toEqual([]) }
    }
  }, 30000)
  it('rejects equal-count request ID swaps between different main and classifier models', async () => {
    const result = await run({ mixedModels: true, swappedContexts: true })
    expect(result.code).toBe(1); expect(result.report.queries.length).toBe(10)
    expect(result.report.checks.requestModelOwnership).toBe(true)
    expect(result.report.checks.nativeReceipts).toBe(false)
  }, 30000)
  it('the same baseline fails fixed expectations and passes only its named expected defects', async () => {
    const before = await run({ baseline: true }); expect(before.code).toBe(1); expect(before.report.checks.shapeIsolation).toBe(false); expect(before.report.checks.mainResume).toBe(false)
    const expected = await run({ baseline: true }, ['--expect-unfixed']); expect(expected.code).toBe(0); expect(expected.report.result).toBe('EXPECTED_BASELINE_FAILURE')
    const wrong = await run({}, ['--expect-unfixed']); expect(wrong.code).toBe(1)
  }, 30000)
  it('rejects a success that never exercises the actual classifier paths', async () => {
    const result = await run({ missingClassifier: true }); expect(result.code).toBe(1); expect(result.report.checks.classifierOccurred).toBe(false)
  }, 30000)
  it('accepts native fast classifier envelopes with omitted stream and stops after a billing block', async () => {
    const result = await run({ fast: true }); expect(result.code).toBe(0); expect(result.report.checks.classifierOccurred).toBe(true)
  }, 30000)
  it('rejects swapped per-request decisions even when auxiliary aggregate counts match', async () => {
    const result = await run({ swapped: true }); expect(result.code).toBe(1); expect(result.report.checks.shapeIsolation).toBe(false)
  }, 30000)
  it('rejects complete receipts from another actual served model', async () => {
    const result = await run({ wrongModel: true }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
  }, 30000)
  it('verifies exact requested wire identity and full SDK model or the supported Sonnet tier pin', async () => {
    const alias = await run({ sdkAlias: true }); expect(alias.code, JSON.stringify(alias.report)).toBe(0); expect(alias.report.checks.nativeReceipts).toBe(true)
    for (const mode of [{ sdkAlias: true, missingPin: true }, { sdkAlias: true, wrongPin: true }, { wrongSdkId: true }, { unsupportedAlias: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
    const wire = await run({ wireWrongModel: true }); expect(wire.code).toBe(1); expect(wire.report.checks.wireRequestedModel).toBe(false)
  }, 30000)
  it('accepts only a bounded max-turns tool receipt matched to a complete HTTP terminal', async () => {
    for (const terminalSse of [false, true]) {
      const complete = await run({ errorMaxTurns: true, terminalSse }); expect(complete.code, JSON.stringify(complete.report)).toBe(0); expect(complete.report.checks.nativeReceipts).toBe(true)
      const incomplete = await run({ errorMaxTurns: true, terminalSse, brokenTerminal: true }); expect(incomplete.code).toBe(1); expect(incomplete.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('rejects provider refusal receipts even when the synthetic client claims success', async () => {
    const result = await run({ refusal: true }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
  }, 30000)
  it('rejects a duplicate SDK tool ID borrowing another request terminal', async () => {
    const result = await run({ errorMaxTurns: true, duplicateToolId: true, borrowTerminal: true }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
  }, 30000)
  it('rejects an HTTP tool ID repeated in otherwise complete terminals', async () => {
    const result = await run({ errorMaxTurns: true, repeatHttpToolId: true }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
  }, 30000)
  it('rejects missing success error flags and false max-turns error flags', async () => {
    for (const mode of [{ missingErrorFlag: true }, { errorMaxTurns: true, falseMaxTurnsFlag: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('requires ordered SSE start, closed blocks and terminal events without later content', async () => {
    for (const mode of [{ missingStart: true }, { earlyStop: true }, { postTerminalContent: true }, { duplicateIndex: true }, { inputAfterClose: true }]) {
      const result = await run({ errorMaxTurns: true, terminalSse: true, ...mode }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('does not count an ordinary XML stop/user marker as the required native classifier envelope', async () => {
    const result = await run({ markerInUser: true }); expect(result.code).toBe(1); expect(result.report.checks.classifierOccurred).toBe(false)
  }, 30000)
  it('rehearsal refuses a target startup query before the independent SDK can be invoked', async () => {
    const result = await run({ queryAtStartup: true }, ['--rehearsal']); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
  }, 30000)
  it('refuses an unowned startup SDK query outside rehearsal before invoking the synthetic SDK', async () => {
    const result = await run({ queryAtStartup: true })
    expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
    expect(result.report.requestModelWitness?.missingContext).toBe(true); expect(result.report.loggerContextDescriptorRestored).toBe(true)
  }, 30000)
  it('removes the private account on an injected post-copy exception with zero queries', async () => {
    const result = await run({}, ['--fail-after-copy']); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.privateSnapshotCreated).toBe(true); expect(result.report.queries).toEqual([])
  }, 30000)
  it('joins a hung real synthetic client process when the total deadline fires', async () => {
    const result = await run({ hang: true }, [], '500'); expect(result.code).toBe(1); expect(result.queried).toBe(false)
  }, 30000)
  it('joins an ignored-TERM owned child after proxy startup fails', async () => {
    const result = await run({ startupChild: true }); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
  }, 30000)
  it('retains the private runtime and fails acceptance when startup cannot join', async () => {
    const result = await run({ pendingStartup: true }, [], '500'); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
  }, 30000)
})
