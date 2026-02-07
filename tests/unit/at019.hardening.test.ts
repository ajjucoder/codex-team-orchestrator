import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { StructuredLogger } from '../../mcp/server/tracing.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';

const dbPath = '.tmp/at019-unit.sqlite';
const logPath = '.tmp/at019-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-019 logger redacts secret fields', () => {
  const logger = new StructuredLogger(logPath);
  logger.log({
    event_type: 'secret_test',
    payload: {
      api_key: 'abc123',
      nested: { token: 'secret-token' },
      normal: 'visible'
    }
  });

  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /visible/);
  assert.doesNotMatch(text, /abc123/);
});

test('AT-019 server enforces team-scoped access by auth context', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const teamA = server.callTool('team_start', { objective: 'a' });
  const forbidden = server.callTool('team_status', { team_id: teamA.team.team_id }, { auth_team_id: 'team_other' });

  assert.equal(forbidden.ok, false);
  assert.match(forbidden.errors.join(' '), /forbidden team scope/);

  server.store.close();
});

test('AT-019 message tools reject cross-team agent usage', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const teamA = server.callTool('team_start', { objective: 'team-a', max_threads: 3 });
  const teamB = server.callTool('team_start', { objective: 'team-b', max_threads: 3 });

  const agentA1 = server.callTool('team_spawn', { team_id: teamA.team.team_id, role: 'lead' });
  const agentA2 = server.callTool('team_spawn', { team_id: teamA.team.team_id, role: 'reviewer' });
  const agentB1 = server.callTool('team_spawn', { team_id: teamB.team.team_id, role: 'implementer' });

  const direct = server.callTool('team_send', {
    team_id: teamA.team.team_id,
    from_agent_id: agentB1.agent.agent_id,
    to_agent_id: agentA2.agent.agent_id,
    summary: 'cross-team direct',
    artifact_refs: [],
    idempotency_key: 'cross-team-direct'
  });
  assert.equal(direct.ok, false);
  assert.match(direct.error, /from_agent not in team/);

  const broadcast = server.callTool('team_broadcast', {
    team_id: teamA.team.team_id,
    from_agent_id: agentB1.agent.agent_id,
    summary: 'cross-team broadcast',
    artifact_refs: [],
    idempotency_key: 'cross-team-broadcast'
  });
  assert.equal(broadcast.ok, false);
  assert.match(broadcast.error, /from_agent not in team/);

  const pull = server.callTool('team_pull_inbox', {
    team_id: teamA.team.team_id,
    agent_id: agentB1.agent.agent_id
  });
  assert.equal(pull.ok, false);
  assert.match(pull.error, /agent not in team/);

  const valid = server.callTool('team_send', {
    team_id: teamA.team.team_id,
    from_agent_id: agentA1.agent.agent_id,
    to_agent_id: agentA2.agent.agent_id,
    summary: 'valid in-team message',
    artifact_refs: [],
    idempotency_key: 'same-team-direct'
  });
  assert.equal(valid.ok, true);

  server.store.close();
});

test('AT-019 payload limits reject oversized artifacts and messages', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);

  const team = server.callTool('team_start', { objective: 'payload limit', max_threads: 2 });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const tooLongSummary = 'x'.repeat(5001);
  const msg = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    to_agent_id: worker.agent.agent_id,
    summary: tooLongSummary,
    artifact_refs: [],
    idempotency_key: 'limit-msg-1'
  });
  assert.equal(msg.ok, false);

  const artifact = server.callTool('team_artifact_publish', {
    team_id: teamId,
    name: 'big',
    content: 'x'.repeat(200001),
    published_by: lead.agent.agent_id
  });
  assert.equal(artifact.ok, false);

  server.store.close();
});

test('AT-019 team_resume restores active state with recovery snapshot', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const started = server.callTool('team_start', { objective: 'resume flow' });
  const teamId = started.team.team_id;
  server.callTool('team_finalize', { team_id: teamId, reason: 'simulate_crash' });

  const resumed = server.callTool('team_resume', { team_id: teamId }, { agent_id: 'agent_lead' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.team.status, 'active');
  assert.equal(typeof resumed.recovery_snapshot.open_tasks, 'number');
  assert.equal(typeof resumed.recovery_snapshot.pending_inbox, 'number');

  server.store.close();
});
