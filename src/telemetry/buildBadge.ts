/**
 * Header build badge - what the shared site header says about the running code.
 *
 * Two independent readings, rendered side by side:
 * - identity, from `/health`'s `build` block: release, local build counter,
 *   branch, commit and working-tree state of THIS process;
 * - drift, from `GET /build-status` (local/dev builds only): whether a newer
 *   build or changed source is waiting on disk.
 *
 * Both functions are serialized with `.toString()` into the header's inline
 * script (the providerSetup.ts pattern), so each must stay self-contained:
 * no references to anything outside its own body. They take `unknown` because
 * the browser hands them raw JSON; every field is narrowed here, and a field
 * that is absent or malformed is omitted rather than guessed.
 */

export interface BuildBadgePart {
  readonly kind: "version" | "run" | "branch" | "commit" | "dirty"
  readonly text: string
  /** Only ever an `https:` URL without credentials. */
  readonly href?: string
  readonly title: string
  /** A run part's abbreviation, for the header's compact form ("v1.77.1-src"). */
  readonly short?: string
}

export type BuildIdentityView =
  | { readonly mode: "hidden" }
  | { readonly mode: "update"; readonly text: string; readonly href: string; readonly title: string }
  | { readonly mode: "local"; readonly parts: readonly BuildBadgePart[]; readonly label: string; readonly title: string }

export interface BuildDriftView {
  readonly tone: "calm" | "neutral" | "warning"
  readonly text: string
  readonly title: string
}

export function buildIdentityView(build: unknown): BuildIdentityView {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }
  function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  function safeHttps(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    try {
      const url = new URL(value)
      return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined
    } catch (error) {
      if (error instanceof TypeError) return undefined
      throw error
    }
  }

  if (!isRecord(build)) return { mode: "hidden" }
  const version = text(build.version)
  if (build.source === "npm") {
    const latest = text(build.latest)
    if (build.updateAvailable !== true || !latest) return { mode: "hidden" }
    return {
      mode: "update",
      text: latest + " available",
      href: "https://github.com/rynfar/meridian/releases",
      title: "Running " + (version ?? "unknown") + " - update with:\nnpm install -g @rynfar/meridian@latest",
    }
  }

  const parts: BuildBadgePart[] = []
  const lines = [build.source === "dev" ? "Dev build - not an npm release" : "Local build - not an npm release"]
  const release = text(build.releaseVersion)
  if (release) {
    parts.push({ kind: "version", text: "v" + release.replace(/^v/, ""), title: "Last release this tree descends from" })
  } else if (version && version !== "unknown") {
    parts.push({ kind: "version", text: "package " + version, title: "Package version; release ancestry is unknown" })
  }
  const display = text(build.displayVersion)
  if (display) lines.push("build: " + display)
  if (version && version !== release) lines.push("package version: " + version)

  const counter = build.counter
  if (build.kind === "artifact" && typeof counter === "number" && Number.isSafeInteger(counter) && counter > 0) {
    parts.push({ kind: "run", text: "local #" + counter, short: "#" + counter, title: "Local build number " + counter })
  } else if (build.kind === "artifact") {
    parts.push({ kind: "run", text: "unnumbered", short: "local", title: "Built artifact without a verified build number" })
  } else if (build.kind === "source") {
    parts.push({ kind: "run", text: "source run", short: "src", title: "Running directly from source; no build number" })
  } else {
    const dev = build.source === "dev"
    parts.push({ kind: "run", text: dev ? "dev build" : "local build", short: dev ? "dev" : "local", title: "No build record" })
  }

  const branch = text(build.branch)
  if (branch) {
    const href = safeHttps(build.branchUrl)
    parts.push({ kind: "branch", text: branch, ...(href ? { href } : {}), title: "branch: " + branch })
    lines.push("branch: " + branch)
  }
  const sha = text(build.sha)
  if (sha && /^[0-9a-f]{7,64}$/i.test(sha)) {
    const href = safeHttps(build.commitUrl)
    parts.push({ kind: "commit", text: sha.slice(0, 7), ...(href ? { href } : {}), title: "commit: " + sha })
    lines.push("commit: " + sha)
  }
  if (build.dirty === true) {
    parts.push({ kind: "dirty", text: "dirty", title: "Uncommitted changes were present when this build was taken" })
    lines.push("uncommitted changes present")
  } else if (build.dirty === false) {
    lines.push("clean working tree")
  }
  const builtAt = text(build.builtAt)
  if (builtAt) lines.push("built: " + builtAt)
  if (build.certification === "verified" || build.certification === "unknown") lines.push("certification: " + build.certification)

  return { mode: "local", parts, label: "Running build: " + parts.map((part) => part.text).join(", "), title: lines.join("\n") }
}

export function buildDriftView(status: unknown): BuildDriftView {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }
  function counterOf(build: unknown): number | undefined {
    const counter = isRecord(build) ? build.counter : undefined
    return typeof counter === "number" && Number.isSafeInteger(counter) && counter > 0 ? counter : undefined
  }

  if (!isRecord(status)) {
    return { tone: "neutral", text: "drift unknown", title: "Could not refresh build status; no drift is claimed" }
  }
  const running = counterOf(status.runtime)
  const onDisk = counterOf(status.latest)
  const source = isRecord(status.runtime) && status.runtime.kind === "source"
  switch (status.state) {
    case "current":
      return {
        tone: "calm",
        text: "current",
        title: source ? "Source tree unchanged since this process started" : "Running the newest local build" + (running ? " (#" + running + ")" : ""),
      }
    case "behind": {
      const behind = status.buildsBehind
      const count = typeof behind === "number" && Number.isSafeInteger(behind) && behind > 0 ? behind : undefined
      return {
        tone: "warning",
        text: count ? count + (count === 1 ? " build behind" : " builds behind") : "behind",
        title: "A newer local build" + (onDisk ? " (#" + onDisk + ")" : "") + " is on disk; restart to run it",
      }
    }
    case "rollback":
      return {
        tone: "warning",
        text: "rolled back",
        title: "The build on disk" + (onDisk ? " (#" + onDisk + ")" : "") + " is older than the running one" + (running ? " (#" + running + ")" : ""),
      }
    case "source-changed":
      return { tone: "warning", text: "source changed", title: "The source tree changed since this process started; restart to run it" }
    case "building":
      return { tone: "neutral", text: "building…", title: "A local build is in progress" }
    case "missing":
      return { tone: "neutral", text: "no build record", title: "No local build record found on disk" }
    case "invalid":
      return { tone: "neutral", text: "record invalid", title: "The local build record on disk could not be verified" }
    case "incomparable":
      return { tone: "neutral", text: "not comparable", title: "The running build and the build on disk come from different build histories" }
    default:
      return { tone: "neutral", text: "drift unknown", title: "Build drift cannot be determined" }
  }
}
