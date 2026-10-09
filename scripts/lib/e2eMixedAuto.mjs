import assert from 'node:assert/strict'

const publicToolNames = new Set(['Agent', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TaskOutput', 'TaskStop', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch', 'TodoWrite', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'WebFetch', 'WebSearch', 'NotebookEdit'])
const toolName = value => publicToolNames.has(value) ? value : 'other'

// Diagnostic facts only. Unknown names, IDs and inputs never leave the
// observer, and these facts cannot qualify an unexpected tool as accepted.
export function publicToolReceiptMatch({ wireName, sdkRawName, observerSdkName, wireInput, sdkInput, hookFate, hookInput, sdkIdOwners }) {
  const present = typeof sdkRawName === 'string'
  const clientPrefix = present && sdkRawName.startsWith('mcp__oc__')
  return {
    wireName: toolName(wireName),
    sdkName: toolName(clientPrefix ? sdkRawName.slice('mcp__oc__'.length) : sdkRawName),
    sdkNamespace: !present ? 'missing' : clientPrefix ? 'client-mcp' : sdkRawName.startsWith('mcp__') ? 'other-mcp' : 'bare',
    sdkIdOwners,
    observerNameMatched: present && observerSdkName === wireName,
    singleClientPrefixNameMatched: present && (sdkRawName === wireName || sdkRawName === 'mcp__oc__' + wireName),
    inputMatched: typeof sdkInput === 'string' && sdkInput === wireInput,
    hookForwarded: hookFate === 'forwarded',
    hookInputMatched: typeof hookInput === 'string' && hookInput === wireInput,
  }
}

// Verification data only; this does not classify product requests or persist
// prompts. The pinned native monitor envelope must be structural, not quoted.
export function mixedAutoRequest(body, rawClass, sessionKeyMatched) {
  const system = typeof body.system === 'string' ? [body.system] : Array.isArray(body.system) ? body.system.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) : []
  const systemEnvelope = system.some(text => {
    if (!text.trimStart().startsWith('You are a security monitor for autonomous AI coding agents.')) return false
    let opened = false
    for (const line of text.split('\n')) {
      if (line === '<cc_automode_permissions>') opened = true
      if (opened && line === '</cc_automode_permissions>') return true
    }
    return false
  })
  const stopsValid = Array.isArray(body.stop_sequences) && body.stop_sequences.length === 1 && ['</block>', '</severity>'].includes(body.stop_sequences[0])
  const noTools = body.tools === undefined || Array.isArray(body.tools) && body.tools.length === 0
  const nonstream = body.stream === undefined || body.stream === false
  const classifier = sessionKeyMatched && systemEnvelope && noTools && nonstream && (stopsValid || rawClass === 'auxiliary' && body.stop_sequences === undefined)
  return { role: classifier || rawClass === 'auxiliary' ? 'classifier' : 'working', classifier, systemEnvelope,
    requestClass: ['none', 'main', 'auxiliary', 'compaction', 'subagent', 'workflow'].includes(rawClass) ? rawClass : 'other' }
}

export function mixedAutoCommands(outside) {
  assert(typeof outside === 'string' && outside.startsWith('/') && outside.length <= 4096 && !/[\x00-\x1f]/.test(outside), 'Mixed commands require an owned absolute directory')
  const names = ['alpha-1', 'alpha-2', 'beta-1', 'beta-2', 'parent-2']
  const stamps = names.map(name => `${outside}/${name}.txt`)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const command = (name, wait = false) => `${wait ? 'sleep 2 && ' : ''}date > ${quote(`${outside}/${name}.txt`)} && echo ${name}`
  return { firstAlpha: command('alpha-1', true), secondAlpha: command('alpha-2'), firstBeta: command('beta-1', true), secondBeta: command('beta-2'), parent: command('parent-2'), stamps }
}

export function createOwnedRelayWork() {
  const pending = new Set()
  return {
    wrap(handler) {
      return request => {
        const operation = Promise.resolve().then(() => handler(request))
        pending.add(operation)
        operation.then(() => pending.delete(operation), () => pending.delete(operation))
        return operation
      }
    },
    pendingCount() { return pending.size },
    join() { return Promise.allSettled([...pending]) },
  }
}
