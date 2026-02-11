import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';
import { registerRebalancerTools } from '../../mcp/server/tools/rebalancer.js';

const dbPath = '.tmp/v3-102-staffing-int.sqlite';
const logPath = '.tmp/v3-102-staffing-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-102 integration: dynamic staffing rebalances up/down with backlog changes and keeps cap <= 6', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTaskBoardTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerRebalancerTools(server);

  const started = server.callTool('team_start', { objective: 'integration staffing', max_threads: 6 });
  const teamId = started.team.team_id as string;
  server.callTool('team_spawn', { team_id: teamId, role: 'lead' });

  for (let i = 0; i < 6; i += 1) {
    server.callTool('team_task_create', {
      team_id: teamId,
      title: `backlog-${i}`,
      priority: (i % 3) + 1,
      required_role: i % 2 === 0 ? 'implementer' : 'tester'
    });
  }

  const up = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    task_size: 'high',
    estimated_parallel_tasks: 6,
    budget_tokens_remaining: 24000,
    max_scale_up: 6,
    max_scale_down: 0
  });
  assert.equal(up.ok, true);
  assert.equal(up.actions.scaled_up > 0, true);

  const activeAfterUp = server.store.listAgentsByTeam(teamId).filter((agent) => agent.status !== 'offline').length;
  assert.equal(activeAfterUp <= 6, true);

  const tasks = server.callTool('team_task_list', { team_id: teamId });
  for (const task of tasks.tasks as Array<Record<string, unknown>>) {
    if (task.status !== 'todo') continue;
    const claimer = server.store
      .listAgentsByTeam(teamId)
      .find((agent) => agent.status !== 'offline' && agent.role === (task.required_role ?? agent.role));
    if (!claimer) continue;
    const claimed = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: task.task_id,
      agent_id: claimer.agent_id,
      expected_lock_version: task.lock_version
    });
    if (claimed.ok !== true) continue;
    server.callTool('team_task_update', {
      team_id: teamId,
      task_id: task.task_id,
      status: 'done',
      expected_lock_version: claimed.task.lock_version,
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
  }

  const down = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    task_size: 'small',
    estimated_parallel_tasks: 1,
    budget_tokens_remaining: 4000,
    max_scale_up: 0,
    max_scale_down: 6
  });
  assert.equal(down.ok, true);
  assert.equal(down.actions.scaled_down >= 1, true);

  const activeAfterDown = server.store.listAgentsByTeam(teamId).filter((agent) => agent.status !== 'offline').length;
  assert.equal(activeAfterDown <= 6, true);

  server.store.close();
  cleanup();
});
