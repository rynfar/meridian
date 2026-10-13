// Actual CLI lifecycle only: no SDK inference or credential acceptance claims.
// Usage: node e2e-detached-recovery.mjs <runtime> <absolute-cli-entry> <new-scratch-root>
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {execFile,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [runtime,entry,scratch]=process.argv.slice(2);
if(!runtime||!entry||!scratch||!['darwin','linux'].includes(process.platform))throw new Error('Supply runtime, CLI entry and fresh scratch root on Darwin or an isolated Linux container');
const cli=resolve(entry), root=resolve(scratch), run=promisify(execFile);
const linux=process.platform==='linux';
if(linux){
 const route=await readFile('/proc/net/route','utf8');
 assert.equal(route.trim().split('\n').length,1,'Linux proof requires a network-disabled container');
 assert.equal(process.env.MERIDIAN_DETACHED_ISOLATED_CONTAINER,'1','Run only in a fresh container without credential mounts');
}
const launch=()=>linux?[runtime,[cli]]:['/usr/bin/sandbox-exec',['-f',join(root,'fence.sb'),runtime,cli]];
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
const base=Object.fromEntries(['PATH','HOME','TMPDIR','USER','LOGNAME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(base,{MERIDIAN_CONFIG_DIR:join(root,'config'),CLAUDE_CONFIG_DIR:join(root,'claude'),MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_HOST:'127.0.0.1',MERIDIAN_PROFILES:JSON.stringify([{id:'offline-fixture',type:'api',apiKey:'offline-fixture-not-a-key',baseUrl:'http://127.0.0.1:1'}])});
async function reserve(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));return{server,port:server.address().port};}
const reservations=await Promise.all([reserve(),reserve()]);
const ports=reservations.map(item=>item.port);
for(const {server} of reservations)await new Promise(r=>server.close(r));
const commands=[];let failure;
async function command(port,args,extraEnv={}){
 try{const [executable,prefix]=launch();const result=await run(executable,[...prefix,...args],{env:{...base,MERIDIAN_PORT:String(port),...extraEnv},cwd:root,timeout:70000,maxBuffer:65536});const value=JSON.parse(result.stdout);commands.push({port,args,exit:0,value,stderr:result.stderr});return value;}
 catch(error){commands.push({port,args,exit:error.code,stdout:error.stdout,stderr:error.stderr});throw error;}
}
async function ready(port){const result=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(2000)});assert.equal(result.status,200);assert.equal(await result.text(),'ok\n');}
const faults=[];let supervisor;let supervisorClose;
async function noListener(port){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  const available=await new Promise((resolve,reject)=>{
   const probe=createServer();
   probe.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));
   probe.listen(port,'127.0.0.1',()=>probe.close(error=>error?reject(error):resolve(true)));
  });
  if(available)return;
  await delay(50);
 }
 throw new Error('Original child listener survived supervisor death');
}
try{
 const [executable,prefix]=launch();supervisor=spawn(executable,[...prefix,'__detached-supervisor'],{
  cwd:root,env:{...base,MERIDIAN_PORT:String(ports[0])},stdio:['ignore','ignore','pipe','ipc']
 });
 let stderr='';supervisor.stderr.on('data',chunk=>{stderr+=chunk});
 supervisorClose=new Promise((resolve,reject)=>{supervisor.once('error',reject);supervisor.once('close',(code,signal)=>resolve({code,signal}));});
 const identity=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Owned supervisor did not commit within startup bound')),65000);
  supervisor.once('error',error=>{clearTimeout(timer);reject(error)});
  supervisor.once('close',()=>{clearTimeout(timer);reject(new Error('Owned supervisor exited before commitment: '+stderr))});
  supervisor.on('message',value=>{
   if(value?.type==='meridian-detached-ready')supervisor.send({type:'meridian-detached-commit'});
   if(value?.type==='meridian-detached-committed'){clearTimeout(timer);resolve(value.instanceId);}
  });
 });
 await ready(ports[0]);
 // Fault injection uses our original spawned handle, never a PID from a record.
 assert.equal(supervisor.kill('SIGKILL'),true);
 const exit=await supervisorClose;assert.equal(exit.signal,'SIGKILL');
 await noListener(ports[0]);faults.push({case:'supervisor-crash',instanceId:identity,supervisorExit:exit,listenerClosed:true});
 const began=Date.now();const recovered=await command(ports[0],['start','--detach','--json']);
 assert.equal(recovered.outcome,'ready-created');assert.notEqual(recovered.instanceId,identity);
 await ready(ports[0]);faults.push({case:'confirmed-dead-owner-recovery',waitMs:Date.now()-began,oldInstanceId:identity,newInstanceId:recovered.instanceId});
 assert.equal((await command(ports[0],['stop','--json'])).outcome,'stopped');
 const log=await readFile(recovered.logPath,'utf8');assert.match(log,/shutting down/i);
 let invalidFailed=false;
 try{await command(ports[1],['start','--detach','--json'],{MERIDIAN_BACKEND:'invalid-test-backend'});}
 catch(error){assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).outcome,'failed');invalidFailed=true;}
 assert.equal(invalidFailed,true);
 // Failed startup may still be completing its original cleanup. Observe a
 // later normal invocation rather than deleting its record in the harness.
 await delay(200);
 const clean=await command(ports[1],['start','--detach','--json']);assert.equal(clean.outcome,'ready-created');
 await ready(ports[1]);assert.equal((await command(ports[1],['stop','--json'])).outcome,'stopped');
 faults.push({case:'invalid-backend-startup',failedWithExit:1,laterValidStartup:true});
}catch(error){failure=String(error);}
finally{
 if(supervisor&&supervisor.exitCode===null&&supervisor.signalCode===null){supervisor.kill('SIGKILL');await supervisorClose.catch(error=>{failure??=String(error)});}
 for(const port of ports)await command(port,['stop','--json']).catch(error=>{failure??=String(error)});
 await writeFile(join(root,'receipt.json'),JSON.stringify({pass:!failure,failure,cli,runtime,entrySha256:createHash('sha256').update(await readFile(cli)).digest('hex'),platform:process.platform,arch:process.arch,ports,commands,faults,scope:'Actual supervisor original-handle crash, listener shutdown, confirmed-dead-owner recovery and startup error. No SDK inference; dummy API profile. Darwin: Seatbelt loopback/Unix sockets with ps-only identity exception. Linux: network-disabled isolated container, no credential mounts.'},null,2));
}
console.log(JSON.stringify({pass:!failure,failure,receipt:join(root,'receipt.json')}));if(failure)process.exitCode=1;
