import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Public SDK system/init receipts only. Never persist config, cwd, credentials,
// descriptions, provider diagnostics or native session identifiers.
export function createQueryMcpReadinessWitness(options) {
  const configured = options.mcpServers ?? {}
  assert(configured && typeof configured === 'object' && !Array.isArray(configured), 'MCP witness requires a server map')
  const names = Object.keys(configured).sort()
  assert(names.length <= 64 && names.every(name => /^[A-Za-z0-9_-]{1,128}$/.test(name)), 'MCP witness requires bounded declared namespaces')
  const declared = options.allowedTools ?? []
  assert(Array.isArray(declared) && declared.length <= 1000 && declared.every(name => typeof name === 'string'), 'MCP witness requires bounded declared tools')
  const prefixes = names.map(name => `mcp__${name}__`)
  const expected = [...new Set(declared.filter(name => prefixes.some(prefix => name.startsWith(prefix))))].sort()
  assert(expected.every(name => /^[A-Za-z0-9_.:-]{1,512}$/.test(name)), 'MCP witness requires safe owned tool names')
  let initCount = 0, resultCount = 0, initSession, sessionMatched = false
  let shapeValid = false, missingServers = names.length, unconfiguredServers = 0, missingTools = expected.length, unexpectedTools = 0
  let statuses = [], advertisedTools = [], duplicateServers = false, duplicateTools = false
  const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex')
  return {
    observe(event) {
      if (event?.type === 'system' && event.subtype === 'init') {
        initCount++
        // A second init cannot replace or repair the first receipt.
        if (initCount !== 1) return
        initSession = typeof event.session_id === 'string' && event.session_id.length > 0 ? event.session_id : undefined
        if (!Array.isArray(event.mcp_servers) || event.mcp_servers.length > 64 || !Array.isArray(event.tools) || event.tools.length > 1000) return
        if (!event.mcp_servers.every(server => server && typeof server.name === 'string' && typeof server.status === 'string') || !event.tools.every(name => typeof name === 'string')) return
        shapeValid = true
        const listed = event.mcp_servers.map(server => server.name)
        duplicateServers = new Set(listed).size !== listed.length
        unconfiguredServers = listed.filter(name => !names.includes(name)).length
        missingServers = names.filter(name => !listed.includes(name)).length
        statuses = names.map(name => {
          const server = event.mcp_servers.find(server => server.name === name)
          return { name, status: !server ? 'missing' : ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(server.status) ? server.status : 'other' }
        })
        const owned = event.tools.filter(name => prefixes.some(prefix => name.startsWith(prefix)))
        duplicateTools = new Set(owned).size !== owned.length
        unexpectedTools = owned.filter(name => !expected.includes(name)).length
        // Only declared, owned names enter the report. Unexpected native tool
        // strings (including errors/secrets masquerading as names) stay private.
        advertisedTools = [...new Set(owned.filter(name => expected.includes(name)))].sort()
        missingTools = expected.filter(name => !advertisedTools.includes(name)).length
      } else if (event?.type === 'result') {
        resultCount++
        sessionMatched = initSession !== undefined && event.session_id === initSession
      }
    },
    summary() {
      return {
        declaredServers: [...names],
        declaredToolCount: expected.length,
        declaredToolDigest: digest(expected),
        initCount, resultCount, shapeValid, sessionMatched,
        statuses: statuses.map(server => ({ ...server })), missingServers, unconfiguredServers, duplicateServers, duplicateTools,
        advertisedToolCount: advertisedTools.length,
        advertisedToolDigest: digest(advertisedTools),
        missingTools, unexpectedTools,
        ready: initCount === 1 && resultCount === 1 && shapeValid && sessionMatched && missingServers === 0 && unconfiguredServers === 0 && !duplicateServers && !duplicateTools && missingTools === 0 && unexpectedTools === 0 && statuses.every(server => server.status === 'connected'),
      }
    },
  }
}
