#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH=".tmp/v2-release-benchmark-report.json"
REQUIRED_MIGRATIONS=(
  "009_worker_runtime_sessions.sql"
  "010_team_wave_state.sql"
  "011_agent_decision_reports.sql"
)

echo "release-ready:check-migrations"
for migration in "${REQUIRED_MIGRATIONS[@]}"; do
  if [[ ! -f "mcp/store/migrations/${migration}" ]]; then
    echo "release-ready:error missing migration mcp/store/migrations/${migration}" >&2
    exit 1
  fi
done

echo "release-ready:deterministic-contract-gates"
npm run test:unit:ts -- tests/unit/v3-111.team-card.test.ts
npm run test:integration:ts -- tests/integration/v3-111.tui.integration.test.ts

echo "release-ready:migration-regression-gates"
npm run test:unit:ts -- tests/unit/v4-002.worker-session-persistence.test.ts tests/unit/v4-004.wave-telemetry.test.ts tests/unit/v4-009.decision-reports.test.ts

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
