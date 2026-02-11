import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-007-int.sqlite';
const logPath = '.tmp/v3-007-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-007 integration: idempotency is scoped by route so direct and broadcast can reuse keys safely', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-007 route scoped idempotency',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);

  const direct = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'direct payload',
    artifact_refs: [],
    idempotency_key: 'shared-route-key'
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.inserted, true);

  const broadcast = server.callTool('team_broadcast', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    summary: 'broadcast payload',
    artifact_refs: [],
    idempotency_key: 'shared-route-key'
  });
  assert.equal(broadcast.ok, true);
  assert.equal(broadcast.inserted, true);
  assert.notEqual(String(broadcast.message.message_id), String(direct.message.message_id));

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: String(worker.agent.agent_id),
    limit: 10,
    ack: false
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 2);

  server.store.close();
});

test('V3-007 integration: orphan recovery retries stale inbox once then dead-letters at max attempts', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerRecoveryTools(server);

  server.policyEngine.cache.set('v3-007-recovery', {
    profile: 'v3-007-recovery',
    limits: {
      default_max_threads: 4,
      hard_max_threads: 6
    },
    recovery: {
      agent_stale_ms: 300000,
      in_flight_timeout_ms: 1,
      max_attempts: 2,
      base_backoff_ms: 1,
      max_backoff_ms: 1
    }
  });

  const started = server.callTool('team_start', {
    objective: 'v3-007 recovery path',
    profile: 'v3-007-recovery',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);

  const sent = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'recover me',
    artifact_refs: [],
    idempotency_key: 'recover-key'
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.inserted, true);

  const firstPull = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: String(worker.agent.agent_id),
    ack: false,
    limit: 10
  });
  assert.equal(firstPull.ok, true);
  assert.equal(firstPull.messages.length, 1);
  assert.equal(firstPull.acked, 0);

  const waitStaleA = Date.now() + 5;
  while (Date.now() < waitStaleA) {
    // wait to exceed in-flight timeout
  }

  const recoverRetry = server.callTool('team_orphan_recover', {
    team_id: teamId,
    now_iso: new Date().toISOString(),
    agent_stale_ms: 300000
  });
  assert.equal(recoverRetry.ok, true);
  assert.equal(recoverRetry.recovered_inbox, 1);
  assert.equal(recoverRetry.inbox_scheduled_retry, 1);
  assert.equal(recoverRetry.inbox_dead_lettered, 0);
  assert.equal(recoverRetry.inbox_retry_inbox_ids.length, 1);
  assert.equal(recoverRetry.inbox_dead_letter_inbox_ids.length, 0);

  const waitRetryReady = Date.now() + 5;
  while (Date.now() < waitRetryReady) {
    // wait for retry backoff
  }

  const secondPull = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: String(worker.agent.agent_id),
    ack: false,
    limit: 10
  });
  assert.equal(secondPull.ok, true);
  assert.equal(secondPull.messages.length, 1);
  assert.equal(secondPull.messages[0].message_id, String(sent.message.message_id));

  const waitStaleB = Date.now() + 5;
  while (Date.now() < waitStaleB) {
    // wait to exceed in-flight timeout again
  }

  const recoverDeadLetter = server.callTool('team_orphan_recover', {
    team_id: teamId,
    now_iso: new Date().toISOString(),
    agent_stale_ms: 300000
  });
  assert.equal(recoverDeadLetter.ok, true);
  assert.equal(recoverDeadLetter.recovered_inbox, 1);
  assert.equal(recoverDeadLetter.inbox_scheduled_retry, 0);
  assert.equal(recoverDeadLetter.inbox_dead_lettered, 1);
  assert.equal(recoverDeadLetter.inbox_dead_letter_inbox_ids.length, 1);

  const finalPull = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: String(worker.agent.agent_id),
    ack: false,
    limit: 10
  });
  assert.equal(finalPull.ok, true);
  assert.equal(finalPull.messages.length, 0);

  server.store.close();
});
