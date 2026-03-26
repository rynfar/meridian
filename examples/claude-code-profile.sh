#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-personal}"
BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:4567}"

case "$PROFILE" in
  personal|company)
    ;;
  *)
    printf 'Usage: %s [personal|company]\n' "$0" >&2
    exit 1
    ;;
esac

ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-x}" \
ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_CUSTOM_HEADERS="x-meridian-profile: $PROFILE" \
claude "${@:2}"
