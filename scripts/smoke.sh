#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ -z "$mode" ]]; then
  echo "smoke:error usage ./scripts/smoke.sh <small|medium|high>" >&2
  exit 1
fi

node --input-type=module - "$mode" <<'NODE'
import assert from 'node:assert/strict';
import { createServer } from './mcp/server/index.js';
import { registerTeamLifecycleTools } from './mcp/server/tools/team-lifecycle.js';
import { registerFanoutTools } from './mcp/server/tools/fanout.js';

const mode = process.argv[2];
const config = {
  small: { task_size: 'small', expectedMin: 1, expectedMax: 2, estimated_parallel_tasks: 2 },
  medium: { task_size: 'medium', expectedMin: 3, expectedMax: 4, estimated_parallel_tasks: 4 },
  high: { task_size: 'high', expectedMin: 5, expectedMax: 6, estimated_parallel_tasks: 6 }
}[mode];

if (!config) {
  throw new Error(`unknown smoke mode: ${mode}`);
}

const dbPath = `.tmp/smoke-${mode}.sqlite`;
const logPath = `.tmp/smoke-${mode}.log`;
const server = createServer({ dbPath, logPath });
server.start();
registerTeamLifecycleTools(server);
registerFanoutTools(server);

const team = server.callTool('team_start', {
  objective: `smoke-${mode}`,
  profile: mode === 'high' ? 'deep' : 'default',
  max_threads: 6
});

const plan = server.callTool('team_plan_fanout', {
  team_id: team.team.team_id,
  task_size: config.task_size,
  estimated_parallel_tasks: config.estimated_parallel_tasks,
  budget_tokens_remaining: 30000,
  token_cost_per_agent: 1000
});

const threads = plan.recommendation.recommended_threads;
assert.equal(threads >= config.expectedMin && threads <= config.expectedMax, true);
assert.equal(threads <= 6, true);

console.log(`smoke:mode=${mode}`);
console.log(`smoke:threads=${threads}`);
console.log('smoke:ok');

server.store.close();
NODE
