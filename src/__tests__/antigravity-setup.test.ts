import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { parseAntigravitySetupArgs, setupAntigravityClient } from '../proxy/antigravitySetup'
const directories: string[] = []
const entry = new URL('../../bin/cli.ts', import.meta.url).href
function directory() { const path = mkdtempSync(join(tmpdir(), 'meridian-agy-setup-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const defaults = { url: 'http://127.0.0.1:3456/antigravity/v1/', model: 'gemini-3.8-flash-low' }

describe('Antigravity client setup', () => {
  it('preserves OpenCode JSONC, other providers, permissions and defaults; reruns without edits', () => {
    const configDir = directory(), path = join(configDir, 'opencode.jsonc')
    const original = '{\n// keep this comment\n"model":"claude/opus", "permission":{"edit":"ask"}, "provider":{"other":{"name":"keep"}},\n}\n'
    writeFileSync(path, original)
    const result = setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)
    const text = readFileSync(path, 'utf8'), config = parse(text)
    expect(text).toContain('// keep this comment')
    expect(config.model).toBe('claude/opus')
    expect(config.permission).toEqual({ edit: 'ask' })
    expect(config.provider.other).toEqual({ name: 'keep' })
    expect(config.provider['meridian-agy'].options.baseURL).toBe('http://127.0.0.1:3456/antigravity/v1')
    expect(readFileSync(result.backups[0]!, 'utf8')).toBe(original)
    expect(readFileSync(result.integrationPath, 'utf8')).toContain('streamSafely')
    const again = setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)
    expect(again.changed).toEqual([])
    expect(again.backups).toEqual([])
  })
  it('writes Pi setup where Pi reads a PI_CODING_AGENT_DIR with a leading ~', () => {
    const home = directory(), cwd = directory()
    const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() }
    process.env.PI_CODING_AGENT_DIR = '~/pi-agent'
    process.chdir(cwd)
    try {
      const result = setupAntigravityClient({ ...defaults, client: 'pi' }, entry, home)
      expect(result.configPath).toBe(join(home, 'pi-agent', 'models.json'))
      expect(result.integrationPath).toBe(join(home, 'pi-agent', 'extensions', 'meridian-antigravity.js'))
      expect(JSON.parse(readFileSync(result.configPath, 'utf8')).providers['meridian-agy'].models).toHaveLength(1)
      expect(readdirSync(cwd)).toEqual([])
    } finally {
      process.chdir(saved.cwd)
      if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir
    }
  })
  it('adds Pi model and extension while preserving other models; changes defaults only explicitly', () => {
    const configDir = directory()
    writeFileSync(join(configDir, 'models.json'), JSON.stringify({ providers: { other: { apiKey: 'keep' }, 'meridian-agy': { apiKey: 'existing-key', models: [{ id: 'other-model', name: 'keep' }] } } }))
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ defaultProvider: 'claude', theme: 'dark' }))
    const result = setupAntigravityClient({ ...defaults, client: 'pi', configDir }, entry)
    expect(JSON.parse(readFileSync(result.configPath, 'utf8')).providers['meridian-agy'].models).toHaveLength(2)
    expect(JSON.parse(readFileSync(result.configPath, 'utf8')).providers['meridian-agy'].apiKey).toBe('existing-key')
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).defaultProvider).toBe('claude')
    setupAntigravityClient({ ...defaults, client: 'pi', configDir, setDefault: true, apiKeyEnv: 'LOCAL_MERIDIAN_KEY' }, entry)
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual({ defaultProvider: 'meridian-agy', defaultModel: defaults.model, defaultThinkingLevel: 'off', theme: 'dark' })
    expect(JSON.parse(readFileSync(result.configPath, 'utf8')).providers['meridian-agy'].apiKey).toBe('LOCAL_MERIDIAN_KEY')
  })
  it('writes environment references without reading or copying credentials', () => {
    const configDir = directory()
    const result = setupAntigravityClient({ ...defaults, client: 'opencode', configDir, apiKeyEnv: 'LOCAL_MERIDIAN_KEY', setDefault: true }, entry)
    const config = parse(readFileSync(result.configPath, 'utf8'))
    expect(config.provider['meridian-agy'].options.apiKey).toBe('{env:LOCAL_MERIDIAN_KEY}')
    expect(config.model).toBe(`meridian-agy/${defaults.model}`)
    expect(config.small_model).toBe(config.model)
  })
  it('rejects invalid configuration, policies and duplicate sibling providers before any writes', () => {
    for (const value of ['not json', '[]', '{"provider":[]}', '{"provider":{"meridian-agy":{"models":[]}}}', '{"enabled_providers":["claude"]}', '{"disabled_providers":["meridian-agy"]}']) {
      const configDir = directory(), path = join(configDir, 'opencode.json')
      writeFileSync(path, value)
      expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(value)
      expect(readdirSync(configDir)).toEqual(['opencode.json'])
    }
    const configDir = directory()
    writeFileSync(join(configDir, 'opencode.json'), '{}')
    writeFileSync(join(configDir, 'opencode.jsonc'), '{"provider":{"meridian-agy":{}}}')
    expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)).toThrow('duplicate')
    expect(readdirSync(configDir).sort()).toEqual(['opencode.json', 'opencode.jsonc'])
    writeFileSync(join(configDir, 'opencode.jsonc'), '{"disabled_providers":["meridian-agy"]}')
    expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)).toThrow('excludes')
    expect(readFileSync(join(configDir, 'opencode.json'), 'utf8')).toBe('{}')
  })
  it('refuses unmanaged integration files and configuration symlinks', () => {
    const configDir = directory(); mkdirSync(join(configDir, 'plugins'))
    writeFileSync(join(configDir, 'plugins', 'meridian-antigravity.js'), 'user code')
    expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)).toThrow('Unmanaged')
    const second = directory(); writeFileSync(join(second, 'original.json'), '{}'); symlinkSync(join(second, 'original.json'), join(second, 'opencode.json'))
    expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir: second }, entry)).toThrow('non-regular')
    expect(readFileSync(join(second, 'original.json'), 'utf8')).toBe('{}')
  })
  it('refuses an older manually installed retry integration before creating configuration', () => {
    const configDir = directory(); mkdirSync(join(configDir, 'plugins'))
    writeFileSync(join(configDir, 'plugins', 'retry.js'), '// OpenCode V1 plugin: use a provider named meridian-agy.\nexport default () => ({})')
    expect(() => setupAntigravityClient({ ...defaults, client: 'opencode', configDir }, entry)).toThrow('manual copy')
    expect(readdirSync(configDir)).toEqual(['plugins'])
  })
  it('requires explicit client, model and URL and rejects ambiguous CLI options', () => {
    const args = ['--antigravity', '--client', 'pi', '--url', defaults.url, '--model', defaults.model]
    expect(parseAntigravitySetupArgs(args).client).toBe('pi')
    for (const extra of [['--v2'], ['--client', 'opencode'], ['--api-key-env']]) expect(() => parseAntigravitySetupArgs([...args, ...extra])).toThrow()
    expect(() => parseAntigravitySetupArgs(['--antigravity'])).toThrow('Choose')
    expect(() => setupAntigravityClient({ ...defaults, url: 'http://name:secret@localhost', client: 'pi', configDir: directory() }, entry)).toThrow('without credentials')
  })
})
