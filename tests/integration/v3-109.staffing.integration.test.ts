import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';
import { registerTriggerTools } from '../../mcp/server/tools/trigger.js';

const dbPath = '.tmp/v3-109-staffing-int.sqlite';
const logPath = '.tmp/v3-109-staffing-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V3-109 integration: trigger specialization auto-spawns planned specialist roles in deterministic order', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerAgentLifecycleTools(server);
    registerFanoutTools(server);
    registerTriggerTools(server);

    const triggered = server.callTool('team_trigger', {
      prompt: 'use agents team run parallel feature delivery with review and test gates',
      task_size: 'high',
      max_threads: 4,
      active_session_model: 'gpt-5-codex'
    });

    assert.equal(triggered.ok, true);
    assert.equal(triggered.triggered, true);
    assert.equal(triggered.orchestration.spawn_strategy, 'static_sequence');

    const plannedRoles = triggered.orchestration.planned_roles as string[];
    const spawnedRoles = (triggered.orchestration.spawned_agents as Array<Record<string, unknown>>)
      .map((agent) => String(agent.role ?? ''));

    assert.equal(plannedRoles.length >= 1, true);
    assert.equal(plannedRoles.length <= 4, true);
    assert.deepEqual(spawnedRoles, plannedRoles);
    assert.equal(triggered.orchestration.spawned_count, plannedRoles.length);
    assert.equal(new Set(spawnedRoles).size, spawnedRoles.length);

    const teamId = triggered.team.team_id as string;
    const status = server.callTool('team_status', { team_id: teamId });
    assert.equal(status.ok, true);
    assert.equal(status.metrics.agents, plannedRoles.length);
  } finally {
    server.store.close();
  }
});

test('V3-109 integration: trigger planning output feeds backlog-aware ready-role specialization', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerFanoutTools(server);
    registerTriggerTools(server);

    const triggered = server.callTool('team_trigger', {
      prompt: 'use agents team coordinate medium implementation and verification with parallel streams',
      task_size: 'medium',
      auto_spawn: false,
      max_threads: 4,
      active_session_model: 'gpt-5-codex'
    });

    assert.equal(triggered.ok, true);
    assert.equal(triggered.triggered, true);
    assert.equal(triggered.orchestration.auto_spawn_enabled, false);
    assert.equal(triggered.orchestration.spawned_count, 0);
    assert.equal(triggered.orchestration.recommended_threads >= 1, true);
    assert.equal(triggered.orchestration.recommended_threads <= 4, true);

    const plannedRoles = triggered.orchestration.planned_roles as string[];
    assert.equal(plannedRoles.length, Number(triggered.orchestration.recommended_threads));
    assert.equal(plannedRoles[0], 'implementer');

    const teamId = triggered.team.team_id as string;
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

    const shaped = server.callTool('team_spawn_ready_roles', {
      team_id: teamId,
      max_new_agents: 2
    });

    assert.equal(shaped.ok, true);
    assert.deepEqual(shaped.role_candidates, ['reviewer', 'tester']);
    assert.equal(shaped.spawned_count, 2);
    assert.deepEqual(
      (shaped.spawned_agents as Array<Record<string, unknown>>).map((agent) => agent.role),
      ['reviewer', 'tester']
    );
  } finally {
    server.store.close();
  }
});
