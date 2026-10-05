import { describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const harness = '/tmp/meridian-backlog-20261004/meridian/1211/aux-harness-round1/harness-before-H1-H2.mjs'
type Mode = { baseline?: boolean; missingClassifier?: boolean; markerInUser?: boolean; fast?: boolean; swapped?: boolean; startupChild?: boolean; pendingStartup?: boolean; wrongModel?: boolean; queryAtStartup?: boolean; hang?: boolean; errorMaxTurns?: boolean; terminalSse?: boolean; brokenTerminal?: boolean; refusal?: boolean; duplicateToolId?: boolean; borrowTerminal?: boolean; repeatHttpToolId?: boolean; missingErrorFlag?: boolean; falseMaxTurnsFlag?: boolean }
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
export function query(input){writeFileSync(new URL('query-called',root),'synthetic only');const destination=/date > ([^\x60]+)/.exec(input.prompt)?.[1],tool=mode.errorMaxTurns&&destination?{type:'tool_use',id:mode.duplicateToolId&&destination.endsWith('/stamp1.txt')?'synthetic-reused-tool':'synthetic-tool-'+(++count),name:'Bash',input:{command:'date > '+destination}}:undefined;return{close(){},async *[Symbol.asyncIterator](){yield{type:'assistant',...(mode.refusal?{error:'authentication_failed'}:{}),message:{model:mode.refusal?'<synthetic>':mode.wrongModel?'claude-sonnet-4-6':'claude-sonnet-5-5',usage:{input_tokens:mode.refusal?0:12,output_tokens:mode.refusal?0:4},content:tool?[tool]:[]}};yield{type:'result',subtype:mode.refusal?'error_during_execution':tool?'error_max_turns':'success',...(mode.missingErrorFlag?{}:{is_error:tool&&mode.falseMaxTurnsFlag?false:!!tool||!!mode.refusal}),num_turns:1,total_cost_usd:0.001}}}}
`)
  writeFileSync(join(target, 'server.mjs'), `import assert from 'node:assert/strict';import{createServer}from'node:http';import{readFileSync,writeFileSync,statSync}from'node:fs';import{spawn}from'node:child_process';import{once}from'node:events';import{query}from'@anthropic-ai/claude-agent-sdk';
const mode=JSON.parse(readFileSync(new URL('mode.json',import.meta.url),'utf8'));let main=0,requests=0,toolTerminals=0,previousTool;
assert(!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN&&!process.env.CLAUDE_CODE_OAUTH_TOKEN&&!process.env.MERIDIAN_PROFILES&&!process.env.MERIDIAN_TELEMETRY_DB&&!process.env.CLAUDE_PROXY_CONFIG_DIR&&!process.env.AWS_PROFILE);
export async function startProxyServer(config){
 const account=config.profiles[0].claudeConfigDir,cred=JSON.parse(readFileSync(account+'/.credentials.json','utf8'));
 assert(config.port===0&&config.host==='127.0.0.1'&&config.defaultProfile==='e71-owned');assert(!cred.claudeAiOauth.refreshToken);assert((statSync(account+'/.credentials.json').mode&511)===256);assert(process.env.MERIDIAN_CREDENTIALS_READONLY==='1');assert(account!==process.env.CLAUDE_CONFIG_DIR);
 writeFileSync(new URL('audit.json',import.meta.url),JSON.stringify({account,work:process.env.MERIDIAN_WORKDIR,config:process.env.MERIDIAN_CONFIG_DIR,store:process.env.MERIDIAN_SESSION_DIR,plugins:config.pluginDir,home:process.env.HOME}));
 if(mode.pendingStartup)await new Promise(()=>{});
 if(mode.startupChild){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"],{cwd:process.env.MERIDIAN_WORKDIR,stdio:['ignore','pipe','ignore']});writeFileSync(new URL('startup-child-pid',import.meta.url),String(child.pid));await once(child.stdout,'data');throw new Error('synthetic startup failure after child readiness')}
 const input=body=>({prompt:body?.messages?.[0]?.content??'synthetic',options:{model:body?.model??'claude-sonnet-5-5',maxTurns:1,env:{CLAUDE_CONFIG_DIR:account},pathToClaudeCodeExecutable:process.env.MERIDIAN_CLAUDE_PATH,abortController:new AbortController()}});
 if(mode.queryAtStartup)query(input());
 const server=createServer(async(req,res)=>{try{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),aux=!body.tools?.length;
 let content=[];for await(const event of query(input(body)))if(event.type==='assistant')content=event.message.content;
 if(content.length){toolTerminals++;const current=content[0];if(mode.repeatHttpToolId&&toolTerminals===2)content=[current,previousTool];previousTool=current;if(mode.borrowTerminal&&toolTerminals===2)content=[]}
 const reportedAux=mode.swapped&&++requests<=2?!aux:aux;const lineage=reportedAux||main===0||mode.baseline?'diverged':'continuation';const divergence=reportedAux?(mode.baseline?'unrelated-history':'independent-request:auxiliary-request'):main>0&&mode.baseline?'unrelated-history':undefined;if(!aux)main++;
 console.log('[PROXY] '+req.headers['x-request-id']+' adapter=claude-code msgCount='+body.messages.length+' tools='+(body.tools?.length??0)+' lineage='+lineage+(divergence?' diverged='+divergence:'')+' sessionWait=0ms private=synthetic-owner-secret');
 if(content.length){if(mode.terminalSse){const tool=content[0],events=[{type:'message_start',message:{type:'message',content:[]}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:tool.id,name:tool.name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(tool.input)}},...(mode.brokenTerminal?[]:[{type:'content_block_stop',index:0}]),{type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}];res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+String.fromCharCode(10,10)).join(''))}else{if(mode.brokenTerminal)content[0].input.command='different synthetic tool';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'message',stop_reason:'tool_use',content}))}}else{res.writeHead(200,{'content-type':'application/json'});res.end('{}')}}catch{res.writeHead(500);res.end('{}')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,close:()=>new Promise(resolve=>server.close(resolve))}
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
async function send(aux){const envelope='You are a security monitor for autonomous AI coding agents.\\n<cc_automode_permissions>\\nSynthetic permission rules.\\n</cc_automode_permissions>';const body={model,metadata:{user_id:JSON.stringify({session_id:session})},stream:false,messages:[{role:'user',content:mode.markerInUser?envelope:aux?'synthetic':process.argv[process.argv.indexOf('-p')+1]}],tools:aux?[]:[{name:'Read'}],...(aux?{stop_sequences:['</block>'],...(mode.markerInUser?{}:{system:[{type:'text',text:'Billing header first'},{type:'text',text:envelope}]})}:{})};if(aux&&mode.fast){delete body.stream;delete body.stop_sequences;body.messages.push({role:'user',content:'segment2'},{role:'user',content:'segment3'})}const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{...headers,...(aux&&headers['x-claude-code-request-class']?{'x-claude-code-request-class':'auxiliary'}:{})},body:JSON.stringify(body)});await response.text();assert(response.status===200)}
await send(false);if(turn!==3&&!mode.missingClassifier){await send(true);await send(false)}
const prompt=process.argv[process.argv.indexOf('-p')+1];if(prompt.includes('date > ')){const destination=prompt.split('date > ')[1].split(String.fromCharCode(96))[0];writeFileSync(destination,'Synthetic date receipt\\n')}
console.log(['ONE','TWO','THREE','FOUR'][turn-1]+' synthetic-owner-secret');
`)
  chmodSync(client, 0o700)
  const native = join(target, 'native')
  writeFileSync(native, '#!/usr/bin/env node\nconsole.log("2.1.284 (Claude Code)")\n'); chmodSync(native, 0o700)
  const grant = join(root, 'owned-grant.json')
  const bytes = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-owner-secret', refreshToken: 'synthetic-refresh-never-used', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] } })
  writeFileSync(grant, bytes, { mode: 0o400 })
  return { root, target, sdk, client, native, proof, grant, bytes }
}
async function run(mode: Mode = {}, extras: string[] = [], timeout = '10000') {
  const f = fixture(mode)
  let retainedSyntheticRuntime: string | undefined
  try {
    const command = [process.execPath, harness, '--synthetic', '--target-root', f.target, '--entry', 'server.mjs', '--client', f.client, '--client-version', '2.1.286', '--native-cli', f.native, '--native-cli-version', '2.1.284', '--sdk-version', '0.2.141', '--model', 'claude-sonnet-5-5', '--served-model', 'claude-sonnet-5-5', '--grant-file', f.grant, '--proof-dir', f.proof, '--max-queries', '20', '--max-cost-usd', '10', '--timeout-ms', timeout, ...extras]
    const child = Bun.spawn(command, { cwd: f.target, env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-ambient', ANTHROPIC_AUTH_TOKEN: 'synthetic-ambient', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-ambient', MERIDIAN_PROFILES: 'synthetic-ambient', MERIDIAN_TELEMETRY_DB: '/synthetic-no-write', CLAUDE_PROXY_CONFIG_DIR: '/synthetic-no-read', AWS_PROFILE: 'synthetic-ambient' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const serialized = readFileSync(join(f.proof, 'claude-auto-mode-results.json'), 'utf8')
    const report = JSON.parse(serialized) as { result: string; acceptance: boolean; privateSnapshotCreated?: boolean; privateRuntimeRemoved: boolean; ownerGrantUnchanged: boolean; queries: unknown[]; checks: Record<string, boolean>; cleanupFailures: string[]; targetIdentityUnchanged?: boolean; failure?: string }
    expect(serialized + out + err).not.toContain('synthetic-owner-secret')
    expect(serialized + out + err).not.toContain('synthetic-refresh-never-used')
    expect(report.acceptance).toBe(false)
    expect(report.ownerGrantUnchanged).toBe(true)
    expect(report.privateRuntimeRemoved).toBe(!mode.pendingStartup)
    if (mode.pendingStartup) {
      expect(report.cleanupFailures).toContain('proxy startup join')
      expect(report.cleanupFailures).toContain('private runtime retained after cleanup failure')
    } else expect(report.cleanupFailures).toEqual([])
    expect(readFileSync(f.grant, 'utf8')).toBe(f.bytes)
    expect(statSync(f.grant).mode & 0o777).toBe(0o400)
    if (existsSync(join(f.target, 'audit.json'))) {
      const audit = JSON.parse(readFileSync(join(f.target, 'audit.json'), 'utf8')) as Record<string, string>
      expect(new Set(Object.values(audit)).size).toBe(Object.values(audit).length)
      for (const directory of Object.values(audit)) expect(existsSync(directory)).toBe(!!mode.pendingStartup)
      if (mode.pendingStartup) {
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
    return { report, code, queried: existsSync(join(f.target, 'query-called')) }
  } finally {
    // This fixture has no child or generation, only a deliberately unsettled
    // startup Promise. Its independent test controller owns final removal.
    if (retainedSyntheticRuntime) rmSync(retainedSyntheticRuntime, { recursive: true, force: true })
    rmSync(f.root, { recursive: true, force: true })
  }
}

describe('E71 native harness containment and meaningful assertions', () => {
  it('runs an independent synthetic client through dynamic HTTP ports with ambient auth rejected', async () => {
    const result = await run(); expect(result.code).toBe(0); expect(result.report.result).toBe('PASS'); expect(result.report.targetIdentityUnchanged).toBe(true); expect(result.report.queries.length).toBe(10)
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
  it('does not count an ordinary XML stop/user marker as the required native classifier envelope', async () => {
    const result = await run({ markerInUser: true }); expect(result.code).toBe(1); expect(result.report.checks.classifierOccurred).toBe(false)
  }, 30000)
  it('rehearsal refuses a target startup query before the independent SDK can be invoked', async () => {
    const result = await run({ queryAtStartup: true }, ['--rehearsal']); expect(result.code).toBe(1); expect(result.queried).toBe(false); expect(result.report.queries).toEqual([])
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
