#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
TARGET_SKILL_DIR="$CODEX_HOME/skills/agent-teams"

if [[ -d "$TARGET_SKILL_DIR" ]]; then
  rm -rf "$TARGET_SKILL_DIR"
  echo "uninstall:removed=$TARGET_SKILL_DIR"
else
  echo "uninstall:noop=$TARGET_SKILL_DIR"
fi

echo "uninstall:ok"
