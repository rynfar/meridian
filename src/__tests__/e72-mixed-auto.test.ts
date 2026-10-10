import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PASSTHROUGH_DENY_REASON } from '../proxy/passthroughDenial'
import { mixedAutoRequest, mixedAutoCommands, createOwnedRelayWork, publicToolReceiptMatch, publicHandbackReceiptFacts } from '../../scripts/lib/e2eMixedAuto.mjs'
import { createOwnedClientProcess } from '../../scripts/lib/e2eOwnedClient.mjs'

const envelope = 'You are a security monitor for autonomous AI coding agents.\n<cc_automode_permissions>\n</cc_automode_permissions>'
describe('mixed auto observer structural controls', () => {
  const expectedMessage = 'alpha-1\nalpha-2'
  const handback = { input: { message: expectedMessage }, parentPrompt: 'Call SubagentHandback with ' + JSON.stringify(expectedMessage), expectedMessage, expectedActorId: 'private-alpha-agent' }
  it('distinguishes exact input, launch instructions and whole structured reports without publishing payloads', () => {
    const payload = { agentId: 'private-alpha-agent', handback: 'send', handbackReport: { text: expectedMessage, warning: 'private warning' }, content: [{ type: 'text', text: 'private notification' }] }
    const facts = publicHandbackReceiptFacts({ ...handback, parentResultContent: JSON.stringify(payload) })
    expect(facts).toEqual({ inputMessageOnly: true, inputMessageMatched: true, parentPromptNamesHandback: true, parentPromptContainsExactReport: true, parentResultTextContainsExactReport: false,
      parentResultEncoding: 'json-string', structuredAgentIdMatched: true, structuredHandback: 'send', structuredReportPresent: true, structuredReportTextMatched: true, structuredReportWarningPresent: true, callerMessagesContainingExactReport: 0 })
    expect(JSON.stringify(facts)).not.toContain('private')
    expect(JSON.stringify(facts)).not.toContain('alpha')
    expect(publicHandbackReceiptFacts({ ...handback, parentResultContent: [{ type: 'text', text: JSON.stringify(payload) }] }).parentResultEncoding).toBe('json-text-block')
    expect(publicHandbackReceiptFacts({ ...handback, parentResultContent: JSON.stringify({ ...payload, agentId: 'another-child', handback: 'private-unknown', handbackReport: { text: 'beta-1\nbeta-2' } }) })).toMatchObject({ structuredAgentIdMatched: false, structuredHandback: 'invalid', structuredReportTextMatched: false })
  })
  it('does not infer structured reports from prose, nested JSON, arrays or multiple blocks', () => {
    const report = { agentId: 'private-alpha-agent', handback: 'flagged', handbackReport: { text: expectedMessage } }
    for (const content of ['prefix ' + JSON.stringify(report), JSON.stringify([report]), JSON.stringify({ nested: report }), [{ type: 'text', text: JSON.stringify(report) }, { type: 'text', text: expectedMessage }], { ...report }]) {
      const facts = publicHandbackReceiptFacts({ ...handback, parentResultContent: content })
      expect(facts.structuredReportTextMatched).toBe(false)
      expect(facts.structuredAgentIdMatched).toBe(false)
    }
    expect(publicHandbackReceiptFacts({ ...handback, parentResultContent: JSON.stringify(report) }).structuredHandback).toBe('flagged')
    expect(publicHandbackReceiptFacts({ ...handback, parentResultContent: JSON.stringify({ ...report, handback: 'withheld', handbackReport: { text: null } }) })).toMatchObject({ structuredHandback: 'withheld', structuredReportTextMatched: false })
  })
  it('keeps caller-message occurrences separate from tool results and rejects input or prompt inference', () => {
    const facts = publicHandbackReceiptFacts({ ...handback, input: { message: expectedMessage, recipient: 'private-recipient' }, parentPrompt: 'Only run alpha-1 and alpha-2', parentResultContent: expectedMessage,
      callerMessages: [{ role: 'user', content: expectedMessage }, { role: 'user', content: [{ type: 'text', text: expectedMessage }] }, { role: 'assistant', content: expectedMessage }, { role: 'user', content: [{ type: 'tool_result', content: expectedMessage }] }] })
    expect(facts).toMatchObject({ inputMessageOnly: false, inputMessageMatched: false, parentPromptNamesHandback: false, parentPromptContainsExactReport: false, parentResultTextContainsExactReport: true, parentResultEncoding: 'invalid', callerMessagesContainingExactReport: 2 })
    expect(publicHandbackReceiptFacts({ ...handback, input: { message: 'beta-1\nbeta-2' }, parentPrompt: 'NotSubagentHandback ' + expectedMessage })).toMatchObject({ inputMessageMatched: false, parentPromptNamesHandback: false, parentPromptContainsExactReport: true })
  })
  it('distinguishes name normalization, changed inputs and missing owners without exposing payloads', () => {
    const receipt = { wireName: 'SendMessage', sdkRawName: 'mcp__oc__SendMessage', observerSdkName: 'mcp__oc__SendMessage', wireInput: 'private input', sdkInput: 'private input', hookFate: 'forwarded', hookInput: 'private input', sdkIdOwners: 1 }
    expect(publicToolReceiptMatch(receipt)).toMatchObject({ wireName: 'SendMessage', sdkName: 'SendMessage', sdkNamespace: 'client-mcp', observerNameMatched: false, singleClientPrefixNameMatched: true, inputMatched: true, hookInputMatched: true, hookForwarded: true })
    expect(publicToolReceiptMatch({ ...receipt, wireName: 'Bash' }).singleClientPrefixNameMatched).toBe(false)
    expect(publicToolReceiptMatch({ ...receipt, sdkInput: 'changed input' }).inputMatched).toBe(false)
    expect(publicToolReceiptMatch({ ...receipt, sdkRawName: undefined, sdkInput: undefined, sdkIdOwners: 0 })).toMatchObject({ sdkNamespace: 'missing', singleClientPrefixNameMatched: false, inputMatched: false })
    const unknown = publicToolReceiptMatch({ ...receipt, wireName: 'private tool', sdkRawName: 'mcp__oc__private tool' })
    expect(unknown).toMatchObject({ wireName: 'other', sdkName: 'other', singleClientPrefixNameMatched: true })
    expect(JSON.stringify(unknown)).not.toContain('private')
    expect(publicToolReceiptMatch({ ...receipt, sdkRawName: 'mcp__private__SendMessage' }).sdkNamespace).toBe('other-mcp')
  })
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
  if (mode.nativeInboxReport) copyFileSync(join(import.meta.dir, 'fixtures/e72-native-handback-inbox.json'), join(target, 'native-inbox.json'))
  if (mode.nativeFramedReport) copyFileSync(join(import.meta.dir, 'fixtures/e72-native-handback-frame.txt'), join(target, 'native-frame.txt'))
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
  const child = spawn(process.execPath, [harness, '--synthetic', '--require-mcp-readiness', '--scenario', mode.inboxHandbackScenario ? 'mixed-auto-handback-v3' : mode.handbackScenario ? 'mixed-auto-handback-v2' : 'mixed-auto-v1',
    ...(mode.ownedCheckpoint ? ['--checkpoint-protocol', 'owned-interrupt-v1'] : []),
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
  it('verifies the exact native inbox and child ownership through the maintained v3 harness', async () => {
    const result = await runControl({ handbackScenario: true, inboxHandbackScenario: true, nativeInboxReport: true, groupedInboxReport: true, ownedCheckpoint: true })
    expect(result.code).toBe(0)
    expect(result.proof.handbackFacts.protocol).toBe('native-client-inbox-v1')
    expect(result.proof.handbackFacts.reports.every((row: { exactMessageInParentResult: boolean; inbox: { reportMatched: boolean; footerActorMatched: boolean } }) => !row.exactMessageInParentResult && row.inbox.reportMatched && row.inbox.footerActorMatched)).toBe(true)
    expect(Object.values(result.proof.checks).every(Boolean)).toBe(true)
  })
  it('preserves v2 raw-substring rejection of a native framed report', async () => {
    const result = await runControl({ handbackScenario: true, nativeFramedReport: true })
    expect(result.code).toBe(1)
    expect(result.proof.checks.nativeHandbackReports).toBe(false)
  })
  for (const mode of ['wrongInboxActor', 'wrongInboxReport', 'wrongInboxRole', 'wrongInboxFooter', 'missingInboxReport', 'duplicateInboxReport', 'truncatedInboxReport', 'droppedSdkInbox']) it('rejects native-inbox ' + mode + ' in the maintained v3 harness', async () => {
    const result = await runControl({ handbackScenario: true, inboxHandbackScenario: true, nativeInboxReport: true, groupedInboxReport: true, [mode]: true })
    expect(result.code).toBe(1)
    expect(result.proof.checks.nativeHandbackReports).toBe(false)
  })

  it('witnesses the opt-in interrupt through the maintained harness without trusting a product log', async () => {
    const result = await runControl({ ownedCheckpoint: true, handbackScenario: true })
    expect(result.code).toBe(0)
    expect(result.proof.result).toBe('PASS')
    expect(result.proof.checkpointProtocol).toBe('owned-interrupt-v1')
    expect(result.proof.checkpointObserverSha256).toMatch(/^[a-f0-9]{64}$/)
    const stops = result.proof.queries.filter((row: { ownedCheckpoint: { requested: boolean } }) => row.ownedCheckpoint.requested)
    expect(stops).toHaveLength(8)
    expect(stops.every((row: { ownedCheckpoint: { qualified: boolean }; acceptedCanonicalResult: boolean; legacyCanonicalResult: boolean }) => row.ownedCheckpoint.qualified && row.acceptedCanonicalResult && !row.legacyCanonicalResult)).toBe(true)
    expect(Object.values(result.proof.checks).every(Boolean)).toBe(true)
  })
  it('rejects an unrelated error even when a fake product consumes it and returns the expected tools', async () => {
    const result = await runControl({ ownedCheckpoint: true, ownedWrongIteratorError: true, handbackScenario: true })
    expect(result.code).toBe(1)
    expect(result.proof.checks.nativeReceipts).toBe(false)
    const stops = result.proof.queries.filter((row: { ownedCheckpoint: { requested: boolean } }) => row.ownedCheckpoint.requested)
    expect(stops).toHaveLength(8)
    expect(stops.every((row: { ownedCheckpoint: { qualified: boolean; iteratorErrorMatched: boolean } }) => !row.ownedCheckpoint.qualified && !row.ownedCheckpoint.iteratorErrorMatched)).toBe(true)
  })
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
  it('requires two final child handbacks with exact reports delivered to their own parent Agent results', async () => {
    const result = await runControl({ handbackScenario: true })
    expect(result.code).toBe(0)
    expect(result.proof.result).toBe('PASS')
    expect(Object.values(result.proof.checks).every(Boolean)).toBe(true)
    expect(result.proof.toolReceipts).toHaveLength(9)
    expect(result.proof.handbackFacts).toMatchObject({ calls: 2, actors: [1, 2], distinctParentLaunches: true, exactChildReportsDeliveredToMatchingParent: [true, true], childFinalCalls: true })
    expect(result.proof.handbackFacts.reports.every((row: { parentLaunch: number; exactMessageInParentResult: boolean }) => [1, 2].includes(row.parentLaunch) && row.exactMessageInParentResult)).toBe(true)
  })
  it('preserves the original mixed-v1 rejection of extra handback calls', async () => {
    const result = await runControl({ legacyHandback: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.checks.actualAgentAndBashReceipts).toBe(false)
    expect(result.proof.checks.nativeReceipts).toBe(false)
    expect(result.proof.handbackFacts).toBeUndefined()
  })
  for (const mode of ['structuredParentHandback', 'separateCallerHandback']) it('diagnoses ' + mode + ' while preserving the existing handback rejection', async () => {
    const result = await runControl({ handbackScenario: true, [mode]: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.checks.nativeHandbackReports).toBe(false)
    expect(result.proof.checks.actualAgentAndBashReceipts).toBe(false)
    const facts = result.proof.handbackFacts.reports.map((row: { diagnostic: unknown }) => row.diagnostic)
    expect(facts).toHaveLength(2)
    if (mode === 'structuredParentHandback') expect(facts.every((row: { parentResultEncoding: string; structuredAgentIdMatched: boolean; structuredReportTextMatched: boolean; structuredHandback: string }) => row.parentResultEncoding === 'json-string' && row.structuredAgentIdMatched && row.structuredReportTextMatched && row.structuredHandback === 'send')).toBe(true)
    else expect(facts.every((row: { callerMessagesContainingExactReport: number; structuredReportPresent: boolean }) => row.callerMessagesContainingExactReport === 1 && !row.structuredReportPresent)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain('synthetic-private')
  })
  for (const mode of ['missingHandback', 'wrongHandbackMessage', 'handbackNotDelivered', 'handbackNotFinal', 'duplicateHandback', 'handbackRecipient', 'unknownClosingTool', 'undeclaredHandback', 'sharedParentReport']) it('rejects handback contract violation ' + mode, async () => {
    const result = await runControl({ handbackScenario: true, [mode]: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.checks.nativeHandbackReports).toBe(false)
    expect(result.proof.checks.actualAgentAndBashReceipts).toBe(false)
    if (mode === 'sharedParentReport') expect(result.proof.handbackFacts.distinctParentLaunches).toBe(false)
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
  for (const mode of ['unexpectedClientTool', 'changedClientToolName', 'changedClientToolInput']) it('retains failed acceptance and diagnoses ' + mode, async () => {
    const result = await runControl({ [mode]: true })
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.checks.actualAgentAndBashReceipts).toBe(false)
    expect(result.proof.checks.nativeReceipts).toBe(false)
    const rows = result.proof.toolReceiptDiagnostics
    if (mode === 'unexpectedClientTool') {
      expect(result.proof.toolReceipts).toHaveLength(9)
      expect(rows.filter((row: { wireName: string }) => row.wireName === 'SendMessage')).toHaveLength(2)
      expect(rows.filter((row: { wireName: string }) => row.wireName === 'SendMessage').every((row: { observerNameMatched: boolean; singleClientPrefixNameMatched: boolean; inputMatched: boolean; hookForwarded: boolean }) => !row.observerNameMatched && row.singleClientPrefixNameMatched && row.inputMatched && row.hookForwarded)).toBe(true)
    } else if (mode === 'changedClientToolName') expect(rows.some((row: { singleClientPrefixNameMatched: boolean }) => !row.singleClientPrefixNameMatched)).toBe(true)
    else expect(rows.some((row: { inputMatched: boolean; hookInputMatched: boolean }) => !row.inputMatched && !row.hookInputMatched)).toBe(true)
  })
  it('holds restoration and the fixture when a rejected duplicate leaves an unconsumed SDK query', async () => {
    const result = await runControl({ duplicateBeforeConsume: true }, true)
    expect(result.code).toBe(1)
    expect(result.proof.result).toBe('FAIL')
    expect(result.proof.requestModelWitness.duplicateContext).toBe(true)
  })
})
