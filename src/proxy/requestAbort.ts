/**
 * Request-scoped abort link with an abort-cause registry.
 *
 * Meridian aborts a request's SDK query from several producers (client
 * disconnect, cancelled response body, session turn watchdog, subtree
 * cancellation, process shutdown, the proxy's own passthrough single-step
 * abort). When a capped turn then dies with an opaque SDK termination, the
 * operator needs to know WHICH producer fired — or that none did, which is
 * the discriminating marker for the uncaptured-tool-turn incident
 * (2026-09-10 0a95wd-tusk): an externally-initiated CLI abort masqueraded as
 * "Reached maximum number of turns (1)".
 *
 * The registry latches the FIRST classified cause. `abortSnapshot` is the
 * single read side used by diagnostics. `cause: "none"` means no
 * Meridian-linked abort was observed — it is NOT proof that no abort occurred
 * inside the CLI subprocess; only that nothing Meridian controls aborted.
 */
export type RequestAbortCause =
  | "client_abort"
  | "stream_cancel"
  | "session_watchdog"
  | "process_shutdown"
  | "subtree_cancel"
  | "passthrough_single_step"
  | "unknown_abort"

export const REQUEST_ABORT_CAUSES: readonly RequestAbortCause[] = [
  "client_abort",
  "stream_cancel",
  "session_watchdog",
  "process_shutdown",
  "subtree_cancel",
  "passthrough_single_step",
  "unknown_abort",
] as const

export interface AbortCauseSnapshot {
  /** First classified cause; "none" when the observed signal never aborted. */
  cause: RequestAbortCause | "none"
  /** Whether the linked controller's signal is aborted. */
  aborted: boolean
  /** Monotonic ms from link creation to abort; undefined when not aborted. */
  elapsedMs?: number
}

export interface RequestAbortLink {
  controller: AbortController
  abort: (reason?: unknown) => void
  detach: () => void
  /**
   * Latch the classified cause of an impending abort. First call wins; later
   * labels are ignored so the earliest producer owns the diagnosis. Callers
   * should label BEFORE invoking abort, and may label a cause that arrives
   * with an already-aborted signal.
   */
  setCause: (cause: RequestAbortCause) => void
  /** Read-side snapshot for diagnostics and telemetry. */
  abortSnapshot: () => AbortCauseSnapshot
}

/** Forward an HTTP request abort into the SDK query lifecycle. */
export function linkRequestAbort(signal: AbortSignal): RequestAbortLink {
  const controller = new AbortController()
  let attached = false
  const linkedAt = Date.now()
  let cause: RequestAbortCause | undefined

  const classify = (): RequestAbortCause | "none" => {
    if (!controller.signal.aborted) return "none"
    // Any abort whose producer never labeled is unknown: the label registry
    // is best-effort, not a proof of absence (a direct controller.abort by a
    // third party must not masquerade as "nothing happened").
    return cause ?? "unknown_abort"
  }

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const forwardAbort = () => abort(signal.reason)

  if (signal.aborted) {
    forwardAbort()
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true })
    attached = true
  }

  return {
    controller,
    abort,
    detach: () => {
      if (!attached) return
      signal.removeEventListener("abort", forwardAbort)
      attached = false
    },
    setCause: (labeled) => {
      cause ??= labeled
    },
    abortSnapshot: (): AbortCauseSnapshot => {
      const snapshot: AbortCauseSnapshot = {
        cause: classify(),
        aborted: controller.signal.aborted,
      }
      if (controller.signal.aborted) {
        snapshot.elapsedMs = Math.max(0, Date.now() - linkedAt)
      }
      return snapshot
    },
  }
}
