#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH=".tmp/v2-release-benchmark-report.json"

npm run lint
npm run test:unit
npm run test:integration
./scripts/verify.sh
./scripts/check-config.sh
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive --out "$REPORT_PATH"
node --import tsx ./scripts/v2-eval-gates.ts \
  --report "$REPORT_PATH" \
  --min-quality 0.95 \
  --max-quality-drop 0 \
  --min-token-reduction 1
./scripts/package-release.sh

echo "release-ready:ok"
