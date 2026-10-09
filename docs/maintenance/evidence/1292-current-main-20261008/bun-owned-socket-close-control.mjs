import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const node='/Users/rynfar/.hermes/node/bin/node';
const results=[];
const bounded=(promise,ms,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(label)),ms);promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const mode of ['idle','all','destroy']){
 const sockets=new Set(); const socketJoins=[]; const facts={mode,accepted:0,closed:0,listenerClose:false,listenerCallback:false,childExit:false,childClose:false,stdoutEnd:false,stdoutClose:false,stderrEnd:false,stderrClose:false};
 const server=createServer((req,res)=>res.end('owned'));
 server.on('connection',socket=>{facts.accepted++;sockets.add(socket);socketJoins.push(new Promise(resolve=>socket.once('close',resolve)));socket.on('close',()=>{facts.closed++;sockets.delete(socket)})});
 server.on('close',()=>{facts.listenerClose=true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const script=`const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:${port}},()=>s.write('GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: keep-alive\\r\\n\\r\\n'));let ready=false;const t=setTimeout(()=>{s.destroy();process.exitCode=2},10000);s.on('data',()=>{if(!ready){ready=true;process.stdout.write('READY\\n')}});s.on('close',()=>{clearTimeout(t)});s.on('error',()=>{process.exitCode=3});`;
 const child=spawn(node,['-e',script],{stdio:['ignore','pipe','pipe']});
 const done=new Promise(resolve=>child.once('close',code=>{facts.childClose=true;facts.childCode=code;resolve()}));
 child.once('exit',()=>{facts.childExit=true});
 for(const label of ['stdout','stderr']){child[label].once('end',()=>{facts[label+'End']=true});child[label].once('close',()=>{facts[label+'Close']=true})}
 try{
  await bounded(new Promise(resolve=>{let text='';child.stdout.on('data',b=>{text+=b.toString();if(text.includes('READY'))resolve()})}),5000,'peer-ready');
  facts.ready=true;
  const listener=new Promise(resolve=>server.close(error=>{facts.listenerCallback=true;facts.listenerError=Boolean(error);resolve()}));
  if(mode==='idle')server.closeIdleConnections();
  if(mode==='all')server.closeAllConnections();
  if(mode==='destroy')for(const socket of sockets)socket.destroy();
  await bounded(listener,2000,'listener-close');
  await delay(250);
  facts.observation={accepted:facts.accepted,closed:facts.closed,liveSockets:sockets.size,listenerClose:facts.listenerClose,listenerCallback:facts.listenerCallback,childExit:facts.childExit};
 }catch(error){facts.failure=error.message;facts.observation={accepted:facts.accepted,closed:facts.closed,liveSockets:sockets.size}}
 finally{
  for(const socket of sockets)socket.destroy();server.closeAllConnections();
  await bounded(Promise.all(socketJoins),2000,'accepted-sockets-final-join');
  try{await bounded(done,2000,'owned-peer-join')}catch(error){child.kill('SIGTERM');await bounded(done,2000,'owned-peer-final-join');facts.cleanupSignal='SIGTERM'}
 }
 facts.finalLiveSockets=sockets.size;facts.allOwnedJoins=facts.childExit&&facts.childClose&&facts.stdoutEnd&&facts.stdoutClose&&facts.stderrEnd&&facts.stderrClose&&facts.closed===facts.accepted&&!sockets.size;results.push({...facts});
}
console.log(JSON.stringify({runtime:Bun.version,results,modelCalls:0,scope:'Owned Bun HTTP listeners and exact spawned Node TCP peers; no production/native/config mutation'}));
