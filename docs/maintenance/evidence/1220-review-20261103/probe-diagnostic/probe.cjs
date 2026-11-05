#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const root = process.env.AG_PROBE_ROOT, mode = process.env.AG_PROBE_MODE;
const log = path.join(root, 'calls');
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\n');
if(process.argv[2] === '--version') { console.log(mode === 'version' ? 'unsupported' : '1.2.7'); }
else {
 const counter=path.join(root,'count'); const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;
 fs.writeFileSync(counter,String(count+1));
 if (mode === 'exit' || (mode === 'models-exit' && process.argv[2] === 'models')) { console.error('PRIVATE_CONFIGURATION'); process.exitCode=2; }
 else if (mode === 'overflow') { console.log('PRIVATE_CONFIGURATION'.repeat(60000)); }
 else if (mode === 'always' || ((mode === 'once' || mode === 'stubborn') && count === 0)) {
   fs.writeFileSync(path.join(root,'old-pid'),String(process.pid));
   if(mode === 'stubborn') process.on('SIGTERM',()=>{});
   setInterval(()=>{},1000);
 } else {
   if(fs.existsSync(path.join(root,'old-pid'))) {
     const old=Number(fs.readFileSync(path.join(root,'old-pid'),'utf8'));
     try {process.kill(old,0);process.exit(43);} catch(e) {if(e.code !== 'ESRCH') throw e;}
   }
   const settings=process.env.AG_PROBE_SETTINGS ? JSON.parse(process.env.AG_PROBE_SETTINGS) : {customModelsConfig:{},modelProvider:mode === 'provider' ? 'api' : '',useG1Credits:mode === 'paid'};
   console.log(process.argv[2] === 'models' ? 'gemini-test\tGemini Test' : mode === 'malformed' ? 'not-json' : JSON.stringify({command:{data:{config:settings}}}));
 }
}
