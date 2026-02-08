import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerRebalancerTools } from '../../mcp/server/tools/rebalancer.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-014-unit.sqlite';
const logPath = '.tmp/v2-014-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-014 runtime rebalancer scales up and down within hard cap', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);
  registerRebalancerTools(server);

  const started = server.callTool('team_start', {
    objective: 'rebalance',
    max_threads: 6,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  assert.equal(lead.ok, true);

  for (let i = 0; i < 8; i += 1) {
    const created = server.callTool('team_task_create', {
      team_id: teamId,
      title: `task-${i}`,
      priority: 1
    });
    assert.equal(created.ok, true);
  }

  const scaleUp = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    estimated_parallel_tasks: 6,
    budget_tokens_remaining: 40000
  });
  assert.equal(scaleUp.ok, true);
  assert.equal(scaleUp.plan.target_threads <= 6, true);
  assert.equal(scaleUp.actions.scaled_up > 0, true);

  const activeAfterScaleUp = server
    .store
    .listAgentsByTeam(teamId)
    .filter((agent) => agent.status !== 'offline').length;
  assert.equal(activeAfterScaleUp <= 6, true);

  for (const task of server.store.listTasks(teamId)) {
    server.store.updateTask({
      team_id: teamId,
      task_id: task.task_id,
      expected_lock_version: task.lock_version,
      patch: { status: 'done' }
    });
  }

  for (const agent of server.store.listAgentsByTeam(teamId)) {
    if (agent.role !== 'lead' && agent.status !== 'offline') {
      server.store.updateAgentStatus(agent.agent_id, 'idle');
    }
  }

  const scaleDown = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    estimated_parallel_tasks: 1,
    budget_tokens_remaining: 40000,
    max_scale_down: 6
  });
  assert.equal(scaleDown.ok, true);
  assert.equal(scaleDown.actions.scaled_down >= 1, true);

  const activeAfterScaleDown = server
    .store
    .listAgentsByTeam(teamId)
    .filter((agent) => agent.status !== 'offline');
  assert.equal(activeAfterScaleDown.length >= 1, true);
  assert.equal(activeAfterScaleDown.length <= 6, true);

  server.store.close();
});
