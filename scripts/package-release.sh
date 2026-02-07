#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version")"
ARCHIVE="$DIST_DIR/codex-team-orchestrator-$VERSION.tar.gz"

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE"

tar -czf "$ARCHIVE" \
  --exclude='dist' \
  --exclude='.tmp' \
  --exclude='node_modules' \
  -C "$REPO_ROOT" \
  README.md LICENSE CHANGELOG.md package.json docs mcp profiles scripts skills benchmarks tests .github

echo "package-release:archive=$ARCHIVE"
echo "package-release:ok"
