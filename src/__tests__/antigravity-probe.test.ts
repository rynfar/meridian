import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgProbe } from '../proxy/backends/antigravityProbe'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(mode = 'once', settings?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'agy-probe-')); roots.push(root)
  const executable = join(root, 'probe.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const root = process.env.AG_PROBE_ROOT, mode = process.env.AG_PROBE_MODE;
const log = path.join(root, 'calls');
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');
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
   console.log(process.argv[2] === 'models' ? 'gemini-test\\tGemini Test' : mode === 'malformed' ? 'not-json' : JSON.stringify({command:{data:{config:settings}}}));
 }
}
`, { mode: 0o755 })
  const env = { ...process.env, AG_PROBE_ROOT: root, AG_PROBE_MODE: mode, AG_PROBE_SETTINGS: settings === undefined ? '' : JSON.stringify(settings) }
  const controller = new AbortController()
  return { executable, env, controller, options: { env, signal: controller.signal, timeoutMs: 1000, killGraceMs: 50 }, ready: () => existsSync(join(root, 'count')), calls: () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; pid: number }) }
}

describe.skipIf(process.platform === 'win32')('Antigravity read-only subscription probes', () => {
  for (const mode of ['once', 'stubborn']) it(`retries one timeout only after the ${mode} process exits`, async () => {
    const f = fixture(mode)
    expect(await readAgProbe(f.executable, 'configuration', f.options)).toContain('customModelsConfig')
    expect(f.calls()).toHaveLength(2)
  })
  for (const mode of ['once', 'stubborn']) it(`retries model discovery only after the ${mode} process exits`, async () => {
    const f = fixture(mode)
    expect(await readAgProbe(f.executable, 'models', f.options)).toContain('gemini-test')
    expect(f.calls().map(call => call.args)).toEqual([['models'], ['models']])
  })
  it('does not retry model discovery exits and bounds repeated timeouts', async () => {
    for (const mode of ['exit', 'always']) {
      const f = fixture(mode)
      await expect(readAgProbe(f.executable, 'models', f.options)).rejects.toThrow(mode === 'exit' ? 'reason=exit, attempt=1' : 'reason=timeout, attempt=2')
      expect(f.calls()).toHaveLength(mode === 'exit' ? 1 : 2)
    }
  })
  it('joins cancelled model discovery without retrying', async () => {
    const f = fixture('always')
    const pending = readAgProbe(f.executable, 'models', { ...f.options, timeoutMs: 3000 })
    for (let attempt = 0; attempt < 200 && !f.ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.ready()).toBe(true)
    f.controller.abort()
    await expect(pending).rejects.toThrow('reason=cancelled')
    expect(f.calls()).toHaveLength(1)
    expect(() => process.kill(f.calls()[0]!.pid, 0)).toThrow()
  })
  it('cools down failed account probes without spawning or treating old authorization as valid', async () => {
    const f = fixture('exit'), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      await expect(runtime.verifyAccount()).rejects.toThrow('reason=exit')
      const count = f.calls().length
      runtime.childEnv.AG_PROBE_MODE = 'success'
      await expect(runtime.verifyAccount()).rejects.toMatchObject({ status: 503, retryAfter: 5 })
      expect(f.calls()).toHaveLength(count)
      await new Promise(resolve => setTimeout(resolve, 5050))
      await runtime.verifyAccount()
      await runtime.verifyAccount()
      expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(3)
    } finally { await runtime.close() }
  }, 15000)
  it('also cools down model discovery failures before another account or model probe', async () => {
    const f = fixture('models-exit'), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      await expect(runtime.availableModels()).rejects.toThrow('model discovery check failed')
      const count = f.calls().length
      await expect(runtime.availableModels()).rejects.toThrow('cooling down')
      await expect(runtime.verifyAccount()).rejects.toThrow('cooling down')
      expect(f.calls()).toHaveLength(count)
    } finally { await runtime.close() }
  })
  it('uses the bounded discovery probe after account validation and coalesces callers', async () => {
    const f = fixture('success'), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      expect(await Promise.all([runtime.availableModels(), runtime.availableModels()])).toEqual([['gemini-test'], ['gemini-test']])
      expect(f.calls().map(call => call.args[0])).toEqual(['--version', '-p', 'models'])
    } finally { await runtime.close() }
  })
  it('stops after two timeouts with classified output-free diagnostics', async () => {
    const f = fixture('always')
    await expect(readAgProbe(f.executable, 'configuration', f.options)).rejects.toThrow('reason=timeout, attempt=2')
    expect(f.calls()).toHaveLength(2)
  })
  for (const mode of ['exit', 'overflow']) it(`does not retry ${mode} or expose command output`, async () => {
    const f = fixture(mode)
    let message = ''
    try { await readAgProbe(f.executable, 'configuration', f.options) } catch (error) { message = String(error) }
    expect(message).toContain(mode === 'exit' ? 'reason=exit' : 'reason=output-limit')
    expect(message).not.toContain('PRIVATE_CONFIGURATION')
    expect(f.calls()).toHaveLength(1)
  })
  it('joins cancellation without retrying', async () => {
    const f = fixture('always')
    const pending = readAgProbe(f.executable, 'configuration', { ...f.options, timeoutMs: 3000 })
    for (let attempt = 0; attempt < 100 && !f.ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.ready()).toBe(true)
    f.controller.abort()
    await expect(pending).rejects.toThrow('reason=cancelled')
    expect(f.calls()).toHaveLength(1)
    expect(() => process.kill(f.calls()[0]!.pid, 0)).toThrow()
  })
  it('does not spawn for an already cancelled probe', async () => {
    const f = fixture()
    f.controller.abort()
    await expect(readAgProbe(f.executable, 'configuration', f.options)).rejects.toThrow('cancelled')
    expect(f.ready()).toBe(false)
  })
  it('does not retry a missing executable', async () => {
    const f = fixture()
    await expect(readAgProbe(f.executable + '-missing', 'configuration', f.options)).rejects.toThrow('reason=spawn, attempt=1')
    expect(f.ready()).toBe(false)
  })
  it('joins a running account check on runtime shutdown without retrying', async () => {
    const f = fixture('always'), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    const pending = runtime.verifyAccount().then(() => '', error => String(error))
    try {
      for (let attempt = 0; attempt < 200 && !f.ready(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(f.ready()).toBe(true)
    } finally { await runtime.close() }
    expect(await pending).toContain('reason=cancelled')
    expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(1)
  })
  it('shares simultaneous account checks, without caching the validation for later requests', async () => {
    const f = fixture('success'), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      await Promise.all([runtime.verifyAccount(), runtime.verifyAccount(), runtime.verifyAccount()])
      expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(1)
      await runtime.verifyAccount()
      expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(2)
    } finally { await runtime.close() }
  })
  it('accepts explicit false credits in default settings and rechecks account authorization', async () => {
    const f = fixture('success', { customModelsConfig: {}, modelProvider: '', useG1Credits: false })
    const runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      await runtime.verifyAccount()
      expect(await runtime.availableModels()).toEqual(['gemini-test'])
      await runtime.verifyAccount()
      expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(3)
      expect(f.calls().filter(call => call.args[0] === 'models')).toHaveLength(1)
      expect(runtime.runs.size).toBe(0)
    } finally { await runtime.close() }
  })
  it('accepts the observed 1.2.7 default settings shape with explicit false credits', async () => {
    const f = fixture('success', { customModelsConfig: null, modelProvider: '', useG1Credits: false, gcp: null })
    const runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      expect(await runtime.availableModels()).toEqual(['gemini-test'])
      expect(runtime.cliVersion).toBe('1.2.7')
      expect(f.calls().map(call => call.args[0])).toEqual(['--version', '-p', 'models'])
      expect(runtime.runs.size).toBe(0)
    } finally { await runtime.close() }
  })
  const invalidCredits = [
    { label: 'absent', settings: { customModelsConfig: {}, modelProvider: '' } },
    ...[null, 0, ''].map(useG1Credits => ({ label: JSON.stringify(useG1Credits), settings: { customModelsConfig: {}, modelProvider: '', useG1Credits } })),
  ]
  for (const { label, settings } of invalidCredits) {
    for (const operation of ['account validation', 'model discovery', 'generation admission']) {
      it(`rejects ${label} credits before ${operation} without retrying invalid configuration`, async () => {
        const f = fixture('success', settings), runtime = new AntigravityRuntime({ executable: f.executable })
        Object.assign(runtime.childEnv, f.env)
        try {
          const pending = operation === 'account validation' ? runtime.verifyAccount()
            : operation === 'model discovery' ? runtime.availableModels()
            : runtime.create(parseAgRequest({ model: 'gemini-test', messages: [{ role: 'user', content: 'Fixture admission check' }] }))
          await expect(pending).rejects.toThrow()
          expect(f.calls().map(call => call.args[0])).toEqual(['--version', '-p'])
          expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(1)
          expect(runtime.runs.size).toBe(0)
          expect(runtime.preparing).toBe(0)
        } finally { await runtime.close() }
      })
    }
    it(`freshly verifies corrected explicit false settings after rejecting ${label} credits`, async () => {
      const f = fixture('success', settings), runtime = new AntigravityRuntime({ executable: f.executable })
      Object.assign(runtime.childEnv, f.env)
      try {
        await expect(runtime.verifyAccount()).rejects.toThrow()
        expect(f.calls().map(call => call.args[0])).toEqual(['--version', '-p'])
        runtime.childEnv.AG_PROBE_SETTINGS = JSON.stringify({ customModelsConfig: {}, modelProvider: '', useG1Credits: false })
        await runtime.verifyAccount()
        expect(f.calls().map(call => call.args[0])).toEqual(['--version', '-p', '--version', '-p'])
        expect(await runtime.availableModels()).toEqual(['gemini-test'])
        expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(3)
        expect(f.calls().filter(call => call.args[0] === 'models')).toHaveLength(1)
        expect(runtime.runs.size).toBe(0)
      } finally { await runtime.close() }
    })
  }
  for (const mode of ['version', 'provider', 'paid', 'malformed']) it(`does not retry invalid ${mode} validation`, async () => {
    const f = fixture(mode), runtime = new AntigravityRuntime({ executable: f.executable })
    Object.assign(runtime.childEnv, f.env)
    try {
      await expect(runtime.verifyAccount()).rejects.toThrow()
      expect(f.calls().filter(call => call.args[1] === '/config')).toHaveLength(mode === 'version' ? 0 : 1)
      expect(runtime.runs.size).toBe(0)
    } finally { await runtime.close() }
  })
})
