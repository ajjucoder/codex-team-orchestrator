import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

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
