import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

test("installed-runtime Node preserves private admission and bounded log behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-detached-node-"))
  try {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../cli/detachedProtocol.ts"), resolve(import.meta.dir, "../cli/detachedLog.ts"), resolve(import.meta.dir, "../cli/detachedControl.ts")],
      outdir: root, target: "node",
    })
    expect(result.success).toBe(true)
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await writeFile(join(root, "probe.mjs"), `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {finished} from 'node:stream/promises';
import {DetachedRequestFrame, authenticatesDetachedRequest, DetachedLifecycle, parseDetachedRequest} from './detachedProtocol.js';
import {DetachedLog} from './detachedLog.js';
import {listenDetachedControl,requestDetachedControl} from './detachedControl.js';
const id={instanceId:'12'.repeat(16),nonce:'ab'.repeat(32)};
const request={version:1,action:'stop',...id};
const wire=Buffer.from(JSON.stringify(request)+'\\n');
const frame=new DetachedRequestFrame();
assert.equal(frame.push(wire.subarray(0,20)),undefined);
assert.equal(authenticatesDetachedRequest(frame.push(wire.subarray(20)),id),true);
assert.equal(parseDetachedRequest({...request,nonce:id.nonce+'\\n'}),undefined);
assert.throws(()=>frame.push(wire));
const lifecycle=new DetachedLifecycle();
assert.equal(lifecycle.stop(),true);assert.equal(lifecycle.stop(),false);assert.equal(lifecycle.ready(),false);
const log=await DetachedLog.create(fileURLToPath(new URL('./out.log',import.meta.url)),8);
const complete=finished(log);log.end('11111111222222223333');await complete;
assert.equal(await readFile(new URL('./out.log.1',import.meta.url),'utf8'),'22222222');
assert.equal(await readFile(new URL('./out.log',import.meta.url),'utf8'),'3333');
const slash=String.fromCharCode(92);
const socketPath=process.platform==='win32' ? slash+slash+'.'+slash+'pipe'+slash+'meridian-bundle-'+process.pid : fileURLToPath(new URL('./control.sock',import.meta.url));
let stops=0;
const controller=new DetachedLifecycle();controller.ready();
const server=await listenDetachedControl({path:socketPath,identity:id,lifecycle:controller,onStop:()=>{stops++},onError:error=>{throw error}});
try {
 const replies=await Promise.all([requestDetachedControl(socketPath,request),requestDetachedControl(socketPath,request)]);
 assert.equal(stops,1);assert.equal(replies.filter(x=>x.accepted).length,1);
 assert.equal(replies.every(x=>x.phase==='draining'),true);
} finally {await server.close();}
console.log(JSON.stringify({runtime:process.version,platform:process.platform,controls:12}));
`)
    const child = spawnSync("node", [join(root, "probe.mjs")], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    expect(JSON.parse(child.stdout).controls).toBe(12)
  } finally { await rm(root, { recursive: true, force: true }) }
})
