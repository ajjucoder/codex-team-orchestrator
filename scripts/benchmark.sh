#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

baseline="fixed-6"
candidate="adaptive"
mode="replay"
eval_set="$REPO_ROOT/benchmarks/replay-eval-set.json"
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline)
      baseline="$2"
      shift 2
      ;;
    --candidate)
      candidate="$2"
      shift 2
      ;;
    --eval-set)
      eval_set="$2"
      shift 2
      ;;
    --mode)
      mode="$2"
      shift 2
      ;;
    --out)
      out="$2"
      shift 2
      ;;
    *)
      echo "benchmark:error unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

args=("$REPO_ROOT/benchmarks/run-benchmark.ts" --baseline "$baseline" --candidate "$candidate" --mode "$mode" --eval-set "$eval_set")
if [[ -n "$out" ]]; then
  args+=(--out "$out")
fi

node --import tsx "${args[@]}"
