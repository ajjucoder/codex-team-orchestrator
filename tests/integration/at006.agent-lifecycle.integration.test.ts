import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';

const dbPath = '.tmp/at006-int.sqlite';
const logPath = '.tmp/at006-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-006 integration: broadcast + inbox pull/ack works through message bus', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', {
    objective: 'broadcast work',
    profile: 'default',
    max_threads: 4
  });
  const teamId = team.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const workerA = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const workerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const broadcast = server.callTool('team_broadcast', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    summary: 'artifact updates published',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 2 }],
    idempotency_key: 'broadcast-1'
  });
  assert.equal(broadcast.ok, true);
  assert.equal(broadcast.recipient_count, 2);

  const inboxA = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: workerA.agent.agent_id,
    limit: 10,
    ack: true
  });
  assert.equal(inboxA.ok, true);
  assert.equal(inboxA.messages.length, 1);
  assert.equal(inboxA.acked, 1);
  assert.equal(inboxA.messages[0].payload.artifact_refs.length, 1);

  const inboxB = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: workerB.agent.agent_id,
    ack: false
  });
  assert.equal(inboxB.ok, true);
  assert.equal(inboxB.messages.length, 1);
  assert.equal(inboxB.acked, 0);

  const inboxBAck = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: workerB.agent.agent_id,
    ack: true
  });
  assert.equal(inboxBAck.messages.length, 1);
  assert.equal(inboxBAck.acked, 1);

  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /tool_call:team_broadcast/);
  assert.match(logText, /tool_call:team_pull_inbox/);

  server.store.close();
});

test('AT-006 integration: broadcast duplicate suppression and delta refs reduce bus traffic', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', {
    objective: 'broadcast dedup',
    profile: 'default',
    max_threads: 4
  });
  const teamId = team.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const first = server.callTool('team_broadcast', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    summary: 'release artifacts',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 1 }],
    idempotency_key: 'broadcast-dedup-1'
  });
  const duplicate = server.callTool('team_broadcast', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    summary: 'release artifacts',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 1 }],
    idempotency_key: 'broadcast-dedup-2'
  });
  const delta = server.callTool('team_broadcast', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    summary: 'release artifacts',
    artifact_refs: [
      { artifact_id: 'artifact_patch', version: 1 },
      { artifact_id: 'artifact_tests', version: 1 }
    ],
    idempotency_key: 'broadcast-dedup-3'
  });

  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.duplicate_suppressed, true);
  assert.equal(delta.ok, true);
  assert.equal(delta.inserted, true);
  assert.equal(delta.delta_applied, true);
  assert.equal(delta.message.payload.artifact_refs.length, 1);
  assert.equal(delta.message.payload.artifact_refs[0].artifact_id, 'artifact_tests');

  server.store.close();
});

test('AT-006 integration: optional policy model routing applies per role while preserving defaults', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('routing-int', {
    profile: 'routing-int',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    model_routing: {
      enabled: true,
      mode: 'role_map',
      default_model: 'gpt-4o-mini',
      role_models: {
        reviewer: 'gpt-4o'
      }
    },
    permissions: {
      default: 'safe-read',
      reviewer: 'review-only'
    }
  });

  const routedTeam = server.callTool('team_start', {
    objective: 'integration routing team',
    profile: 'routing-int',
    max_threads: 4
  }, {
    active_session_model: 'gpt-5-codex'
  });
  const routedTeamId = routedTeam.team.team_id;

  const reviewer = server.callTool('team_spawn', { team_id: routedTeamId, role: 'reviewer' });
  const planner = server.callTool('team_spawn', { team_id: routedTeamId, role: 'planner' });
  const explicit = server.callTool('team_spawn', {
    team_id: routedTeamId,
    role: 'implementer',
    model: 'gpt-5'
  });

  assert.equal(reviewer.ok, true);
  assert.equal(reviewer.agent.model, 'gpt-4o');
  assert.equal(reviewer.agent.metadata.model_source, 'policy_role_route');
  assert.equal(reviewer.agent.metadata.permission_profile, 'review-only');

  assert.equal(planner.ok, true);
  assert.equal(planner.agent.model, 'gpt-4o-mini');
  assert.equal(planner.agent.metadata.model_source, 'policy_default_route');
  assert.equal(planner.agent.metadata.permission_profile, 'safe-read');

  assert.equal(explicit.ok, true);
  assert.equal(explicit.agent.model, 'gpt-5');
  assert.equal(explicit.agent.metadata.model_source, 'explicit_input');

  const defaultTeam = server.callTool('team_start', {
    objective: 'integration default team',
    profile: 'default',
    max_threads: 2
  }, {
    active_session_model: 'gpt-5-codex'
  });
  const inherited = server.callTool('team_spawn', {
    team_id: defaultTeam.team.team_id,
    role: 'tester'
  });
  assert.equal(inherited.ok, true);
  assert.equal(inherited.agent.model, 'gpt-5-codex');
  assert.equal(inherited.agent.metadata.model_source, 'session_inherited');
  assert.equal(inherited.agent.metadata.model_routing_applied, false);

  server.store.close();
});

test('AT-006 integration: spawn-ready-roles uses DAG-ready required_role hints only', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', {
    objective: 'dag shaped spawn',
    profile: 'default',
    max_threads: 4
  });
  const teamId = team.team.team_id;

  const foundation = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'foundation',
    priority: 1
  }).task;
  server.callTool('team_task_create', {
    team_id: teamId,
    title: 'blocked reviewer',
    priority: 2,
    required_role: 'reviewer',
    depends_on_task_ids: [foundation.task_id]
  });
  server.callTool('team_task_create', {
    team_id: teamId,
    title: 'ready implementer',
    priority: 3,
    required_role: 'implementer'
  });

  const spawn1 = server.callTool('team_spawn_ready_roles', {
    team_id: teamId,
    max_new_agents: 4
  });
  assert.equal(spawn1.ok, true);
  assert.deepEqual(spawn1.role_candidates, ['implementer']);
  assert.equal(spawn1.spawned_count, 1);

  const done = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: foundation.task_id,
    status: 'done',
    expected_lock_version: foundation.lock_version
  });
  assert.equal(done.ok, true);

  const spawn2 = server.callTool('team_spawn_ready_roles', {
    team_id: teamId,
    max_new_agents: 4
  });
  assert.equal(spawn2.ok, true);
  assert.deepEqual(spawn2.role_candidates, ['reviewer']);
  assert.equal(spawn2.spawned_count, 1);

  const status = server.callTool('team_status', { team_id: teamId });
  assert.equal(status.ok, true);
  assert.equal(status.metrics.agents, 2);

  server.store.close();
});
