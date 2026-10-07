// Routine operational stderr shares the proxy's existing process-wide silence
// policy. Diagnostics remain available when an embedding TUI suppresses stderr.
let silent = false

export function setProxyLogSilent(value: boolean): void {
  silent = value
}

export function plog(message: string): void {
  if (!silent) console.error(message)
}

// Session-layer diagnostics reach the telemetry store through a sink the proxy
// registers, so the session layer can be imported without opening telemetry:
// the bookkeeping CLI runs beside a live proxy and must not touch its database.
let diagnosticSink: ((message: string) => void) | undefined

export function setProxyDiagnosticSink(sink: ((message: string) => void) | undefined): void {
  diagnosticSink = sink
}

export function pdiagnostic(message: string): void {
  diagnosticSink?.(message)
}
