import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PASSTHROUGH_DENY_REASON } from '../proxy/passthroughDenial'
import { mixedAutoRequest, mixedAutoCommands, createOwnedRelayWork } from '../../scripts/lib/e2eMixedAuto.mjs'
import { createOwnedClientProcess } from '../../scripts/lib/e2eOwnedClient.mjs'

const envelope = 'You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\n</cc_automode_permissions>'
describe('mixed auto observer structural controls', () => {
  it('requires the native system envelope, exact root and bounded classifier shape', () => {
    const body = { system: envelope, tools: [], stream: false, stop_sequences: ['</block>'] }
    expect(mixedAutoRequest(body, 'none', true).classifier).toBe(true)
    expect(mixedAutoRequest(body, 'none', false).classifier).toBe(false)
    for (const change of [{ system: 'Quoted: ' + envelope }, { system: envelope.replace('<cc_automode_permissions>', '"<cc_automode_permissions>"') }, { tools: [{ name: 'Bash' }] }, { stream: true }, { stop_sequences: ['</block>', '</severity>'] }]) {
      expect(mixedAutoRequest({ ...body, ...change }, 'auxiliary', true).classifier).toBe(false)
    }
    expect(mixedAutoRequest({ ...body, stop_sequences: undefined }, 'auxiliary', true).classifier).toBe(true)
    expect(mixedAutoRequest({ ...body, stop_sequences: undefined }, 'none', true).classifier).toBe(false)
    expect(mixedAutoRequest({ system: 'ordinary' }, 'auxiliary', true)).toMatchObject({ role: 'classifier', classifier: false })
    expect(mixedAutoRequest(body, 'unknown-private-string', true).requestClass).toBe('other')
  })
  it('quotes owned paths and rejects malformed directory inputs', () => {
    const commands = mixedAutoCommands("/owned/path's directory")
    expect(commands.firstAlpha).toContain("'\\''")
    expect(commands.stamps).toHaveLength(5)
    expect(commands.firstAlpha.startsWith('sleep 2 && ')).toBe(true)
    expect(commands.parent.endsWith('&& echo parent-2')).toBe(true)
    for (const value of ['relative', '/owned\ninjected', '/owned\0injected']) expect(() => mixedAutoCommands(value)).toThrow()
  })
  it('physically joins both successful and rejected relay handlers', async () => {
    const work = createOwnedRelayWork()
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => { release = resolve })
    const first = work.wrap(async () => { await pending; return 'answer' })(undefined)
    const failure = work.wrap(() => { throw new Error('owned failure') })(undefined)
    void failure.catch(() => undefined)
    expect(work.pendingCount()).toBe(2)
    const joining = work.join()
    release?.()
    expect((await joining).map(row => row.status)).toEqual(['fulfilled', 'rejected'])
    expect(await first).toBe('answer')
    expect(work.pendingCount()).toBe(0)
  })
})

