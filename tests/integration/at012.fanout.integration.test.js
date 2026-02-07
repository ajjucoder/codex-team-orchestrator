import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';

const dbPath = '.tmp/at012-int.sqlite';
const logPath = '.tmp/at012-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-012 integration: adaptive fanout produces small/medium/high bands with hard cap', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerFanoutTools(server);

  const team = server.callTool('team_start', {
    objective: 'adaptive fanout test',
    profile: 'default',
    max_threads: 6
  });
  const teamId = team.team.team_id;

  const small = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'small',
    estimated_parallel_tasks: 2,
    budget_tokens_remaining: 5000,
    token_cost_per_agent: 1000
  });

  const medium = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'medium',
    estimated_parallel_tasks: 4,
    budget_tokens_remaining: 12000,
    token_cost_per_agent: 2000
  });

  const high = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'high',
    estimated_parallel_tasks: 12,
    budget_tokens_remaining: 20000,
    token_cost_per_agent: 3000
  });

  assert.equal(small.recommendation.recommended_threads >= 1 && small.recommendation.recommended_threads <= 2, true);
  assert.equal(medium.recommendation.recommended_threads >= 3 && medium.recommendation.recommended_threads <= 4, true);
  assert.equal(high.recommendation.recommended_threads >= 5 && high.recommendation.recommended_threads <= 6, true);
  assert.equal(high.recommendation.recommended_threads <= 6, true);

  server.store.close();
});
