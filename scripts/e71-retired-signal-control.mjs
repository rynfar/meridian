import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const [beforeArg,repoArg,outArg]=process.argv.slice(2);
if(!beforeArg||!repoArg||!outArg)throw new Error('Explicit before harness, repository and new owned output are required');
const before=resolve(beforeArg),repo=resolve(repoArg),out=resolve(outArg);
mkdirSync(out,{mode:0o700});
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(readFileSync(before))!=='e2f58e5ace65183ed61be17e107545ab3c63b42635d882cdf2f9cdb9a59e0765')throw new Error('Before-source identity changed');
const originalTest=readFileSync(join(repo,'src/__tests__/claude-auto-mode-harness.test.ts'),'utf8');
const results=[];
for(const [arm,harness] of [['before',before],['after',join(repo,'scripts/e2e-claude-code-auto-mode.mjs')]]){
 const dir=join(out,arm);mkdirSync(dir,{mode:0o700});
 const trace=join(dir,'retired-signal-attempt.jsonl'),report=join(dir,'inner-cleanup.json');
 const preload=join(dir,'retired-signal-preload.mjs');
 writeFileSync(preload,`import * as cp from 'node:child_process';import{spyOn}from'bun:test';import{writeFileSync}from'node:fs';const spawn=cp.spawn,kill=process.kill.bind(process),retired=new Map();spyOn(cp,'spawn').mockImplementation((...args)=>{const c=spawn(...args),pid=c.pid,facts={exit:false,close:false,stdoutEnd:!c.stdout,stdoutClose:!c.stdout,stderrEnd:!c.stderr,stderrClose:!c.stderr};c.on('exit',()=>{facts.exit=true;retired.set(pid,facts)});c.on('close',()=>{facts.close=true});for(const n of ['stdout','stderr'])if(c[n]){c[n].on('end',()=>facts[n+'End']=true);c[n].on('close',()=>facts[n+'Close']=true)}return c});spyOn(process,'kill').mockImplementation((pid,signal)=>{if(pid<0&&retired.has(-pid)){writeFileSync(${JSON.stringify(trace)},JSON.stringify({signal,...retired.get(-pid)})+'\\n',{flag:'a',mode:0o600});throw Object.assign(new Error('Synthetic retired-group refusal'),{code:'EPERM'})}return kill(pid,signal)});`,{mode:0o600});
 let test=originalTest.replace("const harness = resolve(import.meta.dir, '../../scripts/e2e-claude-code-auto-mode.mjs')",'const harness = '+JSON.stringify(harness));
 test=test.replace('    let command = commandFor(f, extras, timeout)','    let command = commandFor(f, extras, timeout)\n    command = [command[0]!, \'--preload\', '+JSON.stringify(preload)+', ...command.slice(1)]');
 test=test.replace('    expect(serialized + out + err).not.toContain(\'synthetic-owner-secret\')','    writeFileSync('+JSON.stringify(report)+', JSON.stringify({acceptance: report.acceptance, cleanupFailures: report.cleanupFailures, privateRuntimeRemoved: report.privateRuntimeRemoved, ownedResidualProcesses: report.ownedResidualProcesses, clientProcesses: report.clientProcesses}))\n    expect(serialized + out + err).not.toContain(\'synthetic-owner-secret\')');
 const file=join(dir,'control.test.ts');writeFileSync(file,test,{mode:0o600});
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',E71_CONTEXT_EVIDENCE_DIR:''};
 for(const [key,name]of[['HOME','home'],['CLAUDE_CONFIG_DIR','claude'],['MERIDIAN_CONFIG_DIR','meridian'],['XDG_CONFIG_HOME','xdg']]){const path=join(dir,name);mkdirSync(path,{mode:0o700});env[key]=path}
 const child=spawn(process.execPath,['test','--timeout','30000',file,'-t','joins a hung real synthetic client process'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 const facts={exit:false,close:false,stdoutEnd:false,stdoutClose:false,stderrEnd:false,stderrClose:false};let text='';
 for(const n of ['stdout','stderr']){child[n].on('data',b=>{text+=b.toString()});child[n].once('end',()=>facts[n+'End']=true);child[n].once('close',()=>facts[n+'Close']=true)}
 child.once('exit',()=>facts.exit=true);
 let timedOut=false,spawnError=false;
 const code=await new Promise(r=>{const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},30000);child.once('close',c=>{clearTimeout(timer);facts.close=true;r(c)});child.once('error',()=>{spawnError=true})});
 if(timedOut||spawnError){writeFileSync(join(dir,'outer-failure.json'),JSON.stringify({timedOut,spawnError,facts,scope:'Exact outer handle only; inner descendants/cleanup remain UNKNOWN'}),{mode:0o600});throw new Error('Outer causal control failed; output retained')}
 writeFileSync(join(dir,'test.log'),text,{mode:0o600});
 const inner=JSON.parse(readFileSync(report,'utf8'));
 const signals=(()=>{try{return readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}})();
 if(!Object.values(facts).every(Boolean))throw new Error('Outer process or stdio unjoined');
 results.push({arm,code,outerJoins:facts,inner,retiredSignalAttempts:signals,harnessSha256:hash(readFileSync(harness))});
}
if(results[0].code!==1||!results[0].inner.cleanupFailures.includes('client signal')||!results[0].retiredSignalAttempts.length)throw new Error('Before defect not reproduced');
if(results[1].code!==0||results[1].inner.cleanupFailures.length||!results[1].inner.privateRuntimeRemoved||results[1].retiredSignalAttempts.length)throw new Error('After did not preserve custody assertions');
const receipt={status:'PASS',scope:'Exact old/new harnesses under the same synthetic retired-owned-group EPERM refusal; demonstrates ownership/cleanup path, not the historical OS error or native/model acceptance',results,modelCalls:0};writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
