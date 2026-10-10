import { PassthroughCheckpointStop } from '/Users/rynfar/repos/meridian-claude-sidecalls-stack-1292-20261008/src/proxy/passthroughCheckpointStop.ts'
import assert from 'node:assert/strict'
const rows=[]
for (const count of [8,16380,16384]) {
 const input={values:Array.from({length:count},(_,i)=>i)}
 assert.deepEqual(JSON.parse(JSON.stringify(input)),input)
 let interrupts=0,error
 const stop=new PassthroughCheckpointStop({signal:new AbortController().signal,clientToolPrefix:'mcp__oc__',maxTurns:1})
 stop.attach(async()=>{interrupts++})
 const stream=event=>({type:'stream_event',session_id:'owned-session',event})
 try {
  stop.observe({type:'system',subtype:'init',session_id:'owned-session'})
  stop.observe(stream({type:'message_start',message:{id:'generation-1'}}))
  stop.observe(stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-a',name:'mcp__oc__read',input:{}}}))
  stop.observe(stream({type:'content_block_stop',index:0}))
  stop.observe({type:'assistant',session_id:'owned-session',uuid:'uuid-1',message:{id:'generation-1',content:[{type:'tool_use',id:'tool-a',name:'mcp__oc__read',input}]}})
 } catch(e) {error=e.name}
 await stop.retire()
 rows.push({arrayItems:count,validJsonRoundTrip:true,jsonBytes:Buffer.byteLength(JSON.stringify(input)),interrupts,ownedIntent:stop.requested,observerError:error??null,observerFailed:stop.failed})
}
assert.equal(rows[0].observerError,null)
assert.equal(rows[1].observerError,null)
assert.equal(rows[2].observerError,'PassthroughCheckpointStopError')
console.log(JSON.stringify({status:'REPRODUCED_SOURCE_GUARD_BOUNDARY',scope:'credential-free production pure observer only; HTTP/native before-after not yet executed, no client/model acceptance',rows,modelCalls:0,nativeProcesses:0}))
