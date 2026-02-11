import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';

const dbPath = '.tmp/v3-105-optimizer-int.sqlite';
const logPath = '.tmp/v3-105-optimizer-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-105 integration: team_plan_fanout returns optimizer decision bound to recommendation', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerFanoutTools(server);

  const started = server.callTool('team_start', {
    objective: 'optimizer integration',
    profile: 'fast',
    max_threads: 6
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const planned = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'high',
    estimated_parallel_tasks: 6,
    budget_tokens_remaining: 5000,
    enforce_optimizer: true
  });
  assert.equal(planned.ok, true);
  assert.equal(typeof planned.optimizer, 'object');
  assert.equal(planned.recommendation.recommended_threads, planned.optimizer.optimized_threads);
  assert.equal(planned.recommendation.recommended_threads <= 6, true);
  assert.equal(typeof planned.optimizer.meets_slo.quality, 'boolean');

  server.store.close();
  cleanup();
});

test('V3-105 integration: optimizer recommendation is capped by runtime budget_tokens_remaining', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerFanoutTools(server);

  const started = server.callTool('team_start', {
    objective: 'optimizer runtime cap integration',
    profile: 'fast',
    max_threads: 6
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const constrained = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'medium',
    estimated_parallel_tasks: 6,
    token_cost_per_agent: 1000,
    budget_tokens_remaining: 2500,
    enforce_optimizer: true
  });
  const unconstrained = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'medium',
    estimated_parallel_tasks: 6,
    token_cost_per_agent: 1000,
    budget_tokens_remaining: 5000,
    enforce_optimizer: true
  });

  assert.equal(constrained.ok, true);
  assert.equal(unconstrained.ok, true);
  assert.equal(constrained.optimizer.constraints.token_budget, 2500);
  assert.equal(unconstrained.optimizer.constraints.token_budget, 5000);
  assert.equal(constrained.optimizer.meets_slo.cost, false);
  assert.equal(unconstrained.optimizer.meets_slo.cost, true);
  assert.equal(constrained.optimizer.reason, 'best_tradeoff_under_constraints');
  assert.equal(unconstrained.optimizer.reason, 'meets_all_slo');

  server.store.close();
  cleanup();
});
