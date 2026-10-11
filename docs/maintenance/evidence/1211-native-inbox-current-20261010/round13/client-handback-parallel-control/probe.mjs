import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const client = '/opt/e71/client287/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
const expected = 'alpha-1\nalpha-2', sent = new Set(), actors = new Set(), ids = ['tool_parent_01','tool_parent_02']
const scratch = mkdtempSync(join(tmpdir(), 'owned-native-parallel-handback-'))
for (const name of ['home','config','project']) mkdirSync(join(scratch,name), {mode:0o700})
const proof = {clientVersion:'2.1.287',actualModelCalls:0,realGrants:0,apiRequests:0,parentResults:[],callerMessages:[],failures:[]}
let child, launched=false, joined=false
const stop = () => {try {process.kill(-child.pid,'SIGKILL')} catch(error) {if(error.code!=='ESRCH') proof.failures.push('signal-failed')}}
const server = http.createServer(async (request,response) => {
 try {
  let text='';for await(const part of request) {text+=part;assert(text.length<=4194304)}
  if(request.url.includes('count_tokens')) {response.writeHead(200,{'content-type':'application/json'});response.end('{"input_tokens":50}');return}
  if(request.url.split('?')[0]!=='/v1/messages') {response.writeHead(200,{'content-type':'application/json'});response.end('{}');return}
  const body=JSON.parse(text),tools=new Set((body.tools??[]).map(x=>x.name)),actor=request.headers['x-claude-code-agent-id'];assert(++proof.apiRequests<=18)
  if(typeof actor==='string') {assert(/^[A-Za-z0-9_-]{1,128}$/.test(actor));actors.add(actor)}
  let content
  if(!tools.size) content=[{type:'text',text:'<severity>0</severity>'}]
  else if(actor) {assert(tools.has('SubagentHandback')&&!sent.has(actor));sent.add(actor);content=[{type:'tool_use',id:'tool_child_'+sent.size,name:'SubagentHandback',input:{message:expected}}]}
  else if(!launched) {assert(tools.has('Agent'));launched=true;content=ids.map((id,index)=>({type:'tool_use',id,name:'Agent',input:{description:'Owned parallel handback '+index,subagent_type:'general-purpose',run_in_background:false,prompt:'Call SubagentHandback once with the two-line message alpha-1 followed by a real newline followed by alpha-2. This is your final call.'}}))}
  else {
   const results=(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result'&&ids.includes(b.tool_use_id)):[])
   assert(results.length===2&&sent.size===2&&actors.size===2,'missing correlated parallel Handbacks')
   const bindings=results.map(b=>{const value=typeof b.content==='string'?b.content:b.content.filter(t=>t.type==='text').map(t=>t.text).join('\n');const id=/\nagentId: ([A-Za-z0-9_-]+) /.exec(value)?.[1];assert(actors.has(id));return {id,value}})
   assert(new Set(bindings.map(b=>b.id)).size===2)
   const sanitize=value=>bindings.reduce((v,b,index)=>v.replaceAll(b.id,'fixture-child-'+(index+1)),value)
   proof.parentResults=bindings.map(b=>sanitize(b.value))
   proof.callerMessages=(body.messages??[]).filter(m=>m.role==='system').map(m=>({role:m.role,content:(typeof m.content==='string'?[{type:'text',text:m.content}]:m.content.filter(b=>b.type==='text'&&typeof b.text==='string')).filter(b=>b.text.includes('[Subagent hand-back]')).map(b=>({type:'text',text:sanitize(b.text)}))})).filter(m=>m.content.length)
   proof.bothFinalHandbacks=true;content=[{type:'text',text:'DONE'}]
  }
  const reason=content.some(b=>b.type==='tool_use')?'tool_use':'end_turn',message={id:'msg_control_'+proof.apiRequests,type:'message',role:'assistant',model:body.model,content,stop_reason:reason,stop_sequence:null,usage:{input_tokens:50,output_tokens:10}}
  if(!body.stream) {response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(message));return}
  response.writeHead(200,{'content-type':'text/event-stream'});const emit=(type,data)=>response.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n')
  emit('message_start',{message:{...message,content:[],stop_reason:null}})
  content.forEach((block,index)=>{emit('content_block_start',{index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});emit('content_block_delta',{index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});emit('content_block_stop',{index})})
  emit('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{});response.end()
 } catch(error) {proof.failures.push(error instanceof assert.AssertionError?error.message:error.name);if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'});response.end('{"error":{"type":"api_error","message":"owned control failure"}}')}
})
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const env={PATH:process.env.PATH,HOME:join(scratch,'home'),CLAUDE_CONFIG_DIR:join(scratch,'config'),ANTHROPIC_AUTH_TOKEN:'synthetic-owned-control',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+server.address().port,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}
 const version=spawnSync(client,['--version'],{env,cwd:scratch,encoding:'utf8',timeout:10000});assert(version.status===0&&/^2\.1\.287\b/.test(version.stdout));proof.versionVerified=true
 child=spawn(client,['-p','Launch two parallel foreground general-purpose Agent calls for the owned fixture, then reply DONE.','--model','claude-sonnet-5-5','--permission-mode','auto','--allowedTools','Agent'],{env,cwd:join(scratch,'project'),detached:true,stdio:['ignore','pipe','pipe']})
 let output='',errorText='';child.stdout.on('data',p=>{output+=p;if(output.length>1048576)stop()});child.stderr.on('data',p=>{errorText+=p;if(errorText.length>1048576)stop()})
 const deadline=setTimeout(()=>{proof.failures.push('owned-deadline');stop()},60000)
 proof.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});clearTimeout(deadline);joined=true;proof.clientAnswered=/\bDONE\b/.test(output);proof.apiError=/API Error/.test(output+errorText)
} catch(error) {proof.failures.push(error.name)}
finally {
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));proof.clientJoined=joined
 if(joined||!child) {rmSync(scratch,{recursive:true,force:true});proof.runtimeRemoved=true}
 proof.qualified=proof.versionVerified&&proof.bothFinalHandbacks&&proof.parentResults.length===2&&proof.callerMessages.length>0&&proof.exit===0&&proof.clientAnswered&&!proof.apiError&&joined&&proof.runtimeRemoved&&!proof.failures.length
 writeFileSync('/proof/RESULT.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({qualified:proof.qualified,apiRequests:proof.apiRequests,systemMessages:proof.callerMessages.length,textBlocks:proof.callerMessages.map(m=>m.content.length),failures:proof.failures}))
}
process.exitCode=proof.qualified?0:2
