/**
 * Whether a settings change came from this server.
 *
 * The optional API key does not stop a foreign page from reconfiguring an
 * unkeyed local server, so a setting that discloses something, or chooses
 * what runs, accepts a browser request only from this server's own pages.
 * Requests without an Origin (the CLI, curl) keep working. Node sees HTTP
 * behind a TLS terminator, so its HTTPS public origin is accepted only when
 * host and port match; forwarding headers confer no trust.
 *
 * Standard web types only: shared by the Claude and Antigravity settings routes.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  try {
    const source = new URL(origin), target = new URL(request.url)
    return source.origin === origin && (source.origin === target.origin
      || (source.protocol === "https:" && target.protocol === "http:" && source.hostname === target.hostname
        && (source.port === target.port || (source.port === "" && target.port === "443"))))
  } catch {
    return false
  }
}
