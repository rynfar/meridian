// Opt-in actual OpenAI tool continuations through the signed-in agy CLI.
// Run after npm run build; consumes subscription quota.
import assert from 'node:assert/strict'
import { startProxyServer } from '../dist/server.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
const root=await mkdtemp(join(tmpdir(),'meridian-agy-openai-tools-')); console.log(root)
const proxy=await startProxyServer({backend:'antigravity',port:0,silent:true,antigravity:{allowToolBridge:true}})
if(!proxy.server.listening)await once(proxy.server,'listening')
const url='http://127.0.0.1:'+proxy.server.address().port
const passed=[]
try {
 for(const route of ['chat/completions','responses']) {
  const tool={name:'receipt',description:'Read the exact receipt',parameters:{type:'object',properties:{},additionalProperties:false}}
  const prompt='Call receipt once, then reply with exactly the returned receipt. Do not use any native tools.'
  const chat=route==='chat/completions'
  let body=chat?{model:'gemini-3.8-flash-low',messages:[{role:'user',content:prompt}],tools:[{type:'function',function:tool}],tool_choice:'required'}:{model:'gemini-3.8-flash-low',input:[{role:'user',content:prompt}],tools:[{type:'function',...tool}],tool_choice:'required'}
  const first=await fetch(url+'/v1/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)})
  const answer=await first.json(); assert.equal(first.status,200,JSON.stringify(answer))
  const receipt='OPENAI_'+randomUUID()
  if(chat){const message=answer.choices[0].message;assert.equal(message.tool_calls.length,1);body.messages.push({role:'assistant',content:message.content,tool_calls:message.tool_calls},{role:'tool',tool_call_id:message.tool_calls[0].id,content:receipt})}
  else {const call=answer.output.find(item=>item.type==='function_call');assert(call);body.input.push(...answer.output,{type:'function_call_output',call_id:call.call_id,output:receipt})}
  body.tool_choice='auto';body.stream=true
  const next=await fetch(url+'/v1/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)})
  const stream=await next.text();assert.equal(next.status,200,stream)
  const frames=stream.split('\n').filter(line=>line.startsWith('data: ')&&!line.includes('[DONE]')).map(line=>JSON.parse(line.slice(6)))
  const text=frames.map(frame=>chat?frame.choices?.[0]?.delta?.content??'':frame.type==='response.output_text.delta'?frame.delta:'').join('')
  await writeFile(join(root,chat?'chat.json':'responses.json'),JSON.stringify({first:answer,stream,text,receipt},null,2))
  assert.equal(text.trim(),receipt)
  passed.push(route+' actual tool round trip with streamed result');console.log('PASS',route)
 }
}finally{await proxy.close();await writeFile(join(root,'report.json'),JSON.stringify({passed},null,2))}
