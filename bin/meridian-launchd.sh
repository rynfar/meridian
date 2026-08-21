#!/bin/sh
#
# Launch Meridian as a long-running service without drifting from the release.
#
# A service pointed straight at a checkout's `dist/cli.js` runs whatever was
# last built there. Build on a feature branch, and the next restart — a crash,
# a reboot, KeepAlive — silently serves unreleased code. `/health` cannot warn
# you, because the version string it reports comes from package.json and is
# identical on the branch and the tag.
#
# So this runs the *installed* package by default, and updates it when the
# registry is ahead. Development builds are still one env var away, and they
# announce themselves in `/health` and in the site header rather than passing
# as a release.
#
#   Normal service use:   bin/meridian-launchd.sh
#   Test a local build:   MERIDIAN_DEV_BUILD=1 MERIDIAN_PORT=3457 bin/meridian-launchd.sh
#
# Every exit path execs something. Under launchd's KeepAlive, a launcher that
# refuses to start is a proxy that is simply down, which is worse than one
# running a known-stale version.

set -u

PACKAGE="@rynfar/meridian"
CDPATH=""
REPO_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/meridian"
UPDATE_STAMP="$CACHE_DIR/launcher-update-check"

# Bound how often a restart loop may talk to the registry. KeepAlive can
# restart this many times a minute; without a floor, a crash loop becomes a
# request flood.
MIN_CHECK_INTERVAL_SECONDS=3600

log() { echo "[meridian-launchd] $*"; }

# --- Development build: explicit, stamped, never mistaken for a release ---

if [ "${MERIDIAN_DEV_BUILD:-}" = "1" ]; then
  if [ ! -f "$REPO_DIR/dist/cli.js" ]; then
    log "MERIDIAN_DEV_BUILD=1 but $REPO_DIR/dist/cli.js is missing — run 'npm run build' first."
    exit 1
  fi
  MERIDIAN_BUILD_SOURCE="dev"
  MERIDIAN_BUILD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  MERIDIAN_BUILD_BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
    MERIDIAN_BUILD_DIRTY="1"
  else
    MERIDIAN_BUILD_DIRTY="0"
  fi
  export MERIDIAN_BUILD_SOURCE MERIDIAN_BUILD_SHA MERIDIAN_BUILD_BRANCH MERIDIAN_BUILD_DIRTY
  log "dev build: ${MERIDIAN_BUILD_BRANCH:-?} @ $(echo "$MERIDIAN_BUILD_SHA" | cut -c1-8)${MERIDIAN_BUILD_DIRTY:+ (dirty=$MERIDIAN_BUILD_DIRTY)}"
  exec node "$REPO_DIR/dist/cli.js" "$@"
fi

# --- Release build: run what is installed, keep it current ---

CLI="$(command -v meridian 2>/dev/null || true)"

should_check() {
  [ "${MERIDIAN_NO_SELF_UPDATE:-}" = "1" ] && return 1
  [ -f "$UPDATE_STAMP" ] || return 0
  last="$(cat "$UPDATE_STAMP" 2>/dev/null || echo "")"
  # A truncated or garbage stamp would blow up the arithmetic below, and under
  # `set -u` that aborts the function — permanently disabling the update check
  # while the bad file sits there. Treat anything non-numeric as no stamp.
  case "$last" in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "$(( $(date +%s) - last ))" -ge "$MIN_CHECK_INTERVAL_SECONDS" ]
}

registry_latest() {
  # Honours the same override as the in-process check (see updateCheck.ts), so
  # a mirror configured for one applies to both.
  node -e '
    const url = process.env.MERIDIAN_UPDATE_CHECK_URL
      || "https://registry.npmjs.org/-/package/'"$PACKAGE"'/dist-tags"
    fetch(url, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => process.stdout.write(typeof d?.latest === "string" ? d.latest : ""))
      .catch(() => {})
  ' 2>/dev/null
}

if [ -n "$CLI" ] && should_check; then
  # Stamp BEFORE attempting anything network-bound. If the install below hangs
  # or the process is killed mid-update, the next restart waits out the
  # interval instead of retrying immediately, forever.
  mkdir -p "$CACHE_DIR" 2>/dev/null
  date +%s > "$UPDATE_STAMP" 2>/dev/null

  INSTALLED="$("$CLI" --version 2>/dev/null || echo "")"
  LATEST="$(registry_latest)"

  if [ -n "$LATEST" ] && [ -n "$INSTALLED" ] && [ "$LATEST" != "$INSTALLED" ]; then
    log "updating $PACKAGE: $INSTALLED -> $LATEST"
    if command -v volta >/dev/null 2>&1 && [ -x "$HOME/.volta/bin/meridian" ]; then
      volta install "$PACKAGE@$LATEST" || log "volta install failed — continuing on $INSTALLED"
    else
      npm install -g "$PACKAGE@$LATEST" || log "npm install failed — continuing on $INSTALLED"
    fi
    CLI="$(command -v meridian 2>/dev/null || echo "$CLI")"
  fi
fi

if [ -n "$CLI" ]; then
  MERIDIAN_BUILD_SOURCE="npm"
  export MERIDIAN_BUILD_SOURCE
  exec "$CLI" "$@"
fi

# No installed package. Fall back to the checkout so the service still comes
# up, but stamp it honestly — this is exactly the drift the launcher exists to
# make visible, so it must not be reported as a release.
log "no installed $PACKAGE found on PATH — falling back to the local build at $REPO_DIR/dist/cli.js"
log "install the release with: npm install -g $PACKAGE"
if [ ! -f "$REPO_DIR/dist/cli.js" ]; then
  log "and $REPO_DIR/dist/cli.js does not exist either — nothing to run."
  exit 1
fi
MERIDIAN_BUILD_SOURCE="local"
MERIDIAN_BUILD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")"
MERIDIAN_BUILD_BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
export MERIDIAN_BUILD_SOURCE MERIDIAN_BUILD_SHA MERIDIAN_BUILD_BRANCH
exec node "$REPO_DIR/dist/cli.js" "$@"
