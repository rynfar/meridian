import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { findOpencodeConfigPath } from './setup'
import { piAgentDirectory } from './piSetup'

const marker = '// Managed by meridian setup --antigravity.\n'
type Client = 'pi' | 'opencode'
type ObjectValue = Record<string, unknown>
interface Options { client: Client; url: string; model: string; configDir?: string; apiKeyEnv?: string; setDefault?: boolean }
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
function record(value: unknown, label: string): ObjectValue {
  if (value === undefined) return {}
  if (!object(value)) throw new Error(`${label} must be an object; configuration was left untouched`)
  return value
}
function readConfig(path: string, client: Client): { text: string; config: ObjectValue } {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n'
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: client === 'opencode', disallowComments: client === 'pi' })
  if (errors.length || !object(config)) throw new Error(`Cannot parse ${path}; configuration was left untouched`)
  return { text, config }
}
export function parseAntigravitySetupArgs(args: string[]): Options {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--antigravity' || key === '--set-default') { flags.add(key); continue }
    if (!['--client', '--url', '--model', '--config-dir', '--api-key-env'].includes(key)) throw new Error(`Unknown Antigravity setup option: ${key}`)
    const value = args[++index]
    if (!value || value.startsWith('--') || values.has(key)) throw new Error(`${key} requires one value`)
    values.set(key, value)
  }
  const client = values.get('--client')
  if (client !== 'pi' && client !== 'opencode') throw new Error('Choose --client pi or --client opencode (OpenCode V1)')
  const url = values.get('--url'), model = values.get('--model')
  if (!url || !model) throw new Error('Provide --url <Antigravity base URL> and --model <account model slug>')
  return { client, url, model, configDir: values.get('--config-dir'), apiKeyEnv: values.get('--api-key-env'), setDefault: flags.has('--set-default') }
}

