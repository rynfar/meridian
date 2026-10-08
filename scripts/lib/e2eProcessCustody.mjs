/** Attach at spawn time: leader exit alone never establishes captured-pipe closure. */
export function observeChildClosure(child) {
  const state = {
    exitSeen: false, closeSeen: false, stdoutClosed: child.stdout === null,
    stderrClosed: child.stderr === null, spawnFailed: false,
    exitCode: null, exitSignal: null, joined: false, termSent: false, killSent: false, signalFailure: null,
  }
  let resolveJoined
  const joined = new Promise(resolve => { resolveJoined = resolve })
  const complete = () => {
    if (!state.joined && (state.exitSeen || state.spawnFailed) && state.closeSeen && state.stdoutClosed && state.stderrClosed) {
      state.joined = true
      resolveJoined()
    }
  }
  child.once('error', () => { state.spawnFailed = !child.pid; complete() })
  child.once('exit', (code, signal) => { Object.assign(state, {exitSeen: true, exitCode: code, exitSignal: signal}); complete() })
  child.once('close', () => { state.closeSeen = true; complete() })
  child.stdout?.once('close', () => { state.stdoutClosed = true; complete() })
  child.stderr?.once('close', () => { state.stderrClosed = true; complete() })
  return {state, joined}
}

async function waitJoined(witness, ms) {
  if (witness.state.joined) return true
  let timer
  try {
    return await Promise.race([
      witness.joined.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Signal only the original live ChildProcess. Retain missing witnesses as failure. */
export async function stopAndJoinChild(child, witness, {graceMs = 20000, forceMs = 3000} = {}) {
  const signal = (name, field) => {
    if (witness.state.exitSeen || witness.state.closeSeen || !child.pid) return
    try { witness.state[field] = child.kill(name) }
    catch { witness.state.signalFailure ??= `${name} could not be sent to the original child` }
  }
  if (!witness.state.joined) signal('SIGTERM', 'termSent')
  if (!await waitJoined(witness, graceMs)) {
    signal('SIGKILL', 'killSent')
    await waitJoined(witness, forceMs)
  }
  return {...witness.state}
}
