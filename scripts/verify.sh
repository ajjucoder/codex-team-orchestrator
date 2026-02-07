#!/usr/bin/env bash
set -euo pipefail
npm run format
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
./scripts/check-config.sh
./scripts/smoke.sh small
./scripts/smoke.sh medium
./scripts/smoke.sh high
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
echo "verify:ok"
