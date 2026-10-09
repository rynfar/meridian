import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readCertifiedBuild } from '/opt/e71/candidate/src/proxy/buildArtifacts.ts'
const s='/opt/e71/candidate',i='/opt/e41-package/installed/node_modules/@rynfar/meridian',head='15f44351bbc8ddfd669db3254eac86736b61a02e'
const run=(command,args,cwd)=>{const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:30000});assert.equal(r.status,0);return r.stdout.trim()}
assert.equal(run('git',['rev-parse','HEAD'],s),head);assert.equal(run('git',['status','--short'],s),'')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const manifest=readCertifiedBuild(s);assert.equal(manifest.build.sha,head);assert.equal(manifest.build.dirty,false);assert.equal(manifest.build.certification,'verified')
const sourceRows=JSON.parse(fs.readFileSync('/proof/CLONE_QUALIFICATION.json','utf8')).allRows
for(const row of sourceRows){const b=fs.readFileSync(join(s,row.path));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256)}
function files(root,rel=''){return fs.readdirSync(join(root,rel),{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(root,join(rel,x.name)):(assert(x.isFile()),[join(rel,x.name)])).sort()}
const src=files(join(s,'dist')),installed=files(join(i,'dist'));assert.deepEqual(src,installed)
const rows=src.map(path=>{const a=fs.readFileSync(join(s,'dist',path)),b=fs.readFileSync(join(i,'dist',path));assert(a.equals(b));if(path!=='build-provenance.json')assert.equal(sha(a),manifest.artifacts[path]);return {path,bytes:a.length,sha256:sha(a)}})
assert.equal(Object.keys(manifest.artifacts).length,rows.length-1)
const tars=fs.readdirSync('/opt/e41-package').filter(x=>x.endsWith('.tgz'));assert.equal(tars.length,1)
const sourceSdk=JSON.parse(fs.readFileSync(join(s,'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),'utf8')).version,installedSdk=JSON.parse(fs.readFileSync('/opt/e41-package/installed/node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8')).version
const sourceCli=run(join(s,'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),['--version'],s),installedCli=run('/opt/e41-package/installed/node_modules/@anthropic-ai/claude-code/bin/claude.exe',['--version'],s)
assert.equal(sourceSdk,'0.2.141');assert.equal(installedSdk,'0.2.141');assert.equal(sourceCli,'2.1.284 (Claude Code)');assert.equal(installedCli,'2.1.295 (Claude Code)')
const record={head,sourceClean:true,certifiedBuild:manifest.build,trackedSourceRowsMatched:sourceRows.length,compiledFileCount:rows.length,allCompiledRows:rows,tarballSHA256:sha(fs.readFileSync('/opt/e41-package/'+tars[0])),sourceEntry:join(s,'dist/server.js'),installedEntry:join(i,'dist/server.js'),sourceSdk,installedSdk,sourceCli,installedCli,qualification:'Fresh Linux build, complete tracked snapshot and certified catalog, independent tarball install with explicitly pinned own SDK141/backend295. No external model or actual client acceptance. Only tests changed after this image head.'}
fs.writeFileSync('/proof/FRESH_PACKAGE_QUALIFICATION.json',JSON.stringify(record,null,2)+'\n')
console.log(JSON.stringify({...record,allCompiledRows:undefined}))
