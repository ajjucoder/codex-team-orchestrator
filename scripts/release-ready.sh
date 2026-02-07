#!/usr/bin/env bash
set -euo pipefail

npm run lint
npm run test:unit
npm run test:integration
./scripts/verify.sh
./scripts/check-config.sh
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
./scripts/package-release.sh

echo "release-ready:ok"
