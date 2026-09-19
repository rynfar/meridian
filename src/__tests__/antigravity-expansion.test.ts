import { describe, it, expect } from 'bun:test'
import { publicAgAddress, fetchAgImage } from '../proxy/backends/antigravityUrl'
import { agNativeAllowed, agNativeTools } from '../proxy/backends/antigravityNative'
import { agHookCommand } from '../proxy/backends/antigravityProcess'
import { estimateAgTokens } from '../proxy/backends/antigravityTokens'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'
import { agUpstreamSchema, AgSchemaCompiler, agSchemaError } from '../proxy/backends/antigravitySchema'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Antigravity expanded boundaries', () => {
  it('keeps native subagents inside the inherited policy and separates browser grants', () => {
    const options = { allowNativeSubagents: true }
    const allowed = agNativeTools(options)
    const invoke = (agent: unknown) => agNativeAllowed('invoke_subagent', { Subagents: [agent] }, allowed, false, true)
    expect(invoke({ TypeName: 'self', Workspace: 'inherit' })).toBe(true)
    expect(invoke({ TypeName: 'self', Workspace: 'branch' })).toBe(false)
    expect(invoke({ TypeName: 'browser' })).toBe(false)
    expect(invoke({ TypeName: 'self', WorkspacePath: '/private' })).toBe(false)
    expect(agNativeAllowed('mcp_chrome_devtools_take_screenshot', { filePath: '/tmp/unrequested' }, agNativeTools({ allowNativeBrowser: true }), true, false)).toBe(false)
    expect(agNativeAllowed('mcp_chrome_devtools_new_page', { url: 'file:///etc/passwd' }, agNativeTools({ allowNativeBrowser: true }), true, false)).toBe(false)
    expect(agNativeAllowed('run_command', {}, allowed, false, true)).toBe(false)
    expect(agNativeAllowed('invoke_subagent', { Subagents: [{ TypeName: 'browser' }] }, agNativeTools({ allowNativeBrowser: true }), true, false)).toBe(true)
  })
  it('blocks private, mapped, loopback and special-use attachment addresses', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '100.100.100.200', '169.254.169.254', '192.168.1.1', '172.16.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) expect(publicAgAddress(address)).toBe(false)
    expect(publicAgAddress('1.1.1.1')).toBe(true)
    expect(publicAgAddress('2606:4700:4700::1111')).toBe(true)
    await expect(fetchAgImage('https://127.0.0.1/private')).rejects.toThrow('non-public')
    await expect(fetchAgImage('http://example.com/image')).rejects.toThrow('HTTPS')
    await expect(fetchAgImage('https://user:password@example.com/image')).rejects.toThrow('credentials')
  })
  it('labels token estimates and never treats base64 bytes as image text tokens', () => {
    const request = parseAgRequest({ model: 'fixture', messages: [{ role: 'user', content: 'Hello' }] })
    const count = estimateAgTokens(request)
    expect(count.estimated).toBe(true)
    expect(count.estimation.includes_cli_context).toBe(false)
    expect(count.input_tokens).toBeGreaterThan(0)
  })
  it('excludes unprocessed binary media at both top level and inside tool results', () => {
    const audio = { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'YQ=='.repeat(1000) } }
    const request = parseAgRequest({ model: 'fixture', messages: [
      { role: 'user', content: [audio] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [audio] }] },
    ] })
    const count = estimateAgTokens(request)
    expect(count.estimation.excluded_unprocessed_media).toBe(2)
    expect(count.input_tokens).toBeLessThan(1800)
  })
  it('relaxes only native enum transport while retaining exact client validation', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer', enum: [1, 2] } }, required: ['count'] }
    expect(agUpstreamSchema(schema)).toEqual({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] })
    const validate = new AgSchemaCompiler().compile(schema, 'test')
    expect(agSchemaError(validate, { count: 3 })).toBeDefined()
    expect(agSchemaError(validate, { count: 2 })).toBeUndefined()
    expect(schema.properties.count.enum).toEqual([1, 2])
  })
  it('executes hook paths containing spaces through the platform shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meridian hook test '))
    try {
      const file = join(root, 'hook probe.cjs')
      await writeFile(file, 'console.log("HOOK_OK")')
      const command = agHookCommand(process.execPath, file)
      const result = process.platform === 'win32'
        ? await promisify(execFile)('cmd.exe', ['/d', '/s', '/c', '"' + command + '"'], { timeout: 5000, windowsVerbatimArguments: true })
        : await promisify(execFile)('/bin/sh', ['-c', command], { timeout: 5000 })
      expect(result.stdout.trim()).toBe('HOOK_OK')
    } finally { await rm(root, { recursive: true, force: true }) }
    expect(() => agHookCommand('C:\\%BAD%\\node.exe', 'C:\\hook.cjs', 'win32')).toThrow('percent')
  })
})
