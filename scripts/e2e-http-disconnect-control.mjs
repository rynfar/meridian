#!/usr/bin/env node
// Isolate HTTP close delivery during an awaited handler, without Meridian or SDK.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
let responseClose=0, socketClose=0, finishedAtClose=null, release, entered
const started=new Promise(resolve=>{entered=resolve})
const gate=new Promise(resolve=>{release=resolve})
const server=createServer(async(req,res)=>{
  entered()
  res.on('close',()=>{responseClose++;finishedAtClose=res.writableFinished})
  req.socket.on('close',()=>{socketClose++})
  res.writeHead(200,{'Content-Type':'text/plain'});res.write('OPEN')
  await gate;res.end('DONE')
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const port=server.address().port
const child=spawn(process.env.E2E_NODE_BIN??'node',['--input-type=module','-e',`import {request} from 'node:http';const req=request({host:'127.0.0.1',port:${port},method:'POST'},res=>res.resume());req.on('error',()=>process.exit(1));req.end('body')`],{stdio:['ignore','pipe','pipe']})
const exited=once(child,'exit')
await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('request did not arrive')),5000))]);child.kill('SIGKILL');await exited
await new Promise(resolve=>setTimeout(resolve,600))
const expectMissedClose=process.argv.includes('--expect-missed-close')
assert(expectMissedClose ? responseClose===0 && socketClose===0 : responseClose>0 && socketClose>0 && finishedAtClose===false)
console.log(JSON.stringify({result:'PASS',expectMissedClose,runtime:globalThis.Bun?.version??process.version,responseClose,socketClose,finishedAtClose}))
release();server.closeAllConnections();server.close();setTimeout(()=>process.exit(0),100)
