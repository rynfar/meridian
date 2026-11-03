import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Exercise the synchronous boundary under stock Node as well as the normal
// Bun certification suite. No global PATH mutation or module mocks.
const scratch = mkdtempSync(join(tmpdir(), "meridian-source-recovery-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
writeFileSync(join(scratch, "package.json"), '{"type":"module"}')
const sourceRoot = resolve(process.env.E2E_BUILD_SOURCE_ROOT ?? ".")
const bundled = await Bun.build({ entrypoints: [join(sourceRoot, "src/proxy/buildSnapshot.ts"), join(sourceRoot, "src/proxy/buildRuntime.ts")], outdir: join(scratch, "dist"), target: "node" })
if (!bundled.success) throw new Error("Could not bundle source recovery probe")
const snapshotModule = pathToFileURL(join(scratch, "dist/buildSnapshot.js")).href
const runtimeModule = pathToFileURL(join(scratch, "dist/buildRuntime.js")).href
const node = Bun.which("node")
if (!node) throw new Error("Stock Node required for recovery subprocess tests")
let serial = 0
function fixture() {
  const root = join(scratch, `fixture-${serial++}`)
  mkdirSync(root)
  writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}')
  writeFileSync(join(root, "input.ts"), "initial\n")
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, timeout: 5000, killSignal: "SIGKILL" })
    if (result.error || result.status !== 0) throw new Error("Fixture Git failed")
    return result.stdout.trim()
  }
  git("init", "-b", "main"); git("add", "."); git("commit", "-m", "fixture")
  return { root, git, sha: git("rev-parse", "HEAD") }
}
function oversized(root: string) {
  const file = join(root, "oversized.bin")
  closeSync(openSync(file, "w")); truncateSync(file, 65 * 1024 * 1024)
}
function probe(code: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(node!, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 12000, killSignal: "SIGKILL" })
  if (result.error || result.status !== 0) throw new Error(`Probe failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}
function runtime(root: string, env = {}, extra = "") {
  return probe(`import {captureBuildRuntime} from ${JSON.stringify(runtimeModule)};
    const loaded=captureBuildRuntime({root:${JSON.stringify(root)}, modulePath:${JSON.stringify(pathToFileURL(join(root, "src/proxy/server.ts")).href)}, env:${JSON.stringify(env)}});
    const info=loaded.info(); ${extra}
    console.log(JSON.stringify({info,status:loaded.status()}));`)
}
function fakeGit(body: string) {
  const bin = join(scratch, `bin-${serial++}`)
  mkdirSync(bin)
  const log = join(bin, "calls.jsonl")
  writeFileSync(join(bin, "git"), `#!${node}\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(4); appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args})+'\\n');
${body}\n`)
  chmodSync(join(bin, "git"), 0o755)
  return { env: { PATH: bin + delimiter + process.env.PATH }, log }
}
// The 400ms boundary is a process timeout, not a Node startup benchmark.
// Install the ignored signal disposition in the shell, then exec finite sleep
// in the SAME pid. No descendant survives the direct child's timeout/join.
function finiteTermResistantGit() {
  const bin = join(scratch, `bin-${serial++}`)
  mkdirSync(bin)
  const log = join(bin, "calls.jsonl")
  const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(bin, "git"), `#!/bin/sh
trap '' TERM
printf '{"pid":%s,"args":[]}\\n' "$$" >> ${quotedLog}
printf 'READY\\n'
exec /bin/sleep 1.5
`)
  chmodSync(join(bin, "git"), 0o755)
  return { env: { PATH: bin + delimiter + process.env.PATH }, log }
}
function joined(log: string) {
  const calls: { pid: number, args: string[] }[] = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
  for (const call of calls) {
    let alive = false
    try { process.kill(call.pid, 0); alive = true }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error }
    expect(alive).toBe(false)
  }
  return calls
}
const stale = { MERIDIAN_BUILD_SHA: "stale-sha", MERIDIAN_BUILD_BRANCH: "stale-branch", MERIDIAN_BUILD_DIRTY: "0" }

// The controlled Git programs use POSIX shebang executables. Keep this
// platform qualification explicit for contributors running npm test on Windows.
// Existing certification tests retain the platform-neutral source controls.
describe.skipIf(process.platform === "win32")("bounded source identity recovery", () => {
  test("detached recovery replaces the entire conflicting launcher identity and stays immutable", () => {
    const { root, sha, git } = fixture()
    git("checkout", "--detach"); oversized(root)
    const result = runtime(root, stale, `import {writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
      writeFileSync(${JSON.stringify(join(root, "input.ts"))},'edited');
      execFileSync('git',['-C',${JSON.stringify(root)},'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-am','head moved']);
      if(JSON.stringify(info)!==JSON.stringify(loaded.info())) throw Error('identity changed');`)
    expect(result.info.sha).toBe(sha)
    expect(result.info.branch).toBeUndefined()
    expect(result.info.dirty).toBe(true)
    expect(result.info.sourceHash).toBeUndefined()
    expect(result.status.state).toBe("unknown")
    expect(result.status.latest).toBeUndefined()
  })
  test("failed status never inherits a stale clean flag with a recovered SHA", () => {
    const { root, sha } = fixture()
    const fake = fakeGit(`if(args[0]==='status') process.exit(1);
if(args[1]==='--show-toplevel') console.log(${JSON.stringify(root)});
else if(args[1]==='HEAD') console.log(${JSON.stringify(sha)});
else if(args[1]==='--abbrev-ref') console.log('main'); else process.exit(1);`)
    const result = probe(`import {captureBuildRuntime} from ${JSON.stringify(runtimeModule)};
console.log(JSON.stringify(captureBuildRuntime({root:${JSON.stringify(root)},modulePath:'file:///source/src/server.ts',env:${JSON.stringify(stale)}}).info()));`, fake.env)
    expect(result.sha).toBe(sha)
    expect(result.branch).toBe("main")
    expect(result.dirty).toBeUndefined()
    expect(result.sourceHash).toBeUndefined()
    joined(fake.log)
  })
  test("total recovery failure retains launcher fallback unchanged", () => {
    const result = runtime(join(scratch, "missing"), stale)
    expect(result.info).toMatchObject({ sha: "stale-sha", branch: "stale-branch", dirty: false })
    expect(result.status.state).toBe("unknown")
  })
  test("small source still fingerprints, compares disk, and ignores conflicting env", () => {
    const { root, sha } = fixture()
    const result = runtime(root, stale, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "input.ts"))},'changed');`)
    expect(result.info).toMatchObject({ sha, branch: "main", dirty: false })
    expect(result.info.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.status.state).toBe("source-changed")
  })
  test("canonical root guard rejects an unrelated parent repository", () => {
    const { root } = fixture()
    const nested = join(root, "nested"); mkdirSync(nested)
    writeFileSync(join(nested, "package.json"), '{"version":"1.2.3"}')
    const result = runtime(nested)
    expect(result.info.sha).toBeUndefined()
    expect(result.status.state).toBe("unknown")
  })
  test("recovered links accept a public forge but reject credential-bearing URLs", () => {
    const { root, sha, git } = fixture(); oversized(root)
    git("remote", "add", "origin", "https://github.com/example/meridian.git")
    expect(runtime(root).info).toMatchObject({ commitUrl: `https://github.com/example/meridian/commit/${sha}`, branchUrl: "https://github.com/example/meridian/tree/main" })
    git("remote", "set-url", "origin", "https://user:secret@example.invalid/private.git")
    expect(runtime(root).info.commitUrl).toBeUndefined()
  })
  test("slow optional Git facts share one recovery budget after root and SHA", () => {
    const { root, sha } = fixture()
    const fake = fakeGit(`process.on('SIGTERM',()=>{});
setTimeout(()=>{if(args[1]==='--show-toplevel') console.log(${JSON.stringify(root)});
else if(args[1]==='HEAD') console.log(${JSON.stringify(sha)});
else if(args[1]==='--abbrev-ref') console.log('main'); else console.log('');},600);`)
    const result = probe(`import {sourceIdentity} from ${JSON.stringify(snapshotModule)};
const start=performance.now(); const info=sourceIdentity(${JSON.stringify(root)}); console.log(JSON.stringify({info,elapsed:performance.now()-start}));`, fake.env)
    const calls = joined(fake.log)
    console.log(JSON.stringify({ case: "shared-recovery-budget", ...result, calls: calls.map(call => call.args), directChildrenJoined: true }))
    expect(result.info.sha).toBe(sha)
    expect(result.info.branch).toBeUndefined()
    expect(result.info.dirty).toBeUndefined()
    expect(result.elapsed).toBeLessThan(2500)
    expect(calls.slice(0, 2).map(call => call.args)).toEqual([["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"]])
    expect(calls.filter(call => call.args[0] === "status")).toHaveLength(1)
    expect(calls.length).toBeLessThanOrEqual(5)
  }, 12000)
  test("an exhausted root deadline does not start subsequent Git commands", () => {
    const { root } = fixture()
    const fake = fakeGit(`process.on('SIGTERM',()=>{}); setTimeout(()=>console.log(${JSON.stringify(root)}),3000);`)
    const result = probe(`import {sourceIdentity} from ${JSON.stringify(snapshotModule)};
const start=performance.now(); let rejected=false; try{sourceIdentity(${JSON.stringify(root)})}catch(error){rejected=error instanceof Error}
console.log(JSON.stringify({rejected,elapsed:performance.now()-start}));`, fake.env)
    const calls = joined(fake.log)
    console.log(JSON.stringify({ case: "exhausted-root", ...result, calls: calls.map(call => call.args), directChildrenJoined: true }))
    expect(result.rejected).toBe(true)
    expect(result.elapsed).toBeLessThan(2500)
    expect(calls).toHaveLength(1)
  }, 12000)
  test("TERM-resistant finite Git cannot turn a timeout into clean success", () => {
    const fake = finiteTermResistantGit()
    // A default-SIGTERM control needs its ignored disposition installed first.
    // Host scheduling before the shell's trap is not the timeout behavior under test.
    const control = probe(`import {spawn} from 'node:child_process';
import {once} from 'node:events';
const child=spawn('git',[],{stdio:['ignore','pipe','pipe']});
const closed=once(child,'close');let output='';child.stderr.resume();
const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY\\n'))resolve();});closed.then(()=>reject(Error('fixture exited before readiness')));});
const limit=setTimeout(()=>child.kill('SIGKILL'),5000);let term;
try{await ready;const start=performance.now();term=setTimeout(()=>child.kill('SIGTERM'),400);const[status,signal]=await closed;console.log(JSON.stringify({status,signal,elapsed:performance.now()-start,ready:true}));}
finally{clearTimeout(term);clearTimeout(limit);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}`, fake.env)
    expect(control.ready).toBe(true)
    expect(control.status).toBe(0)
    expect(control.signal).toBeNull()
    expect(control.elapsed).toBeGreaterThanOrEqual(1200)
    const result = probe(`import {gitOutput} from ${JSON.stringify(snapshotModule)};
const start=performance.now(); let rejected=false; try{gitOutput(${JSON.stringify(scratch)},['rev-parse','HEAD'],400)}catch(error){rejected=error instanceof Error}
console.log(JSON.stringify({rejected,elapsed:performance.now()-start}));`, fake.env)
    const calls = joined(fake.log)
    console.log(JSON.stringify({ case: "term-resistant-git", ...result, calls: calls.map(call => call.args), directChildrenJoined: true }))
    expect(result.rejected).toBe(true)
    expect(result.elapsed).toBeLessThan(1000)
    expect(calls).toHaveLength(2)
  })
  test("fingerprint Git boundary also kills and rejects TERM-resistant timeouts", () => {
    const { root } = fixture()
    const fake = fakeGit(`process.on('SIGTERM',()=>{}); setTimeout(()=>console.log(${JSON.stringify(root)}),3000);`)
    const result = probe(`import {snapshotSource} from ${JSON.stringify(snapshotModule)};
const start=performance.now(); let rejected=false; try{snapshotSource(${JSON.stringify(root)})}catch(error){rejected=error instanceof Error}
console.log(JSON.stringify({rejected,elapsed:performance.now()-start}));`, fake.env)
    const calls = joined(fake.log)
    console.log(JSON.stringify({ case: "fingerprint-timeout", ...result, calls: calls.map(call => call.args), directChildrenJoined: true }))
    expect(result.rejected).toBe(true)
    expect(result.elapsed).toBeLessThan(2500)
    expect(calls).toHaveLength(1)
  }, 12000)
})
