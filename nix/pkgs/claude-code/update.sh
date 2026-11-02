#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
cd "$(git rev-parse --show-toplevel)"

BASE_URL=https://downloads.claude.ai/claude-code-releases

FLOOR=$(nix eval --impure --raw --expr '
  (builtins.fromJSON (builtins.readFile ./package.json)).dependencies."@anthropic-ai/claude-code"
')
VERSION=${FLOOR#^}

for manifest in manifest.json manifest.zst.json; do
  curl -fsSL --output nix/pkgs/claude-code/"$manifest" "$BASE_URL"/"$VERSION"/"$manifest"
done
