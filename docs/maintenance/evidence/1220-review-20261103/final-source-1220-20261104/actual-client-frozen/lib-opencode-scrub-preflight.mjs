import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, realpathSync, writeFileSync, existsSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

// Resolve before reading a live grant or starting any client/provider process.
export function resolveOpenCodeScrub(entrypoint, expectedVersion) {
  assert(typeof entrypoint === 'string' && isAbsolute(entrypoint),
    'E2E_PLUGIN_PATH must name an absolute installed OpenCode scrub entrypoint')
  const path = realpathSync(entrypoint)
  let directory = dirname(path)
  for (let depth = 0; depth < 8; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      assert.equal(pkg.name, '@rynfar/meridian-plugin-opencode-scrub', 'Wrong scrub package')
      assert(typeof pkg.version === 'string' && pkg.version.length > 0, 'Missing scrub version')
      if (expectedVersion) assert.equal(pkg.version, expectedVersion, 'Scrub version mismatch')
      return {path, packageName: pkg.name, packageVersion: pkg.version,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex')}
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('OpenCode scrub entrypoint has no package manifest')
}

export function configureOpenCodeScrub(root, installation) {
  const pluginConfigPath = join(root, 'plugins.json')
  writeFileSync(pluginConfigPath, JSON.stringify({plugins: [
    {path: installation.path, enabled: true},
  ]}), {mode: 0o600})
  // An owned empty discovery location prevents ambient server plugins from
  // silently supplying (or duplicating) the required scrub implementation.
  return {pluginConfigPath, pluginDir: join(root, 'isolated-server-plugins')}
}

export function verifyOpenCodeScrub(list, installation, requireInvocation = false) {
  assert(Array.isArray(list.plugins), 'Missing plugin inventory')
  assert.equal(list.plugins.length, 1, 'Unexpected or duplicate server plugins')
  const loaded = list.plugins[0]
  assert.equal(loaded.name, 'opencode-scrub', 'Required scrub not loaded')
  assert.equal(loaded.status, 'active', 'Required scrub is not active')
  assert.equal(realpathSync(loaded.path), installation.path, 'Wrong scrub entrypoint loaded')
  assert(loaded.hooks?.includes('onRequest'), 'Scrub request hook missing')
  assert(typeof loaded.version === 'string' && loaded.version.length > 0, 'Missing runtime scrub version')
  const hook = loaded.stats?.hooks?.onRequest
  assert.equal(hook?.errors ?? 0, 0, 'Scrub request hook failed')
  if (requireInvocation) assert((hook?.invocations ?? 0) > 0, 'Scrub did not process the client request')
  return {...installation, runtimeVersion: loaded.version,
    invocations: hook?.invocations ?? 0, errors: hook?.errors ?? 0}
}