/** Prepare every edit before touching configuration; keep recoverable originals. */
export function setupAntigravityClient(options: Options, entryUrl: string, home: string = homedir()) {
  const url = new URL(options.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) base URL without credentials, query or fragment')
  const base = url.href.replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.model)) throw new Error('Invalid account model slug')
  if (options.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) throw new Error('Invalid API-key environment variable name')
  const entry = fileURLToPath(entryUrl)
  const source = entry.endsWith('.ts')
    ? join(dirname(entry), '..', 'examples', options.client === 'pi' ? 'pi-extension' : 'opencode-plugin', 'antigravity-retry.js')
    : join(dirname(entry), 'antigravity-clients', `${options.client}.js`)
  if (!existsSync(source)) throw new Error(`Bundled ${options.client} integration missing; rebuild or reinstall Meridian`)
  const directory = options.configDir ? resolve(options.configDir) : options.client === 'pi'
    ? piAgentDirectory(process.env, home)
    : dirname(findOpencodeConfigPath())
  const configPath = options.client === 'pi' ? join(directory, 'models.json')
    : existsSync(join(directory, 'opencode.jsonc')) && !existsSync(join(directory, 'opencode.json')) ? join(directory, 'opencode.jsonc') : join(directory, 'opencode.json')
  const integrationPath = join(directory, options.client === 'pi' ? 'extensions' : 'plugins', 'meridian-antigravity.js')
  if (existsSync(integrationPath) && !readFileSync(integrationPath, 'utf8').startsWith(marker)) throw new Error(`Unmanaged integration at ${integrationPath}; move it before setup`)
  const integrationDirectory = dirname(integrationPath)
  const signature = readFileSync(source, 'utf8').split('\n')[0]!
  if (existsSync(integrationDirectory)) {
    for (const name of readdirSync(integrationDirectory)) {
      const path = join(integrationDirectory, name)
      if (path !== integrationPath && /\.[cm]?js$/.test(name) && lstatSync(path).isFile() && readFileSync(path, 'utf8').includes(signature)) throw new Error(`Another Antigravity integration exists at ${path}; remove that manual copy before setup`)
    }
  }
  const { text, config } = readConfig(configPath, options.client)
  if (options.client === 'opencode') {
    const policies = [config]
    const sibling = join(directory, configPath.endsWith('.jsonc') ? 'opencode.json' : 'opencode.jsonc')
    if (existsSync(sibling)) {
      const other = readConfig(sibling, 'opencode').config
      policies.push(other)
      if (record(other.provider, 'Sibling providers')['meridian-agy'] !== undefined) throw new Error(`Antigravity is also configured in ${sibling}; resolve the duplicate before setup`)
    }
    for (const policy of policies) for (const field of ['enabled_providers', 'disabled_providers']) {
      const value = policy[field]
      if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error(`${field} must be an array of provider IDs`)
      if (Array.isArray(value) && (field === 'enabled_providers' ? !value.includes('meridian-agy') : value.includes('meridian-agy'))) throw new Error(`${field} excludes meridian-agy; update that explicit provider policy before setup`)
    }
  }
  const edits: Array<{ path: Array<string | number>; value: unknown }> = []
  const root = options.client === 'pi' ? 'providers' : 'provider'
  const providers = record(config[root], root)
  const provider = record(providers['meridian-agy'], 'Antigravity provider')
  const put = (path: Array<string | number>, value: unknown) => edits.push({ path, value })
  if (options.client === 'pi') {
    if (provider.models !== undefined && !Array.isArray(provider.models)) throw new Error('Pi models must be an array')
    const models: unknown[] = Array.isArray(provider.models) ? [...provider.models] : []
    const matches = models.flatMap((model, index) => object(model) && model.id === options.model ? [index] : [])
    if (matches.length > 1) throw new Error('Duplicate Pi model IDs; resolve them before setup')
    const index = matches[0] ?? models.length
    models[index] = { ...record(models[index], 'Pi model'), id: options.model, name: `Antigravity ${options.model}`, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096 }
    put([root, 'meridian-agy', 'api'], 'anthropic-messages')
    put([root, 'meridian-agy', 'baseUrl'], base)
    put([root, 'meridian-agy', 'apiKey'], options.apiKeyEnv ?? provider.apiKey ?? 'local-placeholder')
    put([root, 'meridian-agy', 'models'], models)
  } else {
    const providerOptions = record(provider.options, 'Antigravity provider options')
    const model = record(record(provider.models, 'Antigravity models')[options.model], 'Antigravity model')
    put([root, 'meridian-agy', 'npm'], '@ai-sdk/anthropic')
    put([root, 'meridian-agy', 'name'], 'Antigravity through Meridian')
    put([root, 'meridian-agy', 'options', 'baseURL'], `${base}/v1`)
    put([root, 'meridian-agy', 'options', 'apiKey'], options.apiKeyEnv ? `{env:${options.apiKeyEnv}}` : providerOptions.apiKey ?? 'local-placeholder')
    put([root, 'meridian-agy', 'models', options.model], { ...model, name: `Antigravity ${options.model}`, limit: { ...record(model.limit, 'Model limits'), context: 128000, output: 4096 }, temperature: false, reasoning: false, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } })
    if (options.setDefault) { put(['model'], `meridian-agy/${options.model}`); put(['small_model'], `meridian-agy/${options.model}`) }
  }
  let updated = text
  for (const edit of edits) updated = applyEdits(updated, modify(updated, edit.path, edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  const writes = [{ path: integrationPath, text: marker + readFileSync(source, 'utf8') }, { path: configPath, text: updated }]
  if (options.client === 'pi' && options.setDefault) {
    const path = join(directory, 'settings.json')
    const settings = readConfig(path, 'pi')
    let value = settings.text
    for (const [key, selected] of [['defaultProvider', 'meridian-agy'], ['defaultModel', options.model], ['defaultThinkingLevel', 'off']]) value = applyEdits(value, modify(value, [key!], selected, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    writes.push({ path, text: value })
  }
  const prepared = writes.map(write => {
    if (existsSync(write.path) && !lstatSync(write.path).isFile()) throw new Error(`Refusing to replace a non-regular file: ${write.path}`)
    const original = existsSync(write.path) ? readFileSync(write.path, 'utf8') : undefined
    return { ...write, original, mode: original === undefined ? 0o600 : lstatSync(write.path).mode & 0o777, backup: `${write.path}.bak-${randomUUID()}` }
  }).filter(write => write.text !== write.original)
  const backups: string[] = [], changed: string[] = []
  try {
    for (const write of prepared) {
      mkdirSync(dirname(write.path), { recursive: true })
      if (write.original !== undefined) { writeFileSync(write.backup, write.original, { flag: 'wx', mode: 0o600 }); backups.push(write.backup) }
    }
    for (const write of prepared) {
      if ((existsSync(write.path) ? readFileSync(write.path, 'utf8') : undefined) !== write.original) throw new Error(`Configuration changed during setup: ${write.path}`)
      const temporary = `${write.path}.tmp-${randomUUID()}`
      try { writeFileSync(temporary, write.text, { flag: 'wx', mode: write.mode }); renameSync(temporary, write.path) }
      finally { if (existsSync(temporary)) unlinkSync(temporary) }
      changed.push(write.path)
    }
  } catch (error) {
    for (const path of changed.reverse()) {
      const write = prepared.find(item => item.path === path)!
      if (write.original === undefined) unlinkSync(path)
      else { chmodSync(write.backup, write.mode); renameSync(write.backup, path) }
    }
    throw error
  }
  return { client: options.client, configPath, integrationPath, changed, backups, baseUrl: base, model: options.model }
}
