// Actual CLI lifecycle only: no SDK inference or credential acceptance claims.
// Usage: node e2e-detached-lifecycle.mjs <runtime> <absolute-cli-entry> <new-scratch-root>
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [runtime,entry,scratch]=process.argv.slice(2);
if(!runtime||!entry||!scratch||!['darwin','linux','win32'].includes(process.platform))throw new Error('Supply runtime, CLI entry and fresh scratch root on Darwin, an isolated Linux container, or a clean hosted Windows CI runner');
const cli=resolve(entry), root=resolve(scratch), run=promisify(execFile);
const linux=process.platform==='linux', windows=process.platform==='win32';
if(windows){
 assert.equal(process.env.GITHUB_ACTIONS,'true','Windows proof is restricted to clean hosted CI');
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Do not use an account-bearing self-hosted runner');
}
if(linux){
 const route=await readFile('/proc/net/route','utf8');
 assert.equal(route.trim().split('\n').length,1,'Linux proof requires a network-disabled container');
 assert.equal(process.env.MERIDIAN_DETACHED_ISOLATED_CONTAINER,'1','Run only in a fresh container without credential mounts');
}
const launch=()=>linux||windows?[runtime,[cli]]:['/usr/bin/sandbox-exec',['-f',join(root,'fence.sb'),runtime,cli]];
await mkdir(root,{mode:0o700});
await mkdir(join(root,'claude'),{mode:0o700});
const quote=value=>JSON.stringify(value);
const privatePaths=['.codex','.claude','.config','Library/Keychains'].map(path=>`(subpath ${quote(join(homedir(),path))})`).join(' ');
const policy=`(version 1)
(allow default)
(deny network*)
(deny file-read-data ${privatePaths})
(deny file-write* (subpath ${quote(homedir())}))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network* (local unix-socket) (remote unix-socket))
; macOS /bin/ps is setuid and otherwise fails at spawn. Only this read-only
; identity utility is exempt; CLI, server and SDK children retain the fence.
(allow process-exec (literal "/bin/ps") (with no-sandbox))
`;
await writeFile(join(root,'fence.sb'),policy);
// Windows process-incarnation probes need the OS PowerShell modules. The
// before/after launch-lease control isolates PSModulePath as the missing input;
// retain it without importing arbitrary account/provider environment variables.
const base=Object.fromEntries(['PATH','HOME','TMPDIR','USER','LOGNAME',...(windows?['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT','PSModulePath']:[])].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(base,{MERIDIAN_CONFIG_DIR:join(root,'config'),CLAUDE_CONFIG_DIR:join(root,'claude'),MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_HOST:'127.0.0.1',MERIDIAN_PROFILES:JSON.stringify([{id:'offline-fixture',type:'api',apiKey:'offline-fixture-not-a-key',baseUrl:'http://127.0.0.1:1'}])});
async function reserve(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));return{server,port:server.address().port};}
const reservations=await Promise.all([reserve(),reserve()]);
const ports=reservations.map(item=>item.port);
for(const {server} of reservations)await new Promise(r=>server.close(r));
const commands=[];let failure;let configurationDiagnostic;const startupLogs=[];
async function command(port,args){
 try{const [executable,prefix]=launch();const result=await run(executable,[...prefix,...args],{env:{...base,MERIDIAN_PORT:String(port)},cwd:root,timeout:70000,maxBuffer:65536});const value=JSON.parse(result.stdout);commands.push({port,args,exit:0,value,stderr:result.stderr});return value;}
 catch(error){commands.push({port,args,exit:error.code,stdout:error.stdout,stderr:error.stderr});throw error;}
}
async function ready(port){const result=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(2000)});assert.equal(result.status,200);assert.equal(await result.text(),'ok\n');}
try{
 const attempts=await Promise.allSettled([command(ports[0],['start','--detach','--json']),command(ports[0],['start','--detach','--json'])]);
 for(const attempt of attempts)if(attempt.status==='rejected')throw attempt.reason;
 const starts=attempts.map(attempt=>attempt.value);
 assert.deepEqual(starts.map(value=>value.outcome).sort(),['ready-created','ready-existing']);
 const first=starts[0],next=starts[1];assert.equal(next.instanceId,first.instanceId);
 const second=await command(ports[1],['start','--detach','--json']);assert.equal(second.outcome,'ready-created');assert.notEqual(first.instanceId,second.instanceId);
 await ready(ports[0]);await ready(ports[1]);
 const stopped=await command(ports[0],['stop','--json']);assert.equal(stopped.outcome,'stopped');assert.equal(stopped.instanceId,first.instanceId);
 await ready(ports[1]);assert.equal((await command(ports[0],['stop','--json'])).outcome,'already-stopped');
 assert.equal((await command(ports[1],['stop','--json'])).outcome,'stopped');
 for(const instance of [first,second]){const log=await readFile(instance.logPath,'utf8');assert.ok(log.length>0);assert.match(log,/shutting down/i);}
}catch(error){failure=String(error);}
finally{
 // A source-only diagnostic reuses the failed command's isolated environment.
 // No repair or bypass: exercise the same directory/ACL operation and preserve
 // its bounded error chain. Both launch attempts have settled before cleanup.
 if(failure&&windows&&cli.endsWith('.ts')){
  const moduleUrl=pathToFileURL(resolve(dirname(cli),'../src/cli/detachedStore.ts')).href;
  const coordinatorUrl=pathToFileURL(resolve(dirname(cli),'../src/proxy/session/crossProcessTurnCoordinator.ts')).href;
  const script=`import {detachedPaths} from ${JSON.stringify(moduleUrl)};
import {CrossProcessTurnCoordinator} from ${JSON.stringify(coordinatorUrl)};
let stage='paths';
try { const paths=await detachedPaths(process.env.MERIDIAN_CONFIG_DIR,'127.0.0.1',${ports[0]},true);
 stage='launch-coordination';
 const keepAlive=setTimeout(()=>{},20000);
 try { const lease=await new CrossProcessTurnCoordinator(paths.locks,{acquireTimeoutMs:15000}).acquire('launch:'+paths.key,AbortSignal.timeout(15000)); await lease.release(); }
 finally {clearTimeout(keepAlive);}
 console.log(JSON.stringify({pass:true,stage})); }
catch(error){ const causes=[]; for(let e=error;e&&causes.length<5;e=e.cause)causes.push({name:e.name,message:String(e.message).slice(0,150),code:e.code,signal:e.signal,killed:e.killed,stdout:typeof e.stdout==='string'?e.stdout.slice(0,500):undefined,stderr:typeof e.stderr==='string'?e.stderr.slice(0,2500):undefined});console.log(JSON.stringify({pass:false,stage,causes})); }`;
  configurationDiagnostic=[];
  for(const [label,env] of [
   ['without-module-path',Object.fromEntries(Object.entries(base).filter(([key])=>key!=='PSModulePath'))],
   ['allowlisted',base],
   ['module-path',{...base,...(process.env.PSModulePath?{PSModulePath:process.env.PSModulePath}:{})}],
   ['windows-module-environment',{...base,...Object.fromEntries(['PSModulePath','ProgramFiles','ProgramFiles(x86)','ProgramW6432'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))}],
   // This diagnostic imports only detachedStore/coordinator, not CLI/SDK. Hosted CI has
   // no user account; never print environment values or run inference here.
   ['hosted-runner-environment',{...process.env,...base}],
  ]){
   const began=Date.now();
   try{const result=await run(runtime,['-e',script],{env,cwd:root,timeout:30000,maxBuffer:16384});configurationDiagnostic.push({label,elapsedMs:Date.now()-began,...JSON.parse(result.stdout)});}
   catch(error){configurationDiagnostic.push({label,probeFailed:true,elapsedMs:Date.now()-began,message:String(error).slice(0,150)});}
  }
 }
 for(const port of ports)await command(port,['stop','--json']).catch(error=>{failure??=String(error)});
 // Read only logs reported by these dummy-profile commands, below this fresh
 // test root. Never read an arbitrary CLI-supplied path or account-bearing log.
 // Windows is restricted above to clean hosted CI; no model calls occur here.
 if(failure){
  const ownLogs=new Set();
  for(const item of commands){
   let value=item.value;
   if(!value&&item.stdout){try{value=JSON.parse(item.stdout);}catch(error){continue;}}
   if(typeof value?.logPath!=='string')continue;
   const path=resolve(value.logPath),inside=relative(join(root,'config','detached'),path);
   if(!inside||inside.startsWith('..')||isAbsolute(inside)||!inside.endsWith('.log'))continue;
   ownLogs.add(path);
  }
  for(const path of ownLogs){
   try{startupLogs.push({path,text:(await readFile(path,'utf8')).slice(-8192)});}
   catch(error){startupLogs.push({path,readFailure:String(error).slice(0,500)});}
  }
 }
 await writeFile(join(root,'receipt.json'),JSON.stringify({pass:!failure,failure,configurationDiagnostic,startupLogs,cli,runtime,entrySha256:createHash('sha256').update(await readFile(cli)).digest('hex'),platform:process.platform,arch:process.arch,ports,commands,scope:'Actual CLI startup/readiness/targeted graceful stop only. No SDK inference; dummy API profile. Darwin: Seatbelt loopback/Unix sockets with ps-only read-only identity exception. Linux: network-disabled isolated container, no credential mounts. Windows: clean GitHub-hosted CI, allowlisted environment, dummy loopback API profile; no OS network fence.'},null,2));
}
console.log(JSON.stringify({pass:!failure,failure,receipt:join(root,'receipt.json')}));if(failure)process.exitCode=1;
