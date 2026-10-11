import { describe, expect, it } from 'bun:test'
import { constants as fsConstants, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PASSTHROUGH_DENY_REASON } from '../proxy/passthroughDenial'

const harness = resolve(import.meta.dir, '../../scripts/e2e-claude-code-subagent-session.mjs')
type Mode = { sdkCapFourHandoff?: boolean; sdkCapFourMissingDrop?: boolean; sdkCapFourForwardLate?: boolean; backgroundReadV2?: boolean; missingReadPath?: boolean; swappedReadPath?: boolean; sharedReadPath?: boolean; readPromptOnly?: boolean; readForeignFinal?: boolean; readPartial?: boolean; sdkExtraGeneration?: boolean; sdkMissingGenerationId?: boolean; sdkPublicDiagnostics?: boolean; sdkNativeTurnsTwo?: boolean; background?: boolean; backgroundBatchedParentWork?: boolean; backgroundPreissuedWait?: boolean; backgroundForkParent?: boolean; backgroundDirectParentBorrow?: boolean; backgroundForeignParentFork?: boolean; backgroundForegroundLaunch?: boolean; missingBackgroundHandle?: boolean; swappedBackgroundHandle?: boolean; unknownTaskOwner?: boolean; unboundedTaskOutput?: boolean; missingBackgroundCompletion?: boolean; parentAfterChildren?: boolean; earlyBackgroundCompletion?: boolean;  sdkLaterDeniedCall?: boolean; missingSdkHook?: boolean; unknownSdkDeny?: boolean; falseSdkForwardedClaim?: boolean; leakedDroppedSdkCall?: boolean; changedSdkHookInput?: boolean; earlyDroppedSdkCall?: boolean; baseline?: boolean; missingAgent?: boolean; missingDecision?: boolean; duplicateDecision?: boolean; missingWait?: boolean; swappedActor?: boolean; startupChild?: boolean; pendingStartup?: boolean; wrongModel?: boolean; queryAtStartup?: boolean; hang?: boolean; missingAgentTool?: boolean; duplicateToolId?: boolean; repeatHttpToolId?: boolean; missingErrorFlag?: boolean; falseMaxTurnsFlag?: boolean; brokenTerminal?: boolean; terminalSse?: boolean; missingStart?: boolean; earlyStop?: boolean; wrongBash?: boolean; missingToolResult?: boolean; wrongRoot?: boolean; noParallel?: boolean; forked?: boolean; refusal?: boolean; overCost?: boolean; requestOverflow?: boolean; oversizedBody?: boolean; sdkCloseThrow?: boolean; sdkCloseSignalFailure?: boolean; sdkPrefixed?: boolean; wrongSdkNamespace?: boolean; wrongSdkName?: boolean; streamingStagger?: boolean; preissuedToolResult?: boolean; sdkAlias?: boolean; wrongPin?: boolean; missingPin?: boolean; wireWrongModel?: boolean; swappedFinalChain?: boolean; ambiguousText?: boolean }
function fixture(mode: Mode = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meridian-e72-controls-'))
  const target = join(root, 'target'), sdk = join(target, 'node_modules/@anthropic-ai/claude-agent-sdk'), proof = join(root, 'proof')
  mkdirSync(sdk, { recursive: true, mode: 0o700 }); mkdirSync(proof, { mode: 0o700 })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'meridian-harness-synthetic-fixture', version: '0.0.0', type: 'module' }))
  writeFileSync(join(target, 'mode.json'), JSON.stringify(mode))
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.2.141', type: 'module', main: 'sdk.mjs', meridianHarnessSynthetic: true }))
  // Marked non-auth SDK. No import of a native dependency or ambient grant.
  writeFileSync(join(sdk, 'sdk.mjs'), `import{readFileSync,writeFileSync}from'node:fs';
const root=new URL('../../../',import.meta.url),mode=JSON.parse(readFileSync(new URL('mode.json',root),'utf8'));let count=0;
export function query(input){writeFileSync(new URL('query-called',root),'synthetic only');const data=JSON.parse(input.prompt);if(mode.sdkPrefixed||mode.wrongSdkNamespace||mode.wrongSdkName)for(const tool of data.tools??[])tool.name=mode.wrongSdkName?'mcp__oc__Unexpected':(mode.wrongSdkNamespace?'mcp__wrong__':'mcp__oc__')+tool.name;const session=input.options.sessionId??input.options.resume??'s'+String(++count).padStart(7,'0')+'-owned',content=data.tools?.length?data.tools:[{type:'text',text:mode.ambiguousText?'same final answer':data.actor==='main'?mode.backgroundPreissuedWait&&data.sequence===2?'WAITING':data.sequence>=(mode.background?(mode.backgroundBatchedParentWork?4:5):3)?'AGAIN':'DONE':data.actor+'-1 '+data.actor+'-2'}],toolTurn=content.some(block=>block.type==='tool_use');if(mode.duplicateToolId&&content[0]?.name==='Bash')content[0].id='synthetic-duplicate';return{close(){if(mode.sdkCloseThrow)throw new Error('synthetic close failure')},async *[Symbol.asyncIterator](){await new Promise(resolve=>setTimeout(resolve,mode.sdkCloseThrow?5000:mode.earlyBackgroundCompletion&&data.actor!=='main'&&data.sequence===3?600:mode.streamingStagger?150:40));for(const tool of content.filter(block=>block.type==='tool_use'))if(!mode.missingSdkHook)await input.options.hooks.PreToolUse[0].hooks[0]({tool_use_id:tool.id,tool_name:tool.name,tool_input:mode.changedSdkHookInput?{unexpected:true}:tool.input},tool.id,{});const generationId='private-generation-'+session+'-'+data.sequence;if(mode.sdkPublicDiagnostics||mode.backgroundReadV2){yield{type:'system',subtype:'init',tools:['Read','mcp__oc__Agent','mcp__oc__Bash',mode.backgroundReadV2?'mcp__oc__Read':'mcp__oc__TaskOutput']};if(!mode.sdkMissingGenerationId)yield{type:'stream_event',event:{type:'message_start',message:{id:generationId,model:'claude-sonnet-5-5'}}};if(mode.sdkExtraGeneration)yield{type:'stream_event',event:{type:'message_start',message:{id:generationId+'-extra',model:'claude-sonnet-5-5'}}}}const firstAssistant={type:'assistant',session_id:session,...(mode.refusal?{error:'authentication_failed'}:{}),message:{...((mode.sdkPublicDiagnostics||mode.backgroundReadV2)&&!mode.sdkMissingGenerationId?{id:generationId}:{}),model:mode.wrongModel?'claude-sonnet-4-6':'claude-sonnet-5-5',usage:{input_tokens:mode.refusal?0:12,output_tokens:mode.refusal?0:4},content}};yield firstAssistant;if((mode.sdkPublicDiagnostics||mode.backgroundReadV2)&&toolTurn)yield firstAssistant;if(mode.sdkCapFourHandoff&&toolTurn)for(let step=2;step<=4;step++){const late={...content[0],id:(mode.sdkCapFourForwardLate&&step===2?'forwarded-':'dropped-')+data.actor+'-'+data.sequence+'-'+step};const id=generationId+'-'+step;yield{type:'stream_event',event:{type:'message_start',message:{id,model:'claude-sonnet-5-5'}}};if(!mode.sdkCapFourMissingDrop||step!==2)await input.options.hooks.PreToolUse[0].hooks[0]({tool_use_id:late.id,tool_name:late.name,tool_input:late.input},late.id,{});yield{type:'assistant',session_id:session,message:{id,sdkSyntheticLater:true,model:'claude-sonnet-5-5',usage:{input_tokens:12,output_tokens:4},content:[late]}}};if(toolTurn&&(mode.sdkLaterDeniedCall||mode.unknownSdkDeny||mode.falseSdkForwardedClaim||mode.leakedDroppedSdkCall)){const late={...content[0],id:'dropped-'+data.actor+'-'+data.sequence};await input.options.hooks.PreToolUse[0].hooks[0]({tool_use_id:late.id,tool_name:late.name,tool_input:late.input},late.id,{});yield{type:'assistant',session_id:session,message:{sdkSyntheticLater:true,model:'claude-sonnet-5-5',usage:{input_tokens:12,output_tokens:4},content:[late]}}}yield{type:'result',session_id:session,subtype:mode.refusal?'error_during_execution':toolTurn?'error_max_turns':'success',...(mode.missingErrorFlag?{}:{is_error:toolTurn&&mode.falseMaxTurnsFlag?false:toolTurn||!!mode.refusal}),num_turns:mode.sdkCapFourHandoff&&toolTurn?5:mode.sdkNativeTurnsTwo||mode.backgroundReadV2&&toolTurn?2:1,...(mode.backgroundReadV2&&toolTurn?{terminal_reason:'max_turns'}:{}),total_cost_usd:mode.overCost?20:0.001}}}}
`)
  writeFileSync(join(target, 'server.mjs'), `import assert from'node:assert/strict';import{createServer}from'node:http';import{readFileSync,writeFileSync,statSync}from'node:fs';import{spawn}from'node:child_process';import{once}from'node:events';import{query}from'@anthropic-ai/claude-agent-sdk';
const mode=JSON.parse(readFileSync(new URL('mode.json',import.meta.url),'utf8'));const sessions=new Map();let requests=0;const history=new Map();let previousTool;
assert(!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN&&!process.env.CLAUDE_CODE_OAUTH_TOKEN&&!process.env.MERIDIAN_PROFILES&&!process.env.MERIDIAN_TELEMETRY_DB&&!process.env.CLAUDE_PROXY_CONFIG_DIR&&!process.env.AWS_PROFILE);
export async function startProxyServer(config){
const account=config.profiles[0].claudeConfigDir,cred=JSON.parse(readFileSync(account+'/.credentials.json','utf8'));
assert(config.port===0&&config.host==='127.0.0.1'&&config.defaultProfile==='e72-owned'&&config.silent===false);assert(!cred.claudeAiOauth.refreshToken);assert((statSync(account+'/.credentials.json').mode&511)===256);assert(process.env.MERIDIAN_CREDENTIALS_READONLY==='1');assert(account!==process.env.CLAUDE_CONFIG_DIR);
writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify({account,work:process.env.MERIDIAN_WORKDIR,config:process.env.MERIDIAN_CONFIG_DIR,store:process.env.MERIDIAN_SESSION_DIR,plugins:config.pluginDir,home:process.env.HOME}));
if(mode.pendingStartup)await new Promise(()=>{});
if(mode.startupChild){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"],{cwd:process.env.MERIDIAN_WORKDIR,stdio:['ignore','pipe','ignore']});writeFileSync(new URL('startup-child-pid',import.meta.url),String(child.pid));await once(child.stdout,'data');throw new Error('synthetic startup failure after child readiness')}
const forwardedReason=${JSON.stringify(PASSTHROUGH_DENY_REASON)},dropReason='This tool call has already been handled by the client-facing turn — do not repeat it. Do not call additional tools and do not generate further text — end your turn now.';
const options={hooks:{PreToolUse:[{matcher:'',hooks:[async event=>({decision:'block',reason:event.tool_use_id.startsWith('dropped-')?(mode.unknownSdkDeny?'unqualified denial':mode.falseSdkForwardedClaim?forwardedReason:dropReason):mode.earlyDroppedSdkCall?dropReason:forwardedReason})]}]},model:mode.sdkAlias?'sonnet':'claude-sonnet-5-5',maxTurns:mode.sdkCapFourHandoff?4:1,env:{CLAUDE_CONFIG_DIR:account,...(mode.sdkAlias&&!mode.missingPin?{ANTHROPIC_DEFAULT_SONNET_MODEL:mode.wrongPin?'claude-sonnet-4-6':'claude-sonnet-5-5'}:{})},pathToClaudeCodeExecutable:process.env.MERIDIAN_CLAUDE_PATH,abortController:new AbortController()};if(mode.queryAtStartup)query({prompt:'{"tools":[]}',options});
const server=createServer(async(req,res)=>{try{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),actor=req.headers['x-claude-code-agent-id']??'main',sequence=(history.get(actor)??0)+1,prior=mode.backgroundForkParent&&actor!=='main'&&sequence===1?(mode.backgroundForeignParentFork?'other-owned-session':sessions.get('main')):sessions.get(actor);history.set(actor,sequence);requests++;const requestNumber=requests;
let tools=[];if(actor==='main'&&sequence===1&&!mode.missingAgentTool)tools=['alpha','beta'].map(label=>({type:'tool_use',id:'launch-'+label,name:'Agent',input:{subagent_type:'general-purpose',run_in_background:!!mode.background&&!mode.backgroundForegroundLaunch,prompt:'Run echo '+label+'-1 then echo '+label+'-2'}}));if(actor!=='main'&&sequence<=2)tools=[{type:'tool_use',id:actor+'-'+sequence,name:'Bash',input:{command:(mode.background&&sequence===1?'sleep 2 && ':'')+'echo '+actor+'-'+sequence+(mode.wrongBash?' changed':'')}}];
if(mode.background&&actor==='main'&&sequence===(mode.backgroundBatchedParentWork?1:2))tools.push({type:'tool_use',id:'parent-work',name:'Bash',input:{command:'echo parent-overlap'}});if(mode.background&&actor==='main'&&sequence===(mode.backgroundPreissuedWait?1:mode.backgroundBatchedParentWork?2:3))tools.push(...['alpha','beta'].map(label=>({type:'tool_use',id:'collect-'+label,name:mode.backgroundReadV2?'Read':'TaskOutput',input:mode.backgroundReadV2?{file_path:'/synthetic/'+(mode.swappedReadPath?(label==='alpha'?'beta':'alpha'):mode.sharedReadPath?'alpha':label)+'.output'}:{task_id:mode.unknownTaskOwner?'unknown':label,block:true,timeout:mode.unboundedTaskOutput?40000:30000}})));
if(mode.streamingStagger&&actor!=='main'){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders()}const target=(mode.forked||mode.backgroundForkParent&&actor!=='main'&&sequence===1&&!mode.backgroundDirectParentBorrow)?'f'+String(requestNumber).padStart(7,'0')+'-'+actor:undefined;let content=[];for await(const event of query({prompt:JSON.stringify({tools,actor,sequence}),options:{...options,...(!mode.baseline&&prior?{resume:mode.swappedFinalChain&&actor!=='main'&&sequence===3?sessions.get(actor==='alpha'?'beta':'alpha'):prior}:{}),...(target?{forkSession:!!prior,sessionId:target}:{})}})){if(event.session_id)sessions.set(actor,event.session_id);if(event.type==='assistant'){const next=event.message.content.map(tool=>tool.type==='tool_use'?({...tool,name:tool.name.replace(/^mcp__[^_]+__/,'')}):tool);if(event.message.sdkSyntheticLater){if(mode.leakedDroppedSdkCall)content.push(...next)}else content=next}}
if(mode.repeatHttpToolId&&actor==='beta'&&sequence===2&&previousTool)content.push(previousTool);const hasTools=content.some(block=>block.type==='tool_use');if(hasTools)previousTool=content[0];
const line='[PROXY] '+req.headers['x-request-id']+' adapter=claude-code msgCount='+body.messages.length+' tools='+(body.tools?.length??0)+' session='+(!mode.baseline&&prior?prior.slice(0,8):'new')+' lineage='+(!mode.baseline&&prior?'continuation':'diverged')+(mode.baseline?' diverged=unrelated-history':'')+(mode.missingWait?'':' sessionWait=0ms')+' private=synthetic-owner-secret';if(!mode.missingDecision||requestNumber!==2){console.log(line);if(mode.duplicateDecision&&requestNumber===2)console.log(line)}
if((content.length||mode.streamingStagger)&&mode.terminalSse){const events=[{type:'message_start',message:{type:'message',content:[]}}];for(const[index,tool]of content.entries())events.push({type:'content_block_start',index,content_block:tool.type==='tool_use'?{type:'tool_use',id:tool.id,name:tool.name,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index,delta:tool.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(tool.input)}:{type:'text_delta',text:tool.text}},...(mode.brokenTerminal?[]:[{type:'content_block_stop',index}]));events.push({type:'message_delta',delta:{stop_reason:hasTools?'tool_use':'end_turn'}},{type:'message_stop'});if(mode.missingStart)events.shift();if(mode.earlyStop)events.splice(2,0,{type:'message_stop'});if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+String.fromCharCode(10,10)).join(''))}
else{if(mode.brokenTerminal&&hasTools)content[0].input={changed:true};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'message',stop_reason:hasTools?'tool_use':'end_turn',content}))}
}catch{res.writeHead(500);res.end('{}')}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,close:()=>new Promise(resolve=>server.close(resolve))}
}
`)
  const client = join(target, 'client')
  writeFileSync(client, `#!/usr/bin/env node
import assert from'node:assert/strict';import{readFileSync,existsSync,writeFileSync}from'node:fs';
assert(!process.env.ANTHROPIC_API_KEY&&!process.env.CLAUDE_CODE_OAUTH_TOKEN&&!process.env.MERIDIAN_CONFIG_DIR&&!process.env.MERIDIAN_SESSION_DIR&&!process.env.CLAUDE_PROXY_CONFIG_DIR&&!process.env.AWS_PROFILE);
if(process.argv.includes('--version')){console.log('2.1.287 (Claude Code)');process.exit(0)}
assert(process.env.ANTHROPIC_AUTH_TOKEN==='meridian-e72-local-dummy');assert(process.argv.includes('default')&&process.argv.includes('Bash(echo:*)')&&process.argv.includes('Agent'));
const mode=JSON.parse(readFileSync(new URL('mode.json',import.meta.url),'utf8'));if(mode.hang){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);await new Promise(()=>{})}
const file=process.env.CLAUDE_CONFIG_DIR+'/turn.json',turn=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(turn));
const model=process.argv[process.argv.indexOf('--model')+1],session=process.argv[process.argv.indexOf(process.argv.includes('--resume')?'--resume':'--session-id')+1];
const preissuedActors=new Set();let headersReady;const firstHeaders=new Promise(resolve=>headersReady=resolve);async function send(actor,results=[]){if(mode.preissuedToolResult&&!preissuedActors.has(actor)){preissuedActors.add(actor);results=[...results,...(actor==='main'?['alpha','beta'].map(label=>({type:'tool_result',tool_use_id:'launch-'+label,is_error:false,content:label+'-1 '+label+'-2'})):[{type:'tool_result',tool_use_id:actor+'-1',is_error:false,content:actor+'-1'}])]}const body={model:mode.wireWrongModel?'claude-sonnet-4-6':model,metadata:{user_id:JSON.stringify({session_id:mode.wrongRoot?'different-root':session})},stream:false,messages:[{role:'user',content:[{type:'text',text:mode.oversizedBody?'x'.repeat(3*1024*1024):'synthetic-owned-content'},...(!mode.missingToolResult?results:[])]}],tools:[{name:'Agent'},{name:'Bash'},...(mode.backgroundReadV2?[{name:'Read'}]:mode.sdkPublicDiagnostics?[{name:'TaskOutput'},{name:'Read'}]:[])]};const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json',...(actor==='main'?{}:{'x-claude-code-agent-id':mode.swappedActor?'alpha':actor})},body:JSON.stringify(body)});if(actor==='alpha')headersReady();await response.text();assert(response.status===200)}
const result=(id,text)=>({type:'tool_result',tool_use_id:id,is_error:false,content:text});
if(turn===1&&mode.background){await send('main');const launchResults=['alpha','beta'].map(label=>result('launch-'+label,mode.missingBackgroundHandle?label+'-1 '+label+'-2':'agentId: '+(mode.swappedBackgroundHandle?(label==='alpha'?'beta':'alpha'):label)+(mode.backgroundReadV2&&!mode.missingReadPath?String.fromCharCode(10)+'output_file: /synthetic/'+(mode.sharedReadPath?'alpha':label)+'.output':'')));let childReady,ready=0;const bothReady=new Promise(resolve=>childReady=resolve);const child=async label=>{await send(label);await send(label,[result(label+'-1',label+'-1')]);if(++ready===2)childReady();await send(label,[result(label+'-2',label+'-2')])};let jobs=[];if(mode.parentAfterChildren){await Promise.all([child('alpha'),child('beta')]);await send('main',launchResults)}else{jobs=[child('alpha'),child('beta')];await send('main',[...launchResults,...(mode.backgroundBatchedParentWork?[result('parent-work','parent-overlap')]:[])]);if(mode.earlyBackgroundCompletion)await bothReady;else await Promise.all(jobs)}if(!mode.backgroundBatchedParentWork)await send('main',[result('parent-work','parent-overlap')]);await send('main',['alpha','beta'].filter(label=>!mode.missingBackgroundCompletion||label!=='alpha').map(label=>result('collect-'+label,mode.backgroundReadV2?'1'+String.fromCharCode(9)+(mode.readPromptOnly?'Run echo '+label+'-1 then echo '+label+'-2':mode.readForeignFinal?(label==='alpha'?'beta':'alpha')+'-1 '+(label==='alpha'?'beta':'alpha')+'-2':mode.readPartial?label+'-1':label+'-1 '+label+'-2'):label+'-1 '+label+'-2')));await Promise.all(jobs)}else if(turn===1){await send('main');const child=async label=>{await send(label);await send(label,[result(label+'-1',label+'-1')]);await send(label,[result(label+'-2',label+'-2')])};if(!mode.missingAgent){if(mode.noParallel){await child('alpha');await child('beta')}else if(mode.streamingStagger){const first=child('alpha');await firstHeaders;await Promise.all([first,child('beta')])}else await Promise.all([child('alpha'),child('beta')])}await send('main',[result('launch-alpha','alpha-1 alpha-2'),result('launch-beta','beta-1 beta-2')])}else{await send('main');if(mode.requestOverflow)for(let i=0;i<21;i++)await send('main')}console.log((turn===1?'DONE':'AGAIN')+' synthetic-owner-secret');
`)
  chmodSync(client, 0o700)
  const native = join(target, 'native')
  writeFileSync(native, '#!/usr/bin/env node\nconsole.log("2.1.284 (Claude Code)")\n'); chmodSync(native, 0o700)
  const grant = join(root, 'owned-grant.json')
  const bytes = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-owner-secret', refreshToken: 'synthetic-refresh-never-used', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] } })
  writeFileSync(grant, bytes, { mode: 0o400 })
  return { root, target, sdk, client, native, proof, grant, bytes }
}
function commandFor(f: ReturnType<typeof fixture>, extras: string[] = [], timeout = '10000') {
  return [process.execPath, harness, '--synthetic', '--target-root', f.target, '--entry', 'server.mjs', '--client', f.client, '--client-version', '2.1.287', '--native-cli', f.native, '--native-cli-version', '2.1.284', '--sdk-version', '0.2.141', '--model', 'claude-sonnet-5-5', '--served-model', 'claude-sonnet-5-5', '--grant-file', f.grant, '--proof-dir', f.proof, '--max-queries', '20', '--max-cost-usd', '10', '--timeout-ms', timeout, ...extras]
}
let escrowSequence = 0
type GrantKind = 'symlink' | 'directory' | 'hardlink' | 'writable' | 'regular'
async function grantSnapshotControl(kind: GrantKind) {
  const f = fixture(), selected = join(f.root, 'selected-grant'), marker = join(f.root, 'grant-read-observed.json'), preload = join(f.root, 'observe-grant-reads.mjs')
  let joined = false
  try {
    if (kind === 'symlink') symlinkSync(f.grant, selected)
    else if (kind === 'directory') mkdirSync(selected, { mode: 0o700 })
    else if (kind === 'hardlink') linkSync(f.grant, selected)
    else writeFileSync(selected, f.bytes, { mode: kind === 'writable' ? 0o600 : 0o400 })
    // This preload observes the actual harness, not an extracted reimplementation.
    // All grants, targets and dependencies are marked synthetic. Any network call
    // is recorded and refused before dispatch, including an unexpected auth probe.
    writeFileSync(preload, `import * as fs from 'node:fs';import {spyOn} from 'bun:test';
const selected=${JSON.stringify(selected)},marker=${JSON.stringify(marker)},read=fs.readFileSync,open=fs.openSync,close=fs.closeSync,write=fs.writeFileSync,tracked=new Set(),observed={contentReadAttempts:0,selectedOpenFlags:[],networkAttempts:0};
spyOn(fs,'openSync').mockImplementation((file,...args)=>{if(file===selected)observed.selectedOpenFlags.push(args[0]);const fd=open(file,...args);if(file===selected)tracked.add(fd);return fd});
spyOn(fs,'closeSync').mockImplementation(fd=>{tracked.delete(fd);return close(fd)});
spyOn(fs,'readFileSync').mockImplementation((file,...args)=>{if(file===selected||tracked.has(file))observed.contentReadAttempts++;return read(file,...args)});
globalThis.fetch=()=>{observed.networkAttempts++;throw new Error('Synthetic snapshot control fenced external requests')};
process.once('exit',()=>write(marker,JSON.stringify(observed),{mode:0o600,flag:'wx'}));
`, { mode: 0o600 })
    const command = commandFor(f, ['--rehearsal']); command[command.indexOf('--grant-file') + 1] = selected
    const home = join(f.root, 'empty-child-home'); mkdirSync(home, { mode: 0o700 })
    const child = spawn(command[0]!, ['--preload', preload, ...command.slice(1)], { cwd: f.target, detached: true, env: { PATH: process.env.PATH, HOME: home, TMPDIR: f.root }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]] as const) stream?.on('data', bytes => {
      if (name === 'out') out += bytes.toString(); else err += bytes.toString()
      if (Buffer.byteLength(out) + Buffer.byteLength(err) > 2 * 1024 * 1024 && child.pid) process.kill(-child.pid, 'SIGKILL')
    })
    const completion = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', code => { joined = true; resolveExit(code) })
    })
    async function waitForClose(milliseconds: number) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic snapshot control child did not join')), milliseconds) })]) }
      finally { clearTimeout(timer) }
    }
    let code: number | null
    try { code = await waitForClose(20000) }
    finally {
      if (!joined && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
        await waitForClose(5000)
      }
    }
    const observed = JSON.parse(readFileSync(marker, 'utf8')) as { contentReadAttempts: number; selectedOpenFlags: number[]; networkAttempts: number }
    const report = JSON.parse(readFileSync(join(f.proof, 'claude-subagent-results.json'), 'utf8')) as { result: string; acceptance: boolean; queries: unknown[]; cleanupFailures: string[]; privateRuntimeRemoved: boolean; privateSnapshotCreated?: boolean }
    const record = { kind, code, joined, ...observed, sdkInvoked: existsSync(join(f.target, 'query-called')), result: report.result, acceptance: report.acceptance, queryCount: report.queries.length, cleanupFailures: report.cleanupFailures, privateRuntimeRemoved: report.privateRuntimeRemoved, privateSnapshotCreated: report.privateSnapshotCreated ?? false }
    const escrow = process.env.E72_SNAPSHOT_ESCROW_DIR
    if (escrow) writeFileSync(join(escrow, `${kind}.json`), JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
    expect(out + err).not.toContain('synthetic-owner-secret')
    expect(out + err).not.toContain('synthetic-refresh-never-used')
    expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes)
    expect(record.joined).toBe(true); expect(record.networkAttempts).toBe(0); expect(record.sdkInvoked).toBe(false)
    expect(record.acceptance).toBe(false); expect(record.queryCount).toBe(0); expect(record.cleanupFailures).toEqual([]); expect(record.privateRuntimeRemoved).toBe(true)
    return record
  } finally {
    // Remove synthetic inputs only after observing the child close, or after a
    // failed spawn with no process handle. A join failure leaves evidence intact.
    if (joined) rmSync(f.root, { recursive: true, force: true })
  }
}
async function run(mode: Mode = {}, extras: string[] = [], timeout = '10000') {
  const f = fixture(mode)
  let retainedSyntheticRuntime: string | undefined
  try {
    const command = commandFor(f, extras, timeout)
    const signalRefusalMarker = join(f.root, 'signal-refusal-injected')
    if (mode.sdkCloseSignalFailure) {
      const preload = join(f.root, 'owned-signal-failure.mjs')
      writeFileSync(preload, `import * as cp from 'node:child_process';import {spyOn} from 'bun:test';import {writeFileSync} from 'node:fs';
const client=${JSON.stringify(realpathSync(f.client))},spawn=cp.spawn,kill=process.kill.bind(process),groups=new Set();let injected=false;
spyOn(cp,'spawn').mockImplementation((file,args,options)=>{const child=spawn(file,args,options);if(file===client&&!args.includes('--version'))child.once('spawn',()=>groups.add(-child.pid));return child});
spyOn(process,'kill').mockImplementation((pid,signal)=>{if(groups.has(pid)&&signal==='SIGTERM'&&!injected){injected=true;writeFileSync(${JSON.stringify(signalRefusalMarker)},'owned synthetic refusal entered');throw Object.assign(new Error('Owned synthetic signal refusal'),{code:'EPERM'})}return kill(pid,signal)});
`, { mode: 0o600 })
      command.splice(1, 0, '--preload', preload)
    }
    const child = Bun.spawn(command, { cwd: f.target, env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-ambient', ANTHROPIC_AUTH_TOKEN: 'synthetic-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-ambient', MERIDIAN_PROFILES: 'synthetic-ambient', MERIDIAN_TELEMETRY_DB: '/synthetic-no-write', CLAUDE_PROXY_CONFIG_DIR: '/synthetic-no-read', AWS_PROFILE: 'synthetic-ambient' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const serialized = readFileSync(join(f.proof, 'claude-subagent-results.json'), 'utf8')
    const escrow = process.env.E72_ESCROW_SYNTHETIC_DIR
    // Retain the joined child's original output before decoding its report.
    // A malformed/empty report must remain a failure with its exit and cause.
    if (escrow) writeFileSync(join(escrow, `control-${++escrowSequence}.json`), JSON.stringify({ mode, extras, timeout, out, err, code, serialized }, null, 2), { flag: 'wx', mode: 0o600 })
    let decoded: unknown
    try { decoded = JSON.parse(serialized) }
    catch (cause) { throw new Error(`Synthetic harness returned invalid JSON (${serialized.length} chars, exit ${code}); stdout=${out}; stderr=${err}`, { cause }) }
    const report = decoded as { result: string; acceptance: boolean; privateSnapshotCreated?: boolean; privateRuntimeRemoved: boolean; ownerGrantUnchanged: boolean; queries: unknown[]; checks: Record<string, boolean>; cleanupFailures: string[]; ownedResidualProcesses: number; clientProcesses: Array<{ spawned: boolean; spawnError: boolean; exit: boolean; close: boolean; stdoutEnd: boolean; stdoutClose: boolean; stderrEnd: boolean; stderrClose: boolean; signalAttempts: number; signalFailures: number; join: string }>; targetIdentityUnchanged?: boolean; failure?: string; backgroundReceiptFacts?: Record<string, number | boolean>; backgroundReadFacts?: { ownedLaunchPaths: number; uniqueLaunchPathsAndHandles: boolean; reads: number; ownedReads: number; readsAfterLaunch: number; childCompleteBeforeRead: number; matchedFinalReports: number; completedReads: number; formats: string[] } }
    if (report.privateRuntimeRemoved === false && existsSync(join(f.target, 'audit.json'))) {
      const audit = JSON.parse(readFileSync(join(f.target, 'audit.json'), 'utf8')) as Record<string, string>
      const candidate = typeof audit.account === 'string' ? dirname(audit.account) : undefined
      if (candidate && report.ownedResidualProcesses === 0 && report.clientProcesses.every(owned => owned.join === 'JOINED') && basename(candidate).startsWith('meridian-e72-') && Object.values(audit).every(directory => dirname(directory) === candidate)) {
        retainedSyntheticRuntime = candidate
      }
    }
    expect(serialized + out + err).not.toContain('synthetic-owner-secret')
    expect(serialized + out + err).not.toContain('synthetic-refresh-never-used')
    if (mode.pendingStartup) expect(existsSync(join(f.target, 'audit.json'))).toBe(true)
    if (mode.sdkCloseSignalFailure) expect(existsSync(signalRefusalMarker), 'original generation-group refusal must actually be injected').toBe(true)
    expect(report.acceptance).toBe(false)
    expect(report.ownerGrantUnchanged).toBe(true)
    for (const owned of report.clientProcesses) {
      expect(owned.join, JSON.stringify(owned)).toBe('JOINED')
      if (mode.sdkCloseThrow && owned.signalFailures > 0) {
        // This explicitly failing cleanup control must retain the real signal
        // failure and closed acceptance, rather than demand fault-free cleanup.
        expect(report.result).toBe('FAIL')
        expect(report.cleanupFailures).toContain('client signal')
        expect(report.privateRuntimeRemoved).toBe(false)
      } else expect(owned.signalFailures, JSON.stringify(owned)).toBe(0)
      expect(owned.exit && owned.close && owned.stdoutEnd && owned.stdoutClose && owned.stderrEnd && owned.stderrClose).toBe(true)
    }
    const retained = !!mode.pendingStartup || !!mode.sdkCloseThrow
    expect(report.privateRuntimeRemoved).toBe(!retained)
    if (mode.pendingStartup) {
      expect(report.cleanupFailures).toContain('proxy startup join')
      expect(report.cleanupFailures).toContain('private runtime retained after cleanup failure')
    } else if (mode.sdkCloseThrow) expect(report.cleanupFailures).toContain('SDK abort failure')
    else expect(report.cleanupFailures).toEqual([])
    expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes)
    expect(statSync(f.grant).mode & 0o777).toBe(0o400)
    if (existsSync(join(f.target, 'audit.json'))) {
      const audit = JSON.parse(readFileSync(join(f.target, 'audit.json'), 'utf8')) as Record<string, string>
      expect(new Set(Object.values(audit)).size).toBe(Object.values(audit).length)
      for (const directory of Object.values(audit)) expect(existsSync(directory)).toBe(retained)
      if (retained) {
        const account = audit.account
        if (typeof account !== 'string' || account.length === 0) throw new Error('Synthetic retained-runtime audit lacks an account directory')
        const candidate = dirname(account)
        expect(basename(candidate).startsWith('meridian-e72-')).toBe(true)
        expect(Object.values(audit).every(directory => dirname(directory) === candidate)).toBe(true)
        retainedSyntheticRuntime = candidate
      }
    }
    if (existsSync(join(f.target, 'startup-child-pid'))) {
      const pid = Number(readFileSync(join(f.target, 'startup-child-pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }
    return { report, code, queried: existsSync(join(f.target, 'query-called')) }
  } finally {
    // The original harness process and its pipes have terminated. Every
    // externally spawned handle joined and its owned census is empty before
    // this independent controller removes the exact synthetic runtime. A
    // reported unsettled in-process iterator cannot outlive that process.
    // The harness's failure and retention receipts remain unchanged.
    if (retainedSyntheticRuntime) rmSync(retainedSyntheticRuntime, { recursive: true, force: true })
    rmSync(f.root, { recursive: true, force: true })
  }
}

describe('E72 native harness containment and meaningful subagent receipts', () => {
  it('pairs the qualified cap-four handoff and dropped generations without increasing any query cap', async () => {
    const result = await run({ background: true, backgroundReadV2: true, sdkCapFourHandoff: true }, ['--scenario', 'background-read-v2'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.result).toBe('PASS')
    expect(result.report.queries).toContainEqual(expect.objectContaining({ maxTurns: 4, nativeTurns: 5, originalCanonicalResult: false, acceptedCanonicalResult: true, explicitlyDroppedSdkToolCount: 3, generations: expect.objectContaining({ distinctGenerations: 4 }) }))
    expect(result.report.backgroundReadFacts?.completedReads).toBe(2)
  }, 30000)
  for (const fault of ['sdkCapFourMissingDrop', 'sdkCapFourForwardLate', 'sdkExtraGeneration', 'sdkMissingGenerationId'] as const) {
    it(`rejects the cap-four Read proof with ${fault}`, async () => {
      const result = await run({ background: true, backgroundReadV2: true, sdkCapFourHandoff: true, [fault]: true }, ['--scenario', 'background-read-v2'])
      expect(result.code, JSON.stringify(result.report)).toBe(1)
      expect(result.report.result).toBe('FAIL')
      expect(result.report.checks.nativeReceipts).toBe(false)
    }, 30000)
  }
  it('pairs completed background Read reports with their owned launch paths and native generation budgets', async () => {
    const result = await run({ background: true, backgroundReadV2: true }, ['--scenario', 'background-read-v2'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.result).toBe('PASS')
    expect(Object.values(result.report.checks).every(Boolean)).toBe(true)
    expect(result.report.backgroundReadFacts).toEqual({ ownedLaunchPaths: 2, uniqueLaunchPathsAndHandles: true, reads: 2, ownedReads: 2, readsAfterLaunch: 2, childCompleteBeforeRead: 2, matchedFinalReports: 2, completedReads: 2, formats: ['numbered-final-text', 'numbered-final-text'] })
    expect(result.report.queries).toContainEqual(expect.objectContaining({ originalCanonicalResult: false, acceptedCanonicalResult: true, nativeTurns: 2, terminalReason: 'max_turns' }))
  }, 30000)
  it('retains MCP Read alias and owned-parent fork custody in the versioned scenario', async () => {
    const result = await run({ background: true, backgroundReadV2: true, backgroundForkParent: true, sdkPrefixed: true }, ['--scenario', 'background-read-v2'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.checks.nativeReceipts).toBe(true)
    expect(result.report.backgroundReadFacts?.completedReads).toBe(2)
  }, 30000)
  for (const fault of ['preissuedToolResult', 'wrongBash', 'duplicateToolId', 'missingDecision', 'missingSdkHook', 'changedSdkHookInput', 'backgroundDirectParentBorrow', 'backgroundForeignParentFork', 'parentAfterChildren', 'wrongSdkNamespace'] as const) {
    it(`retains background Read rejection for ${fault}`, async () => {
      const result = await run({ background: true, backgroundReadV2: true, backgroundForkParent: fault.startsWith('background'), [fault]: true }, ['--scenario', 'background-read-v2'])
      expect(result.code, JSON.stringify(result.report)).toBe(1)
      expect(result.report.result).toBe('FAIL')
      expect(Object.values(result.report.checks).every(Boolean)).toBe(false)
    }, 30000)
  }
  for (const fault of ['missingReadPath', 'swappedReadPath', 'sharedReadPath', 'readPromptOnly', 'readForeignFinal', 'readPartial', 'earlyBackgroundCompletion', 'sdkExtraGeneration', 'sdkMissingGenerationId'] as const) {
    it(`rejects background Read proof with ${fault}`, async () => {
      const result = await run({ background: true, backgroundReadV2: true, [fault]: true }, ['--scenario', 'background-read-v2'])
      expect(result.code, JSON.stringify(result.report)).toBe(1)
      expect(result.report.result).toBe('FAIL')
      expect(Object.values(result.report.checks).every(Boolean)).toBe(false)
      if (fault.startsWith('sdk')) expect(result.report.checks.nativeReceipts).toBe(false)
      else expect(result.report.checks.actualAgentAndBashReceipts).toBe(false)
    }, 30000)
  }

  for (const kind of ['symlink', 'directory', 'hardlink', 'writable'] as const) {
    it(`rejects a ${kind} grant before any content read, auth request or SDK call`, async () => {
      const record = await grantSnapshotControl(kind)
      expect(record.code).toBe(1); expect(record.contentReadAttempts).toBe(0); expect(record.privateSnapshotCreated).toBe(false)
    }, 30000)
  }
  it('reads a private regular grant through no-follow nonblocking descriptors', async () => {
    const record = await grantSnapshotControl('regular')
    expect(record.code).toBe(0); expect(record.result).toBe('REHEARSAL'); expect(record.privateSnapshotCreated).toBe(true)
    expect(record.contentReadAttempts).toBe(2); expect(record.selectedOpenFlags.length).toBe(2)
    for (const flags of record.selectedOpenFlags) expect(flags).toBe(fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  }, 30000)
  it('reserves exclusive proof output before reading a grant or invoking SDK', async () => {
    for (const kind of ['symlink', 'hardlink', 'regular']) {
      const f = fixture(), resultFile = join(f.proof, 'claude-subagent-results.json'), target = kind === 'regular' ? resultFile : join(f.root, 'unrelated-owner-file')
      const bytes = 'synthetic existing output owner bytes\n'
      try {
        writeFileSync(target, bytes, { mode: 0o600 })
        if (kind === 'symlink') symlinkSync(target, resultFile)
        if (kind === 'hardlink') linkSync(target, resultFile)
        const before = statSync(target), child = Bun.spawn(commandFor(f), { cwd: f.target, stdout: 'pipe', stderr: 'pipe' })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect(code).toBe(1); expect(readFileSync(target, 'utf8')).toBe(bytes); expect(statSync(target).ino).toBe(before.ino); expect(statSync(target).nlink).toBe(before.nlink)
        expect(existsSync(join(f.target, 'query-called'))).toBe(false); expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes); expect(out + err).not.toContain('synthetic-owner-secret')
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
  }, 30000)
  it('pairs two observed parallel foreground agents with exact Agent/Bash SDK, HTTP and result receipts', async () => {
    const result = await run(); expect(result.code, JSON.stringify(result.report)).toBe(0); expect(result.report.result).toBe('PASS'); expect(result.report.queries.length).toBe(9); expect(Object.values(result.report.checks).every(Boolean)).toBe(true)
  }, 30000)
  it('joins every successful native-client fixture without post-exit signal authority', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.report.clientProcesses).toHaveLength(4)
    for (const owned of result.report.clientProcesses) expect(owned.signalAttempts).toBe(0)
  }, 30000)
  it('escrows public capabilities and distinct generations without counting stream or assistant fragments as turns', async () => {
    const result = await run({ sdkPublicDiagnostics: true })
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    for (const query of result.report.queries) expect(query).toMatchObject({
      generations: { distinctGenerations: 1, completeGenerationIds: true, streamStarts: 1, missingGenerationIds: 0, uncorrelatedHooks: 0 },
      nativeInitToolCapabilities: [{ catalogPresent: true, catalogValid: true, taskOutput: false, read: true, clientMcpTaskOutput: true }],
      iteratorSettled: true,
    })
    expect(result.report.queries).toContainEqual(expect.objectContaining({ generations: expect.objectContaining({ assistantEvents: 2, generations: [expect.objectContaining({ distinctTools: 2, forwardedHooks: 2 })] }) }))
    expect(JSON.stringify(result.report)).not.toContain('private-generation-')
    const diagnostic = result.report as typeof result.report & { wire: Array<{ clientToolCapabilities: { taskOutput: boolean; read: boolean } }>; queryLifecycle: Array<{ priorRequest: number | null; priorIteratorOverlapMs: number | null }> }
    expect(diagnostic.wire.every(row => row.clientToolCapabilities.taskOutput && row.clientToolCapabilities.read)).toBe(true)
    expect(diagnostic.queryLifecycle).toHaveLength(9)
    expect(diagnostic.queryLifecycle.some(row => row.priorRequest !== null && row.priorIteratorOverlapMs === 0)).toBe(true)
  }, 30000)
  it('keeps the canonical max-turn gate failed despite a complete one-generation diagnostic', async () => {
    const result = await run({ sdkPublicDiagnostics: true, sdkNativeTurnsTwo: true })
    expect(result.code).toBe(1)
    expect(result.report.checks.nativeReceipts).toBe(false)
    expect(result.report.checks.allQueriesCorrelated).toBe(true)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(true)
    expect(result.report.queries).toContainEqual(expect.objectContaining({ nativeTurns: 2, acceptedCanonicalResult: false, generations: expect.objectContaining({ distinctGenerations: 1, completeGenerationIds: true }) }))
  }, 30000)
  it('requires background launch handles, parent overlap and completed task receipts on the original child chains', async () => {
    const result = await run({ background: true, sdkPrefixed: true }, ['--scenario', 'background'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.queries).toHaveLength(11)
    expect(result.report.checks.backgroundParallelism).toBe(true)
    expect(result.report.checks.backgroundParentChildOverlap).toBe(true)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(true)
    expect(result.report.checks.allQueriesCorrelated).toBe(true)
    expect(result.report.acceptance).toBe(false)
  }, 30000)
  it('collects handles received by the same query after batching parent work with background launches', async () => {
    const result = await run({ background: true, backgroundBatchedParentWork: true }, ['--scenario', 'background'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.queries).toHaveLength(10)
    expect(result.report.checks.backgroundParentChildOverlap).toBe(true)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(true)
    expect(result.report.backgroundReceiptFacts).toEqual({ launches: 2, ownedLaunchHandles: 2, taskOutputs: 2,
      matchedTaskHandles: 2, boundedTaskWaits: 2, tasksAfterLaunch: 2, childBodiesCompleteBeforeTaskResults: 2,
      parentWorked: true, childBashReceipts: true, forwardedReceipts: 9 })
  }, 30000)
  it('rejects a background wait issued before launch handles are returned even after both children finish', async () => {
    const result = await run({ background: true, backgroundBatchedParentWork: true, backgroundPreissuedWait: true }, ['--scenario', 'background'])
    expect(result.code).toBe(1)
    expect(result.report.checks.nativeReceipts).toBe(true)
    expect(result.report.checks.allQueriesCorrelated).toBe(true)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(false)
    expect(result.report.backgroundReceiptFacts?.matchedTaskHandles).toBe(2)
    expect(result.report.backgroundReceiptFacts?.tasksAfterLaunch).toBe(0)
    expect(result.report.backgroundReceiptFacts?.childBodiesCompleteBeforeTaskResults).toBe(2)
  }, 30000)
  it('accepts an initial background fork of an earlier parent checkpoint and retains each own resumed chain', async () => {
    const result = await run({ background: true, backgroundForkParent: true }, ['--scenario', 'background'])
    expect(result.code, JSON.stringify(result.report)).toBe(0)
    expect(result.report.checks.allQueriesCorrelated).toBe(true)
    expect(result.report.checks.distinctSessionMappings).toBe(true)
    expect(result.report.checks.subagentResume).toBe(true)
    expect(result.report.checks.mainResume).toBe(true)
  }, 30000)
  it('rejects a direct parent borrow or a fork of an unowned checkpoint', async () => {
    for (const mode of [{ backgroundDirectParentBorrow: true }, { backgroundForeignParentFork: true }]) {
      const result = await run({ background: true, backgroundForkParent: true, ...mode }, ['--scenario', 'background'])
      expect(result.code).toBe(1)
      expect(result.report.checks.allQueriesCorrelated).toBe(true)
      expect(result.report.checks.distinctSessionMappings).toBe(false)
      expect(result.report.checks.nativeReceipts).toBe(true)
    }
  }, 30000)
  it('rejects foreground prose and borrowed or missing background handles despite completed child answers', async () => {
    for (const mode of [{ backgroundForegroundLaunch: true }, { missingBackgroundHandle: true }, { swappedBackgroundHandle: true }]) {
      const result = await run({ background: true, ...mode }, ['--scenario', 'background'])
      expect(result.code).toBe(1)
      expect(result.report.checks.actualAgentAndBashReceipts).toBe(false)
    }
  }, 30000)
  // Each fixture has its own 10s execution bound plus joined cleanup. Four
  // serial fixtures cannot share one 30s deadline under permitted delays.
  const backgroundTaskControls: Array<{ label: string; mode: Mode }> = [
    { label: 'unknown task owners', mode: { unknownTaskOwner: true } },
    { label: 'unbounded waits', mode: { unboundedTaskOutput: true } },
    { label: 'missing task completion', mode: { missingBackgroundCompletion: true } },
    { label: 'early task completion', mode: { earlyBackgroundCompletion: true } },
  ]
  for (const { label, mode } of backgroundTaskControls) it('rejects background ' + label, async () => {
    const result = await run({ background: true, ...mode }, ['--scenario', 'background'])
    expect(result.code).toBe(1)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(false)
    expect(result.report.checks.invocationsSucceeded).toBe(true)
    expect(result.report.checks.allQueriesCorrelated).toBe(true)
    expect(result.report.checks.nativeReceipts).toBe(true)
  }, 30000)
  it('requires real parent-child response-body overlap rather than two children running alone', async () => {
    const result = await run({ background: true, parentAfterChildren: true }, ['--scenario', 'background'])
    expect(result.code).toBe(1)
    expect(result.report.checks.backgroundParallelism).toBe(true)
    expect(result.report.checks.backgroundParentChildOverlap).toBe(false)
    expect(result.report.checks.actualAgentAndBashReceipts).toBe(true)
  }, 30000)
  it('pairs the exact supported SDK MCP namespace and rejects another namespace or tool name', async () => {
    const valid = await run({ sdkPrefixed: true }); expect(valid.code, JSON.stringify(valid.report)).toBe(0)
    const namespace = await run({ wrongSdkNamespace: true }); expect(namespace.code).toBe(1); expect(namespace.report.checks.nativeReceipts).toBe(false)
    const name = await run({ wrongSdkName: true }); expect(name.code).toBe(1); expect(name.report.checks.actualAgentAndBashReceipts).toBe(false)
  }, 30000)
  it('owns each forwarded call while retaining later SDK calls explicitly denied by the original hook', async () => {
    for (const terminalSse of [false, true]) {
      const result = await run({ sdkLaterDeniedCall: true, sdkPrefixed: true, terminalSse })
      expect(result.code, JSON.stringify(result.report)).toBe(0)
      expect(result.report.checks.sdkToolHookCustody).toBe(true)
      expect(result.report.checks.allQueriesCorrelated).toBe(true)
      expect(result.report.checks.actualAgentAndBashReceipts).toBe(true)
      expect(result.report.checks.nativeReceipts).toBe(true)
      expect(result.report.queries.some(row => typeof row === 'object' && row !== null && 'explicitlyDroppedSdkToolCount' in row && row.explicitlyDroppedSdkToolCount === 1)).toBe(true)
    }
  }, 30000)
  it('rejects missing or changed hook witnesses, unknown denials and false forwarding claims', async () => {
    for (const mode of [{ missingSdkHook: true }, { changedSdkHookInput: true }, { unknownSdkDeny: true }, { falseSdkForwardedClaim: true }]) {
      const result = await run(mode)
      expect(result.code).toBe(1)
      expect(result.report.checks.sdkToolHookCustody && result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('rejects a dropped call exposed to the client or claimed before any forwarded checkpoint', async () => {
    for (const mode of [{ leakedDroppedSdkCall: true }, { earlyDroppedSdkCall: true }]) {
      const result = await run(mode)
      expect(result.code).toBe(1)
      expect(result.report.checks.sdkToolHookCustody).toBe(false)
    }
  }, 30000)
  it('measures streamed child body overlap after staggered headers and rejects serial children', async () => {
    const parallel = await run({ terminalSse: true, streamingStagger: true }); expect(parallel.code, JSON.stringify(parallel.report)).toBe(0); expect(parallel.report.checks.foregroundParallelism).toBe(true)
    const serial = await run({ terminalSse: true, noParallel: true }); expect(serial.code).toBe(1); expect(serial.report.checks.foregroundParallelism).toBe(false)
  }, 30000)
  it('accepts managed fork identities whose resume chain stays with each own actor', async () => {
    const result = await run({ forked: true }); expect(result.code, JSON.stringify(result.report)).toBe(0); expect(result.report.checks.distinctSessionMappings).toBe(true)
  }, 30000)
  it('owns every tool-less final/resumed query and rejects equal-count swapped resume chains or ambiguous output', async () => {
    for (const mode of [{ swappedFinalChain: true }, { ambiguousText: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.queries.length).toBe(9); expect(result.report.checks.allQueriesCorrelated && result.report.checks.distinctSessionMappings).toBe(false)
    }
  }, 30000)
  it('requires the same meaningful baseline defects and rejects a fixed expected-unfixed target', async () => {
    const baseline = await run({ baseline: true }); expect(baseline.code).toBe(1); expect(baseline.report.checks.subagentResume).toBe(false); expect(baseline.report.checks.distinctSessionMappings).toBe(false)
    const expected = await run({ baseline: true }, ['--expect-unfixed']); expect(expected.code, JSON.stringify(expected.report)).toBe(0); expect(expected.report.result).toBe('EXPECTED_BASELINE_FAILURE')
    const wrong = await run({}, ['--expect-unfixed']); expect(wrong.code).toBe(1)
  }, 30000)
  it('refuses a client that answers successfully without real multi-turn Agent tool use and parallel wire traffic', async () => {
    for (const mode of [{ missingAgent: true }, { missingAgentTool: true }, { noParallel: true }]) {
      const result = await run(mode); expect(result.code).toBe(1)
      expect(result.report.checks.twoMultiturnAgents && result.report.checks.actualAgentAndBashReceipts && result.report.checks.foregroundParallelism).toBe(false)
    }
  }, 30000)
  it('requires complete one-to-one routing receipts and explicit finite lease waits', async () => {
    for (const mode of [{ missingDecision: true }, { duplicateDecision: true }, { missingWait: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.requestDecisionsComplete && result.report.checks.boundedLeaseWait).toBe(false)
    }
  }, 30000)
  it('rejects borrowed root identities and shared agent wire identities', async () => {
    const root = await run({ wrongRoot: true }); expect(root.code).toBe(1); expect(root.report.checks.rootedWireIdentity).toBe(false)
    const actors = await run({ swappedActor: true }); expect(actors.code).toBe(1); expect(actors.report.checks.twoMultiturnAgents).toBe(false)
  }, 30000)
  it('rejects tool claims without exact commands, returned execution results or paired terminals', async () => {
    for (const mode of [{ wrongBash: true }, { missingToolResult: true }, { brokenTerminal: true }, { preissuedToolResult: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.actualAgentAndBashReceipts).toBe(false)
    }
  }, 30000)
  it('rejects tool IDs reused across SDK owners or repeated HTTP terminals', async () => {
    for (const mode of [{ duplicateToolId: true }, { repeatHttpToolId: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('accepts only an exact full SDK model or a Sonnet tier alias with the explicit version pin', async () => {
    const valid = await run({ sdkAlias: true }); expect(valid.code, JSON.stringify(valid.report)).toBe(0)
    for (const mode of [{ sdkAlias: true, missingPin: true }, { sdkAlias: true, wrongPin: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
    const wire = await run({ wireWrongModel: true }); expect(wire.code).toBe(1); expect(wire.report.checks.requestedModelIdentity).toBe(false)
  }, 30000)
  it('requires exact served model, positive real usage and canonical boolean result flags', async () => {
    for (const mode of [{ wrongModel: true }, { refusal: true }, { missingErrorFlag: true }, { falseMaxTurnsFlag: true }]) {
      const result = await run(mode); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('accepts complete ordered SSE receipts and rejects partial or early terminals', async () => {
    const good = await run({ terminalSse: true }); expect(good.code, JSON.stringify(good.report)).toBe(0)
    for (const mode of [{ brokenTerminal: true }, { missingStart: true }, { earlyStop: true }]) {
      const result = await run({ terminalSse: true, ...mode }); expect(result.code).toBe(1); expect(result.report.checks.nativeReceipts).toBe(false)
    }
  }, 30000)
  it('enforces cost, request count and incoming body limits independently of client claims', async () => {
    const cost = await run({ overCost: true }); expect(cost.code).toBe(1); expect(cost.report.checks.costBound).toBe(false)
    const requests = await run({ requestOverflow: true }); expect(requests.code).toBe(1); expect(requests.report.queries.length).toBeLessThanOrEqual(20)
    const body = await run({ oversizedBody: true }); expect(body.code).toBe(1); expect(body.report.queries).toEqual([])
  }, 30000)
  it('zero-query rehearsal starts and closes the private proxy without starting client generation', async () => {
    const result = await run({}, ['--rehearsal']); expect(result.code).toBe(0); expect(result.report.result).toBe('REHEARSAL'); expect(result.report.queries).toEqual([]); expect(result.queried).toBe(false)
  }, 30000)
  it('rehearsal fences unexpected target startup SDK calls before invoking the fake dependency', async () => {
    const result = await run({ queryAtStartup: true }, ['--rehearsal']); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
  }, 30000)
  it('cleans private immutable account after a post-copy failure without generation', async () => {
    const result = await run({}, ['--fail-after-copy']); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.privateSnapshotCreated).toBe(true); expect(result.report.queries).toEqual([])
  }, 30000)
  it('joins hanging clients and ignored-TERM startup children on owned failure paths', async () => {
    const hung = await run({ hang: true }, [], '500'); expect(hung.code).toBe(1); expect(hung.queried).toBe(false)
    const startup = await run({ startupChild: true }); expect(startup.code).toBe(1); expect(startup.queried).toBe(false)
  }, 30000)
  it('retains an injected owned signal refusal alongside the original SDK-close failure with acceptance closed', async () => {
    const result = await run({ sdkCloseThrow: true, sdkCloseSignalFailure: true }, [], '3000')
    expect(result.code).toBe(1)
    expect(result.report.result).toBe('FAIL')
    expect(result.report.acceptance).toBe(false)
    expect(result.report.privateRuntimeRemoved).toBe(false)
    expect(result.report.cleanupFailures).toContain('SDK abort failure')
    expect(result.report.cleanupFailures).toContain('client signal')
    expect(result.report.clientProcesses.some(owned => owned.signalFailures === 1)).toBe(true)
    expect(result.report.clientProcesses.every(owned => owned.join === 'JOINED')).toBe(true)
  }, 30000)
  it('handles a throwing SDK close without escaping joined cleanup or deleting its retained fixture', async () => {
    const result = await run({ sdkCloseThrow: true }, [], '3000'); expect(result.queried).toBe(true); expect(result.code).toBe(1); expect(result.report.cleanupFailures).toContain('SDK abort failure')
  }, 30000)
  it('retains isolated runtime and closes acceptance when startup cannot be joined', async () => {
    const result = await run({ pendingStartup: true }, [], '10000'); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
  }, 30000)
})
