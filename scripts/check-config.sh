#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

required_paths=(
  "$REPO_ROOT/mcp/server"
  "$REPO_ROOT/mcp/schemas"
  "$REPO_ROOT/mcp/store"
  "$REPO_ROOT/skills/agent-teams/SKILL.md"
  "$REPO_ROOT/profiles/default.team.yaml"
  "$REPO_ROOT/profiles/fast.team.yaml"
  "$REPO_ROOT/profiles/deep.team.yaml"
)

for path in "${required_paths[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "check-config:error missing $path" >&2
    exit 1
  fi
done

node --import tsx --input-type=module -e "
import { PolicyEngine } from './mcp/server/policy-engine.ts';
const engine = new PolicyEngine('profiles');
for (const p of ['default', 'fast', 'deep']) {
  const loaded = engine.loadProfile(p);
  if (!loaded || loaded.profile !== p) {
    throw new Error('invalid profile: ' + p);
  }
}
console.log('check-config:profiles=ok');
"

echo "check-config:ok"
