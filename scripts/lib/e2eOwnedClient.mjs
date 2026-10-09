// Own one actual detached client handle. Birth identity is immutable; exit
// retires signaling before stdio joins. A signal call never establishes a join.
export function createOwnedClientProcess(child, sendSignal = process.kill.bind(process)) {
  const facts = { spawned: false, spawnError: false, exit: false, close: false,
    stdoutEnd: !child.stdout, stdoutClose: !child.stdout,
    stderrEnd: !child.stderr, stderrClose: !child.stderr,
    signalAttempts: 0, signalFailures: 0, signals: [] }
  let birthPid, resolveJoin
  const joined = new Promise(resolve => { resolveJoin = resolve })
  const isJoined = () => (facts.exit || facts.spawnError && !facts.spawned) && facts.close
    && facts.stdoutEnd && facts.stdoutClose && facts.stderrEnd && facts.stderrClose
  const check = () => { if (isJoined()) resolveJoin() }
  child.once('spawn', () => { birthPid = child.pid; facts.spawned = true })
  child.once('error', () => { facts.spawnError = true; check() })
  child.once('exit', () => { facts.exit = true; check() })
  child.once('close', () => { facts.close = true; check() })
  for (const name of ['stdout', 'stderr']) if (child[name]) {
    child[name].once('end', () => { facts[`${name}End`] = true; check() })
    child[name].once('close', () => { facts[`${name}Close`] = true; check() })
  }
  return {
    joined, isJoined,
    signal(signal) {
      if (!facts.spawned || facts.exit || facts.close) return 'RETIRED_OR_NOT_STARTED'
      const observation = { signal, result: 'FAILED' }
      // A missing/invalid birth PID confers no group authority.
      if (!Number.isSafeInteger(birthPid) || birthPid <= 1) observation.code = 'INVALID_BIRTH_PID'
      else {
        try { sendSignal(-birthPid, signal); observation.result = 'SENT' }
        catch (error) {
          observation.code = /^[A-Z0-9_]{1,48}$/.test(error?.code) ? error.code : 'UNKNOWN_SIGNAL_ERROR'
          if (error?.code === 'ESRCH') observation.result = 'NOT_FOUND'
        }
      }
      facts.signalAttempts++
      if (observation.result === 'FAILED') facts.signalFailures++
      if (facts.signals.length < 16) facts.signals.push(observation)
      return observation.result
    },
    snapshot() {
      return { ...facts, signals: facts.signals.map(value => ({ ...value })), join: isJoined() ? 'JOINED' : 'UNKNOWN' }
    },
  }
}

