#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="$CODEX_HOME/skills"
TARGET_SKILL_DIR="$SKILLS_DIR/agent-teams"

required_files=(
  "$REPO_ROOT/skills/agent-teams/SKILL.md"
  "$REPO_ROOT/skills/agent-teams/references/roles.md"
  "$REPO_ROOT/skills/agent-teams/references/policies.md"
  "$REPO_ROOT/profiles/default.team.yaml"
  "$REPO_ROOT/profiles/fast.team.yaml"
  "$REPO_ROOT/profiles/deep.team.yaml"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "install:error missing required file: $f" >&2
    exit 1
  fi
done

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" -lt 24 ]]; then
  echo "install:error Node.js >= 24 required" >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"
rm -rf "$TARGET_SKILL_DIR"
cp -R "$REPO_ROOT/skills/agent-teams" "$TARGET_SKILL_DIR"

chmod +x "$REPO_ROOT/scripts"/*.sh

echo "install:ok"
echo "install:skill_path=$TARGET_SKILL_DIR"
