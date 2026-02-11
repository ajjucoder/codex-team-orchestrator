import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';
import { registerRebalancerTools } from '../../mcp/server/tools/rebalancer.js';

const dbPath = '.tmp/v3-102-staffing-unit.sqlite';
const logPath = '.tmp/v3-102-staffing-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-102 unit: rebalancer accounts for dependency depth and preserves max_threads hard cap', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTaskBoardTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerRebalancerTools(server);

  const started = server.callTool('team_start', { objective: 'depth-aware staffing', max_threads: 6 });
  const teamId = started.team.team_id as string;
  const t1 = server.callTool('team_task_create', { team_id: teamId, title: 't1', priority: 1 }).task;
  const t2 = server.callTool('team_task_create', { team_id: teamId, title: 't2', priority: 2, depends_on_task_ids: [t1.task_id] }).task;
  const t3 = server.callTool('team_task_create', { team_id: teamId, title: 't3', priority: 3, depends_on_task_ids: [t2.task_id] }).task;
  server.callTool('team_task_create', { team_id: teamId, title: 't4', priority: 4, depends_on_task_ids: [t3.task_id] });

  const rebalance = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    estimated_parallel_tasks: 1,
    max_scale_up: 6,
    max_scale_down: 0
  });
  assert.equal(rebalance.ok, true);
  assert.equal(rebalance.plan.backlog.critical_path_depth >= 4, true);
  assert.equal(rebalance.plan.backlog.estimated_parallel_tasks >= 4, true);
  assert.equal(rebalance.plan.target_threads <= 6, true);

  server.store.close();
  cleanup();
});

test('V3-102 unit: team_spawn_ready_roles derives role-shaped staffing from ready DAG backlog', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTaskBoardTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);

  const started = server.callTool('team_start', { objective: 'dag role spawn', max_threads: 6 });
  const teamId = started.team.team_id as string;
  server.callTool('team_task_create', {
    team_id: teamId,
    title: 'review gate',
    priority: 1,
    required_role: 'reviewer'
  });
  server.callTool('team_task_create', {
    team_id: teamId,
    title: 'test gate',
    priority: 2,
    required_role: 'tester'
  });

  const roleShaped = server.callTool('team_spawn_ready_roles', {
    team_id: teamId,
    max_new_agents: 4
  });
  assert.equal(roleShaped.ok, true);
  assert.equal(roleShaped.spawned_count >= 1, true);
  assert.equal(Array.isArray(roleShaped.role_candidates), true);
  assert.equal(roleShaped.role_candidates.includes('reviewer'), true);
  assert.equal(roleShaped.role_candidates.includes('tester'), true);
  assert.equal(roleShaped.spawned_count <= 6, true);

  server.store.close();
  cleanup();
});
