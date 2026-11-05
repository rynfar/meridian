import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const entry=process.env.E2E_PACKAGED_CLI;
assert(entry?.startsWith('/'));
const root=mkdtempSync(join(tmpdir(),'meridian-packaged-cli-'));const rows=[];
const call=(command,args=[])=>{const r=spawnSync(process.execPath,[entry,command,'--session-dir',root,'--json',...args],{encoding:'utf8',timeout:15000,killSignal:'SIGKILL'});assert(!r.error,'Packaged CLI spawn failed');const data=JSON.parse(r.stdout);rows.push({command,exit:r.status,phase:data.phase});return{exit:r.status,data};};
const ok=(command,args=[])=>{const r=call(command,args);assert.equal(r.exit,0);return r.data;};
try{
 writeFileSync(join(root,'sessions.json'),'{}',{mode:0o600});writeFileSync(join(root,'session-gc.json'),'"BAD"'.replace('"BAD"','{"version":1,"resources":{}}'),{mode:0o600});
 const before=readdirSync(root).sort();assert.equal(ok('inspect').phase,'legacy');assert.deepEqual(readdirSync(root).sort(),before);
 assert.equal(call('migrate').exit,2);assert.equal(call('export-json').exit,3);assert.equal(call('abort-migration').exit,3);assert.deepEqual(readdirSync(root).sort(),before);
 const first=ok('migrate',['--writers-stopped']);assert.equal(first.phase,'ready');assert.equal(call('abort-migration').exit,4);
 assert.equal(ok('migrate',['--writers-stopped']).migration_id,first.migration_id);assert.equal(ok('inspect').phase,'ready');
 assert.equal(ok('export-json').phase,'exported');assert.equal(ok('export-json').phase,'exported');
 const second=ok('migrate',['--writers-stopped']);assert.notEqual(second.migration_id,first.migration_id);assert.equal(second.archived_cycles,1);assert.equal(second.cycle_number,2);
 console.log(JSON.stringify({result:'PASS',scope:'independently installed tarball actual packaged Node CLI, no models',node:process.version,rows,cycles:2}));
}finally{rmSync(root,{recursive:true,force:true});}
