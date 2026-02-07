import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/at006-unit.sqlite';
const logPath = '.tmp/at006-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-006 spawn respects max_threads and model inheritance', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'spawn agents',
    max_threads: 2,
    profile: 'default'
  }, {
    active_session_model: 'gpt-5-codex'
  });

  const teamId = started.team.team_id;
  const a1 = server.callTool('team_spawn', { team_id: teamId, role: 'planner' });
  const a2 = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const a3 = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });

  assert.equal(a1.ok, true);
  assert.equal(a1.agent.model, 'gpt-5-codex');
  assert.equal(a2.ok, true);
  assert.equal(a3.ok, false);
  assert.match(a3.error, /max_threads exceeded/);

  server.store.close();
});

test('AT-006 team_send idempotency returns existing message', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', { objective: 'send test' });
  const teamId = team.team.team_id;
  const sender = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const receiver = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const first = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'compact ref only',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }],
    idempotency_key: 'dup-key-1'
  });

  const second = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'duplicate',
    artifact_refs: [],
    idempotency_key: 'dup-key-1'
  });

  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  assert.equal(second.ok, true);
  assert.equal(second.inserted, false);
  assert.equal(second.message.message_id, first.message.message_id);

  server.store.close();
});

test('AT-006 team_send suppresses duplicate payloads even with different idempotency keys', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', { objective: 'dedup test' });
  const teamId = team.team.team_id;
  const sender = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const receiver = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const first = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'same summary',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }],
    idempotency_key: 'dedup-a'
  });
  const second = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'same summary',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }],
    idempotency_key: 'dedup-b'
  });

  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  assert.equal(second.ok, true);
  assert.equal(second.inserted, false);
  assert.equal(second.duplicate_suppressed, true);
  assert.equal(second.message.message_id, first.message.message_id);

  server.store.close();
});

test('AT-006 team_send sends artifact delta for same summary', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', { objective: 'delta test' });
  const teamId = team.team.team_id;
  const sender = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const receiver = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const first = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'artifacts updated',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }],
    idempotency_key: 'delta-a'
  });
  const second = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'artifacts updated',
    artifact_refs: [
      { artifact_id: 'artifact_a', version: 1 },
      { artifact_id: 'artifact_b', version: 1 }
    ],
    idempotency_key: 'delta-b'
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.inserted, true);
  assert.equal(second.delta_applied, true);
  assert.equal(second.message.payload.artifact_refs.length, 1);
  assert.equal(second.message.payload.artifact_refs[0].artifact_id, 'artifact_b');

  server.store.close();
});
