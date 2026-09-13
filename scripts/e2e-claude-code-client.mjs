#!/usr/bin/env bun
// Real Claude Code 2.1.259 → Meridian → SDK read loop and ordinary continuation.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { realpathSync } from 'node:fs'
const captureOnly = process.argv.includes('--capture')
import assert from 'node:assert/strict'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-cc-client-')))
for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root,'proxy-config'), MERIDIAN_SESSION_DIR: join(root,'proxy-sessions'), MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST:'0', MERIDIAN_PASSTHROUGH:'1' })
const { startProxyServer } = await import('../src/proxy/server.ts')
const { lookupSharedSession } = await import('../src/proxy/sessionStore.ts')
const { telemetryStore } = await import('../src/telemetry/index.ts')
const { resolveClaudeExecutableAsync } = await import('../src/proxy/models.ts')
const client = process.env.E2E_CLAUDE_CLIENT ?? await resolveClaudeExecutableAsync()
const versionProcess = Bun.spawn([client, '--version'], { stdout:'pipe', stderr:'pipe' })
const version = (await new Response(versionProcess.stdout).text()).trim()
const versionError = await new Response(versionProcess.stderr).text()
assert.equal(await versionProcess.exited, 0, versionError)
assert.equal(version, '2.1.259 (Claude Code)', 'This gate validates the captured 2.1.259 client')
const instance = captureOnly ? undefined : await startProxyServer({port:0,host:'127.0.0.1',silent:true})
const address = instance?.server.address()
const proxyUrl = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : undefined
let source
let sourceRows
let key
const value = `fixture_${crypto.randomUUID()}`
const file = join(root, 'fixture.txt')
writeFileSync(file, value)
const captures=[]
const server=Bun.serve({hostname:'127.0.0.1',port:0, async fetch(req){
 const path=new URL(req.url).pathname
 if(path.endsWith('/count_tokens'))return Response.json({input_tokens:4000})
 if(!path.endsWith('/messages'))return proxyUrl ? fetch(proxyUrl+path,{method:req.method,headers:req.headers,body:req.body,duplex:'half'}) : Response.json({})
 const body=await req.json();captures.push(body)
 if(proxyUrl){
  key=JSON.parse(body.metadata.user_id).session_id
  if(captures.length===2){
   source=lookupSharedSession(key)
   assert(source?.claudeSessionId && source.passthroughToolCallAssistantUuid)
   sourceRows=await getSessionMessages(source.claudeSessionId,{dir:root})
  }
  return fetch(proxyUrl+path,{method:'POST',headers:req.headers,body:JSON.stringify(body),signal:AbortSignal.timeout(120_000)})
 }
 const isResult=body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'))
 const content=isResult?[{type:'text',text:value}]:[{type:'tool_use',id:'toolu_capture',name:'Read',input:{file_path:file}}]
 const stop_reason=isResult?'end_turn':'tool_use'
 const message={id:'msg_capture_'+captures.length,type:'message',role:'assistant',model:body.model,content,stop_reason,stop_sequence:null,usage:{input_tokens:4000,output_tokens:100}}
 if(!body.stream)return Response.json(message)
 const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}}]
 content.forEach((block,index)=>{events.push({type:'content_block_start',index,content_block:block.type==='text'?{type:'text',text:''}:{...block,input:{}}});events.push({type:'content_block_delta',index,delta:block.type==='text'?{type:'text_delta',text:block.text}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});events.push({type:'content_block_stop',index})})
 events.push({type:'message_delta',delta:{stop_reason,stop_sequence:null},usage:{output_tokens:100}},{type:'message_stop'})
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
}})
const env={...process.env,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,ANTHROPIC_API_KEY:'test-loopback-key',CLAUDE_CONFIG_DIR:join(root,'client-config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM:'1'}
for(const key of Object.keys(env))if(key.startsWith('MERIDIAN_')||key.startsWith('CLAUDE_PROXY_')||['CLAUDECODE','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'].includes(key))delete env[key]
let child
try{
 child=Bun.spawn([client,'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','-p',`Read ${file} once and return its contents.`, '--model','claude-opus-4-7','--tools','Read','--allowedTools','Read','--max-turns','3','--output-format','json'],{cwd:root,env,stdout:'pipe',stderr:'pipe'})
 const timer=setTimeout(()=>child.kill(),180_000)
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer)
 writeFileSync(join(root,'requests.json'),JSON.stringify(captures,null,2))
 assert.equal(code, 0, JSON.stringify({out, err}))
 console.log(JSON.stringify({root,code,err,version,mode:captureOnly?'capture':'live',result:JSON.parse(out).result,roles:captures.map(b=>b.messages.map(m=>m.role))}))
 assert(captures.some(b=>b.messages.at(-1)?.role==='system'),'Captured client must emit trailing system message')
 if(!captureOnly){
  assert.equal(captures.length, 2, 'One read must complete in exactly two client requests')
  assert(JSON.parse(out).result.includes(value),'Actual client must return the read fixture')
  assert(source && sourceRows && key)
  const metric=telemetryStore.getRecent({limit:1})[0]
  assert.equal(metric?.isResume,true,'Real Claude Code continuation must resume')
  const current=lookupSharedSession(key)
  assert(current?.claudeSessionId)
  const rows=await getSessionMessages(current.claudeSessionId,{dir:root})
  const reminder=captures[1].messages.at(-1).content
  const texts=typeof reminder==='string'?[reminder]:reminder.map(b=>b.text)
  const userRows=JSON.stringify(rows.filter(row=>row.type==='user'))
  for(const text of texts)assert(userRows.includes(text),'Reminder missing from SDK user content')
  assert.deepEqual(await getSessionMessages(source.claudeSessionId,{dir:root}),sourceRows,'Source history changed')
  child = Bun.spawn([client, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--resume', JSON.parse(out).session_id, '-p', 'Repeat the fixture value you just read. No tools.',
    '--model', 'claude-opus-4-7', '--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '3', '--output-format', 'json'],
    { cwd:root, env, stdout:'pipe', stderr:'pipe' })
  const followupTimer = setTimeout(() => child.kill(), 120_000)
  const [followupCode, followupOut, followupErr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(followupTimer)
  writeFileSync(join(root,'requests.json'),JSON.stringify(captures,null,2))
  const followupMetric = telemetryStore.getRecent({limit:1})[0]
  assert.equal(followupCode, 0, JSON.stringify({followupOut, followupErr}))
  console.log(JSON.stringify({followupCode, followupErr, followupResult:JSON.parse(followupOut).result, isResume:followupMetric?.isResume}))
  assert.equal(captures.length, 3, 'The ordinary follow-up must not call another tool')
  assert(JSON.parse(followupOut).result.includes(value))
  assert.equal(followupMetric?.isResume, true, 'Ordinary real client continuation must also resume')
  const finalMapping = lookupSharedSession(key)
  const finalRows = await getSessionMessages(finalMapping.claudeSessionId, {dir:root})
  const finalReminder = captures.at(-1).messages.at(-1).content
  const finalTexts = typeof finalReminder === 'string' ? [finalReminder] : finalReminder.map(block => block.text)
  const finalUsers = JSON.stringify(finalRows.filter(row => row.type === 'user'))
  for (const text of finalTexts) assert(finalUsers.includes(text), 'Ordinary follow-up reminder missing from SDK user content')
  assert.deepEqual(await getSessionMessages(source.claudeSessionId,{dir:root}),sourceRows)
  console.log(JSON.stringify({result:'PASS',actualClient:true,resume:true,sourceUnchanged:true}))
 }

}finally{child?.kill();server.stop(true);await instance?.close()}
