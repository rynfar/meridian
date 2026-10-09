import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(Bun.version!=='1.3.11'||process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Exact reviewed Bun/platform fixture required');
const [beforeArg,afterArg,nodeArg]=process.argv.slice(2);
if(!beforeArg||!afterArg||!nodeArg)throw new Error('Explicit before/after source and Node binary required');
const node=resolve(nodeArg),before=readFileSync(resolve(beforeArg),'utf8'),after=readFileSync(resolve(afterArg),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const nodeSha256=hash(readFileSync(node));
if(nodeSha256!=='5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c')throw new Error('Exact reviewed Node binary required');
if(hash(before)!=='58c61e8a33d2fa5ca2c482ae9cf1e8f8a3039489134fbae355bbdc71b3367ea0')throw new Error('Before-source identity changed');
const {modelLabel,exactBackendModel,queryCustodyJoined}=await import(pathToFileURL(join(dirname(resolve(afterArg)),'native-observations.ts')).href);
const oldNameLine=before.split('\n').find(line=>line.startsWith('const safeName ='));
const oldName=new Function(oldNameLine+';return safeName;')();
if(oldName('opus[1m]')!==null||oldName('claude-opus-5-5[1m]')!==null)throw new Error('Old model label loss not reproduced');
if(modelLabel('opus[1m]')!=='opus[1m]'||modelLabel('claude-opus-5-5[1m]')!=='claude-opus-5-5[1m]')throw new Error('New model labels lost');
const handle={},q={gate:{handle},handle,initAt:1000,nativeVersion:'2.1.292',nativeModel:null,iteratorSettledAt:1001,closeAt:1002};
const predicateStart=before.indexOf('queries.every(q => q.gate && q.initAt');
const oldPredicate=before.slice(predicateStart,before.indexOf(", o['join-ms']",predicateStart));
if(new Function('queries','o','return '+oldPredicate+';')([q],{model:'claude-opus-5-5'}))throw new Error('Old custody/model conflation not reproduced');
if(!queryCustodyJoined(q))throw new Error('New physical custody lost');
const expected={requested:'claude-opus-5-5',sdk:'opus[1m]',native:'claude-opus-5-5[1m]',version:'2.1.292'};
if(exactBackendModel({requested:expected.requested,sdk:expected.sdk,pin:expected.requested,native:undefined,version:expected.version},expected))throw new Error('Missing model gained acceptance');
function block(source,role){const key=role==='proxy'?'instance':'relay',start=source.indexOf('      if ('+key+') {'),end=source.indexOf('      report.cleanup.'+(role==='proxy'?'proxyClose':'relayClose'),start);if(start<0||end<start)throw new Error('Closure extraction failed');return source.slice(start,end)}
const snippets=[];
async function waitFor(predicate,ms,label){const end=Date.now()+ms;while(!predicate()){if(Date.now()>=end)throw new Error(label);await delay(20)}}
const results=[];
const bounded=(promise,ms,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(label)),ms);promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const mode of ['before-proxy','after-proxy','before-relay','after-relay']){
 const role=mode.endsWith('proxy')?'proxy':'relay',source=mode.startsWith('before')?before:after,snippet=block(source,role);snippets.push({mode,sha256:hash(snippet)});
 const sockets=new Set(); const socketJoins=[]; const facts={mode,accepted:0,closed:0,listenerClose:false,listenerCallback:false,childExit:false,childClose:false,stdoutEnd:false,stdoutClose:false,stderrEnd:false,stderrClose:false};
 const server=createServer((req,res)=>res.end('owned'));
 const listenerFacts={closeObserved:false,closeCallback:false,accepted:0,closed:0};const listeners={[role]:listenerFacts};
 server.on('connection',socket=>{facts.accepted++;listenerFacts.accepted++;sockets.add(socket);socketJoins.push(new Promise(resolve=>socket.once('close',resolve)));socket.on('close',()=>{facts.closed++;listenerFacts.closed++;sockets.delete(socket)})});
 server.on('close',()=>{facts.listenerClose=true;listenerFacts.closeObserved=true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const script=`const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${port}},()=>s.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: keep-alive\\r\\n\\r\\n'));let ready=false;const t=setTimeout(()=>{s.destroy();process.exitCode=2},10000);s.on('data',()=>{if(!ready){ready=true;process.stdout.write('READY\\n')}});s.on('close',()=>{clearTimeout(t)});s.on('error',()=>{process.exitCode=3});`;
 const child=spawn(node,['-e',script],{env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe']});
 const done=new Promise(resolve=>child.once('close',code=>{facts.childClose=true;facts.childCode=code;resolve()}));
 child.once('exit',()=>{facts.childExit=true});
 for(const label of ['stdout','stderr']){child[label].once('end',()=>{facts[label+'End']=true});child[label].once('close',()=>{facts[label+'Close']=true})}
 try{
  await bounded(new Promise(resolve=>{let text='';child.stdout.on('data',b=>{text+=b.toString();if(text.includes('READY'))resolve()})}),5000,'peer-ready');
  facts.ready=true;
  const instance={close:()=>new Promise((resolve,reject)=>server.close(error=>{facts.listenerCallback=true;if(error)reject(error);else resolve()}))};
  const execute=new Function('instance','relay','sockets','proxySockets','listeners','bounded','waitFor','o','return (async()=>{'+snippet+'})()');
  await execute(instance,server,sockets,sockets,listeners,bounded,waitFor,{'join-ms':2000});
  await delay(250);
  if(role==='relay')facts.listenerCallback=listenerFacts.closeCallback;
  facts.observation={accepted:facts.accepted,closed:facts.closed,liveSockets:sockets.size,listenerClose:facts.listenerClose,listenerCallback:facts.listenerCallback,childExit:facts.childExit};
 }catch(error){facts.failure=error.message;facts.observation={accepted:facts.accepted,closed:facts.closed,liveSockets:sockets.size,listenerFacts:{...listenerFacts}}}
 finally{
  for(const socket of sockets)socket.destroy();server.closeAllConnections();
  await bounded(Promise.all(socketJoins),2000,'accepted-sockets-final-join');
  try{await bounded(done,2000,'owned-peer-join')}catch(error){child.kill('SIGTERM');await bounded(done,2000,'owned-peer-final-join');facts.cleanupSignal='SIGTERM'}
 }
 if(role==='relay')facts.listenerCallback=listenerFacts.closeCallback;
 facts.finalLiveSockets=sockets.size;facts.allOwnedJoins=facts.childExit&&facts.childClose&&facts.stdoutEnd&&facts.stdoutClose&&facts.stderrEnd&&facts.stderrClose&&facts.closed===facts.accepted&&!sockets.size;results.push({...facts});
}
if(!results.every(r=>r.allOwnedJoins))throw new Error('Owned control cleanup not joined');
if(results.filter(r=>r.mode.startsWith('before')).some(r=>!r.failure)||results.filter(r=>r.mode.startsWith('after')).some(r=>r.failure||r.observation.liveSockets!==0||r.observation.closed!==r.observation.accepted))throw new Error('Socket before/after control failed');
console.log(JSON.stringify({status:'PASS',runtime:Bun.version,nodeSha256,sourceHashes:{before:hash(before),after:hash(after)},snippets,results,modelLabelLossBeforeCorrected:true,modelCustodyConflationBeforeCorrected:true,missingModelAcceptanceStillRefused:true,modelCalls:0,scope:'Exact extracted old/current listener closure blocks with actual pinned Bun listeners and exact Node peers; model/custody helpers controlled independently. No native/model/product acceptance.'}));
