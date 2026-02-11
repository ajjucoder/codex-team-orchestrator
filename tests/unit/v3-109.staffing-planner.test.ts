import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { buildStaffingPlan } from '../../mcp/server/staffing-planner.js';

const dbPath = '.tmp/v3-109-staffing-planner-unit.sqlite';
const logPath = '.tmp/v3-109-staffing-planner-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V3-109 unit: staffing planner prioritizes ready-role demand and deduplicates role candidates', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'planner role shaping',
      max_threads: 4
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const seed = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
    assert.equal(seed.ok, true);

    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'review-first',
      priority: 1,
      required_role: 'reviewer'
    });
    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'review-duplicate',
      priority: 2,
      required_role: 'reviewer'
    });
    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'test-second',
      priority: 3,
      required_role: 'tester'
    });
    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'planner-later',
      priority: 4,
      required_role: 'planner'
    });

    const planned = server.callTool('team_spawn_ready_roles', {
      team_id: teamId,
      max_new_agents: 2
    });

    assert.equal(planned.ok, true);
    assert.equal(planned.budget, 2);
    assert.deepEqual(planned.role_candidates, ['reviewer', 'tester']);
    assert.equal(planned.spawned_count, 2);
    assert.deepEqual(
      (planned.spawned_agents as Array<Record<string, unknown>>).map((agent) => agent.role),
      ['reviewer', 'tester']
    );
    assert.equal(Array.isArray(planned.errors), true);
    assert.equal((planned.errors as unknown[]).length, 0);
  } finally {
    server.store.close();
  }
});

test('V3-109 unit: staffing planner respects remaining team capacity even when requested budget is larger', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'capacity clamp',
      max_threads: 2
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
    assert.equal(lead.ok, true);

    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'review-needed',
      priority: 1,
      required_role: 'reviewer'
    });
    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'test-needed',
      priority: 2,
      required_role: 'tester'
    });

    const planned = server.callTool('team_spawn_ready_roles', {
      team_id: teamId,
      max_new_agents: 6
    });

    assert.equal(planned.ok, true);
    assert.equal(planned.budget, 1);
    assert.deepEqual(planned.role_candidates, ['reviewer']);
    assert.equal(planned.spawned_count, 1);

    const activeAgents = server.store.listAgentsByTeam(teamId).filter((agent) => agent.status !== 'offline');
    assert.equal(activeAgents.length, 2);
  } finally {
    server.store.close();
  }
});

test('V3-109 unit: staffing planner emits readable specialist handles and bounded expansion', () => {
  const plan = buildStaffingPlan({
    objective: 'use agent teams for infra kubernetes terraform migration rollout across clusters',
    task_size: 'high',
    max_threads: 12,
    estimated_parallel_tasks: 10
  });

  assert.equal(plan.domain, 'infra');
  assert.equal(plan.hard_cap, 6);
  assert.equal(plan.recommended_threads <= 6, true);
  assert.equal(plan.planned_roles.length, plan.recommended_threads);
  assert.equal(plan.specialists.length, plan.recommended_threads);
  assert.equal(plan.dynamic_expansion.bounded_max, 6);

  for (let index = 0; index < plan.specialists.length; index += 1) {
    const specialist = plan.specialists[index];
    assert.match(specialist.specialist_handle, /^@[a-z0-9-]+-[a-z0-9-]+$/);
    assert.equal(specialist.specialist_domain, plan.domain);
    assert.match(specialist.spawn_reason, /template/);
    assert.equal(specialist.priority, index + 1);
  }

  const preferred = buildStaffingPlan({
    objective: 'infra rollout',
    task_size: 'medium',
    max_threads: 6,
    preferred_threads: 3
  });

  assert.equal(preferred.recommended_threads, 3);
  assert.deepEqual(preferred.planned_roles, ['implementer', 'tester', 'reviewer']);
  assert.deepEqual(
    preferred.specialists.map((specialist) => specialist.specialist_handle),
    ['@infra-dev', '@infra-qa', '@infra-review']
  );
});
