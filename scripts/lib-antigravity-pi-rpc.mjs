// Actual Pi RPC session checks, shared by the opt-in client gate.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function verifyPiSession({ binary, args, env, project, root, url, report }) {
  const child = spawn(binary, [...args.slice(0, -2), '--mode', 'rpc'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  const events = [], waiters = new Set()
  let buffer = '', stderr = '', exited = false
  const finish = (waiter, error, value) => { clearTimeout(waiter.timer); waiters.delete(waiter); error ? waiter.reject(error) : waiter.resolve(value) }
  child.stdout.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch (error) { for (const waiter of [...waiters]) finish(waiter, error); continue }
      events.push(event)
      for (const waiter of [...waiters]) if (waiter.predicate(event)) finish(waiter, undefined, event)
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', error => { for (const waiter of [...waiters]) finish(waiter, error) })
  child.once('close', code => { exited = true; for (const waiter of [...waiters]) finish(waiter, new Error(`Pi exited ${code}: ${stderr}`)) })
  child.once('error', error => { for (const waiter of [...waiters]) finish(waiter, error) })
  function wait(predicate, timeout = 180000) {
    if (exited) return Promise.reject(new Error('Pi already exited'))
    const promise = new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined }
      waiter.timer = setTimeout(() => finish(waiter, new Error('Pi RPC deadline exceeded')), timeout)
      waiters.add(waiter)
    })
    // A failed command may leave its agent-end waiter unconsumed until teardown.
    // Retain rejection for callers without creating an unhandled rejection.
    void promise.catch(() => undefined)
    return promise
  }
  async function command(type, fields = {}) {
    const id = randomUUID(), result = wait(event => event.type === 'response' && event.id === id)
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n')
    const response = await result
    assert.equal(response.success, true, JSON.stringify(response))
    return response.data
  }
  async function prompt(message) {
    const idle = wait(event => event.type === 'agent_end')
    await command('prompt', { message })
    const event = await idle
    assert(!event.messages?.some(message => message.stopReason === 'error'), JSON.stringify(event))
    return event
  }
  const health = async () => (await fetch(url + '/health')).json()
  try {
    await command('get_state')
    await command('set_auto_retry', { enabled: false })
    const before = await health()
    const marker = `STEER_${randomUUID()}`, forbidden = join(project, 'must-not-write.txt')
    const toolStart = wait(event => event.type === 'tool_execution_start' && event.toolName === 'bash')
    const idle = wait(event => event.type === 'agent_end')
    await command('prompt', { message: `First use bash to run "sleep 3; printf TOOL_READY". After that, write "old instruction" to ${forbidden} using write. Do not skip the bash call.` })
    await toolStart
    await command('steer', { message: `Change of plan: do not write any file. Reply with exactly ${marker} after the running tool completes.` })
    const steered = await idle
    assert(JSON.stringify(steered).includes(marker), JSON.stringify(steered))
    await assert.rejects(access(forbidden), { code: 'ENOENT' })
    const after = await health()
    assert.equal(after.completed - before.completed, 1, 'Steering must continue the existing agy process')
    assert.equal(after.pendingToolProcesses, 0, 'No abandoned pending-tool process')
    assert.equal(after.activeProcesses, 0, 'Completed conversations must be idle')
    report.passed.push('actual Pi steering during a tool call: same process, changed instruction, no stale write')
    console.log('PASS Pi steering')

    await prompt(`Remember ${marker}. Explain in about 600 words what client-owned tool execution means. Do not use tools.`)
    const compacted = await command('compact', { customInstructions: `Retain the exact marker ${marker} and the fact that the cancelled write must not happen.` })
    assert(compacted?.summary?.includes(marker), JSON.stringify(compacted))
    const recalled = await prompt('What exact STEER_ marker did we retain? Reply with it only, without using tools.')
    assert(JSON.stringify(recalled).includes(marker), JSON.stringify(recalled))
    report.passed.push('actual Pi manual compaction and tool-free recall of the retained context')
    console.log('PASS Pi compaction')

    const abortedIdle = wait(event => event.type === 'agent_end')
    await command('prompt', { message: 'Do not use tools. Write a detailed 10000-word explanation of graph algorithms, with many worked examples.' })
    const deadline = Date.now() + 30000
    while ((await health()).activeProcesses === 0) { assert(Date.now() < deadline, 'Model request never became active'); await new Promise(resolve => setTimeout(resolve, 50)) }
    await command('abort')
    await abortedIdle
    const stoppedBy = Date.now() + 10000
    while ((await health()).activeProcesses) { assert(Date.now() < stoppedBy, 'Abort leaked an agy process'); await new Promise(resolve => setTimeout(resolve, 50)) }
    const recovered = await prompt(`Reply exactly RECOVERED_${marker}. Do not use tools.`)
    assert(JSON.stringify(recovered).includes(`RECOVERED_${marker}`), JSON.stringify(recovered))
    report.passed.push('actual Pi abort releases active process and next prompt succeeds')
    console.log('PASS Pi abort and recovery')
  } finally {
    await writeFile(join(root, 'pi-rpc-events.json'), JSON.stringify(events, null, 2))
    await writeFile(join(root, 'pi-rpc.stderr'), stderr)
    if (!exited) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
      await new Promise(resolve => child.once('close', resolve)).finally(() => clearTimeout(timer))
    }
  }
}
