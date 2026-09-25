/**
 * systemd socket-activation and idle-shutdown helpers (pure — no I/O).
 *
 * Detection follows the sd_listen_fds protocol: when systemd activates a
 * service, it passes one or more listening file descriptors starting at fd 3
 * (SD_LISTEN_FDS_START) and sets `LISTEN_FDS=<count>` + `LISTEN_PID=<pid>` in
 * the environment. The pid gate prevents a stale activation env from a parent
 * process being consumed by an unrelated child after fork.
 *
 * These helpers are pure (env + pid passed in) so they can be unit-tested
 * without spawning systemd. startProxyServer wires them into the server
 * lifecycle: socketActivationFd selects fd adoption vs. port binding, and
 * parseIdleExitSeconds drives the opt-in self-exit watchdog.
 */

/** First fd systemd passes (SD_LISTEN_FDS_START). */
export const SD_LISTEN_FDS_START = 3

/**
 * Return the inherited listening fd when running under systemd socket
 * activation, otherwise undefined.
 *
 * Validates `LISTEN_PID` against the supplied pid (defaults to the current
 * process) so a forked child never mistakes its parent's activation env, and
 * requires `LISTEN_FDS` to be a positive integer. Only the first fd (3) is
 * returned — meridian binds a single listener.
 *
 * @param env environment record to read (defaults to process.env)
 * @param pid pid to match against LISTEN_PID (defaults to process.pid)
 */
export function socketActivationFd(
	env: NodeJS.ProcessEnv = process.env,
	pid: number = process.pid,
): number | undefined {
	if (!/^\d+$/.test(env.LISTEN_PID ?? "") || !/^\d+$/.test(env.LISTEN_FDS ?? "")) return undefined
	const listenPid = Number(env.LISTEN_PID)
	const fds = Number(env.LISTEN_FDS)
	if (!Number.isSafeInteger(listenPid) || listenPid !== pid) return undefined
	if (!Number.isSafeInteger(fds) || fds < 1) return undefined
	return SD_LISTEN_FDS_START
}

/** Count only model requests as idle-exit activity; health polls may be frequent. */
export function isModelRequestPath(path: string): boolean {
	return /^\/v1\/(?:messages|chat\/completions|responses)(?:[/?]|$)/.test(path)
}

/**
 * Parse the opt-in idle-exit timeout (seconds). When set, the proxy exits
 * gracefully after this many seconds with no `/v1/messages` activity and no
 * in-flight sessions. systemd socket activation then restarts it on the next
 * connection. Returns undefined (never auto-exit) when unset or invalid.
 *
 * Accepts the MERIDIAN_ name and the legacy CLAUDE_PROXY_ alias. Values < 1
 * second are treated as invalid and ignored.
 *
 * @param env environment record to read (defaults to process.env)
 */
export function parseIdleExitSeconds(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.MERIDIAN_IDLE_EXIT_SECONDS ?? env.CLAUDE_PROXY_IDLE_EXIT_SECONDS
	if (raw === undefined || raw === "") return undefined
	if (!/^\d+$/.test(raw)) return undefined
	const seconds = Number(raw)
	if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > Number.MAX_SAFE_INTEGER / 1000) return undefined
	return seconds
}
