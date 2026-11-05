import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const body=readFileSync(fileURLToPath(new URL('./probe.cjs', import.meta.url)),'utf8')
const root=mkdtempSync(join(tmpdir(),'agy-probe-forms-')),script=join(root,'probe.cjs')
writeFileSync(script,body,{mode:0o755})
const node=process.env.PROBE_NODE ?? '/Users/rynfar/.hermes/node/bin/node',minimalPath=process.env.PROBE_MINIMAL_PATH ?? '/Users/rynfar/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
const results:unknown[]=[]
for(const [label,executable,args,minimal] of [
 ['original shebang',script,['models'],false],
 ['env node argv','/usr/bin/env',['node',script,'models'],false],
 ['env absolute node argv','/usr/bin/env',[node,script,'models'],false],
 ['original shebang minimal PATH',script,['models'],true],
 ['env node minimal PATH','/usr/bin/env',['node',script,'models'],true],
 ['direct absolute node',node,[script,'models'],false],
] as [string,string,string[],boolean][]) {
 const callsPath=join(root,'calls'),countPath=join(root,'count')
 const beforeCalls=existsSync(callsPath)?readFileSync(callsPath,'utf8'):''
 const env={...process.env,AG_PROBE_ROOT:root,AG_PROBE_MODE:'success',...(minimal?{PATH:minimalPath}:{})}
 const keys=Object.keys(env).sort(),envDigest=digest(keys.map(k=>`${k}=${env[k]}\0`).join(''))
 const start=performance.now(),obs:unknown[]=[]
 const child=spawn(executable,args,{env,stdio:['pipe','pipe','pipe'],detached:true})
 let bytes=0;child.stdout.on('data',b=>bytes+=b.length);child.stderr.on('data',b=>bytes+=b.length);child.stdin.end()
 child.on('spawn',()=>obs.push({kind:'spawn',at:performance.now()-start}))
 child.on('error',e=>obs.push({kind:'error',message:e.message,at:performance.now()-start}))
 function signal(sig:NodeJS.Signals){try{if(child.pid)process.kill(-child.pid,sig)}catch{}}
 let kill:ReturnType<typeof setTimeout>|undefined
 const timeout=setTimeout(()=>{obs.push({kind:'timeout',at:performance.now()-start});signal('SIGTERM');kill=setTimeout(()=>signal('SIGKILL'),50)},1000)
 const outer=setTimeout(()=>{signal('SIGKILL');console.error('unjoined diagnostic child');process.exitCode=2},3000)
 await new Promise<void>(resolve=>child.once('close',(code,sig)=>{
  clearTimeout(timeout);clearTimeout(kill);clearTimeout(outer)
  const calls=existsSync(callsPath)?readFileSync(callsPath,'utf8'):''
  results.push({label,executable,args,cwd:process.cwd(),pid:child.pid,elapsed:performance.now()-start,code,signal:sig,bytes,newCalls:calls.slice(beforeCalls.length),count:existsSync(countPath)?readFileSync(countPath,'utf8'):null,pathDigest:digest(env.PATH??''),envKeyDigest:digest(keys.join('\0')),envDigest,envKeys:keys,observations:obs});resolve()
 }))
}
console.log(JSON.stringify({runtime:{bun:Bun.version,platform:process.platform,arch:process.arch},root,results},null,2))
