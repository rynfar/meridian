#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

MERIDIAN_PORT=3457 exec bin/claude-proxy-supervisor.sh