async function runControl(mode: Record<string, boolean>, expectUnjoinedQuery = false) {
  const root = mkdtempSync(join(tmpdir(), 'meridian-e72-mixed-controls-'))
  const target = join(root, 'target'), sdk = join(target, 'node_modules/@anthropic-ai/claude-agent-sdk'), proofDir = join(root, 'proof')
  mkdirSync(sdk, { recursive: true, mode: 0o700 }); mkdirSync(proofDir, { mode: 0o700 })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'meridian-harness-synthetic-fixture', version: '0.0.0', type: 'module' }))
  writeFileSync(join(target, 'mode.json'), JSON.stringify(mode))
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.2.141', type: 'module', main: 'sdk.mjs', meridianHarnessSynthetic: true }))
  const fixtures = join(import.meta.dir, 'fixtures/e72-mixed-control')
  copyFileSync(join(fixtures, 'sdk.mjs'), join(sdk, 'sdk.mjs'))
  copyFileSync(join(fixtures, 'client.mjs'), join(target, 'client.mjs'))
  // Replace only the existing forwarding policy's literal in this marked fake.
  writeFileSync(join(target, 'server.mjs'), readFileSync(join(fixtures, 'server.mjs'), 'utf8').replace('__DENIAL__', PASSTHROUGH_DENY_REASON))
  const native = join(target, 'native'), grant = join(root, 'grant.json')
  writeFileSync(native, '#!/usr/bin/env node\nconsole.log("2.1.284 (Claude Code)")\n', { mode: 0o700 })
  const client = join(target, 'client.mjs')
  const { chmodSync } = await import('node:fs'); chmodSync(client, 0o700)
  writeFileSync(grant, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-never-authenticated', expiresAt: Date.now() + 3600000, scopes: ['user:inference'] } }), { mode: 0o400 })
  const harness = resolve(import.meta.dir, '../../scripts/e2e-claude-code-subagent-session.mjs')
  const child = spawn(process.execPath, [harness, '--synthetic', '--require-mcp-readiness', '--scenario', 'mixed-auto-v1',
    '--target-root', target, '--entry', 'server.mjs', '--client', client, '--client-version', '2.1.287', '--native-cli', native,
    '--native-cli-version', '2.1.284', '--sdk-version', '0.2.141', '--model', 'claude-sonnet-5-5', '--served-model', 'claude-sonnet-5-5',
    '--classifier-model', 'claude-sonnet-5', '--classifier-served-model', 'claude-sonnet-5', '--grant-file', grant,
    '--proof-dir', proofDir, '--max-queries', '24', '--max-cost-usd', '12', '--timeout-ms', '10000'],
  { cwd: target, detached: true, env: { PATH: process.env.PATH, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = createOwnedClientProcess(child)
  // Drain bounded diagnostics without exposing fixtures' private working paths.
  let bytes = 0
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) owner.signal('SIGKILL') })
  const deadline = setTimeout(() => owner.signal('SIGKILL'), 20000)
  try {
    await owner.joined
    const proof = JSON.parse(readFileSync(join(proofDir, 'claude-subagent-results.json'), 'utf8'))
    expect(owner.isJoined()).toBe(true)
    expect(proof.acceptance).toBe(false)
    expect(proof.privateRuntimeRemoved).toBe(!expectUnjoinedQuery)
    if (expectUnjoinedQuery) expect(proof.cleanupFailures).toEqual(['unjoined owned work', 'logger context restoration', 'private runtime retained after cleanup failure'])
    else expect(proof.cleanupFailures).toEqual([])
    expect(proof.relayOperationsJoined).toBe(true)
    expect(proof.loggerContextDescriptorRestored).toBe(!expectUnjoinedQuery)
    expect(proof.ownerGrantUnchanged).toBe(true)
    expect(proof.clientProcesses.every((row: { join: string }) => row.join === 'JOINED')).toBe(true)
    if (process.env.E72_MIXED_CONTROL_EVIDENCE_DIR) {
      const directory = resolve(process.env.E72_MIXED_CONTROL_EVIDENCE_DIR)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const label = Object.keys(mode).sort().join('-') || 'positive'
      expect(/^[A-Za-z-]{1,80}$/.test(label)).toBe(true)
      writeFileSync(join(directory, label + '.json'), JSON.stringify({ originalDriverPhysicallyJoined: owner.isJoined(), driverExit: child.exitCode, proof }, null, 2), { mode: 0o600, flag: 'wx' })
    }
    // Only the original driver exit + close + both pipe joins authorize
    // removal of a deliberately retained fake query fixture.
    rmSync(root, { recursive: true, force: true })
    return { code: child.exitCode, proof }
  } finally { clearTimeout(deadline) }
}

describe('actual mixed observer against marked synthetic client, proxy and SDK', () => {
  it('binds interleaved classifiers to independent sessions while preserving parent/child chains', async () => {
    const result = await runControl({})
    expect(result.proof.failure).toBeUndefined()
    expect(result.code).toBe(0)
    expect(result.proof.result).toBe('PASS')
    expect(Object.values(result.proof.checks).every(Boolean)).toBe(true)
    expect(result.proof.mixedAutoFacts).toMatchObject({ classifiers: 3, workingRequests: 10, completedOutsideWrites: 5 })
    expect(result.proof.requestModelWitness.capturedRequests).toBe(13)
    expect(result.proof.toolReceipts).toHaveLength(7)
  })
  for (const [mode, check] of [
    ['wrongClassifierModel', 'nativeReceipts'], ['borrowedClassifierSession', 'independentClassifierSessions'],
    ['classifierNotIsolated', 'classifierIsolation'], ['classifierWait', 'classifierNoWorkingLeaseWait'],
    ['noClassifiers', 'genuineClassifiers'], ['forgedClassifier', 'genuineClassifiers'], ['missingWrite', 'outsideWritesAndParentReceipt'],
    ['changedCommand', 'actualAgentAndBashReceipts'],
  ]) it('rejects ' + mode, async () => {
    const result = await runControl({ [mode!]: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.checks[check!]).toBe(false)
  })
  for (const mode of ['noLoggerContext', 'duplicateQuery']) it('rejects ' + mode + ' before accepting SDK ownership', async () => {
    const result = await runControl({ [mode]: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.requestModelWitness[mode === 'noLoggerContext' ? 'missingContext' : 'duplicateContext']).toBe(true)
  })
  it('holds restoration and the fixture when a rejected duplicate leaves an unconsumed SDK query', async () => {
    const result = await runControl({ duplicateBeforeConsume: true }, true)
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.requestModelWitness.duplicateContext).toBe(true)
  })
})
