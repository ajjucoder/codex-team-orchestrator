import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v4-008-team-group-send-unit.sqlite';
const logPath = '.tmp/v4-008-team-group-send-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

function makeAdapter(): { adapter: WorkerAdapter; sendCalls: string[] } {
  const sendCalls: string[] = [];
  const provider: WorkerProvider = {
    name: 'mock-v4-008',
    spawn: (input) => ({
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned'
    }),
    sendInstruction: (input) => {
      sendCalls.push(input.worker_id);
      return {
        accepted: true,
        instruction_id: `instruction_${input.worker_id}`,
        status: 'queued'
      };
    },
    poll: (input) => ({
      worker_id: input.worker_id,
      status: 'running',
      events: []
    }),
    interrupt: () => ({
      interrupted: true,
      status: 'interrupted'
    }),
    collectArtifacts: (input) => ({
      worker_id: input.worker_id,
      artifacts: []
    })
  };
  return {
    adapter: new WorkerAdapter(provider),
    sendCalls
  };
}

test('V4-008 unit: team_group_send resolves mentions, persists inbox entries, and dispatches active recipients', () => {
  cleanup();
  const { adapter, sendCalls } = makeAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: adapter });

  const started = server.callTool('team_start', {
    objective: 'group send unit',
    max_threads: 5
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(reviewer.ok, true);
  assert.equal(tester.ok, true);
  assert.equal(implementer.ok, true);

  const leadId = String(lead.agent.agent_id);
  const reviewerId = String(reviewer.agent.agent_id);
  const testerId = String(tester.agent.agent_id);
  const implementerId = String(implementer.agent.agent_id);

  server.store.updateWorkerRuntimeSessionState({
    agent_id: implementerId,
    lifecycle_state: 'offline',
    touch_seen: true,
    team_id: teamId
  });

  const sent = server.callTool('team_group_send', {
    team_id: teamId,
    from_agent_id: leadId,
    summary: `fanout @role:reviewer @agent:${testerId}`,
    mentions: [`@agent:${implementerId}`],
    idempotency_key: 'v4-008-group-send-1'
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.inserted, true);
  assert.equal(sent.recipient_count, 3);
  assert.deepEqual(sent.recipient_agent_ids, [reviewerId, testerId, implementerId]);
  assert.equal(sent.worker_deliveries.length, 2);
  assert.deepEqual(sendCalls.sort(), [`worker_${reviewerId}`, `worker_${testerId}`].sort());

  const reviewerInbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: reviewerId,
    ack: false
  });
  const testerInbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: testerId,
    ack: false
  });
  const implementerInbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: implementerId,
    ack: false
  });
  const leadInbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: leadId,
    ack: false
  });

  assert.equal(reviewerInbox.ok, true);
  assert.equal(testerInbox.ok, true);
  assert.equal(implementerInbox.ok, true);
  assert.equal(leadInbox.ok, true);
  assert.equal(reviewerInbox.messages.length, 1);
  assert.equal(testerInbox.messages.length, 1);
  assert.equal(implementerInbox.messages.length, 1);
  assert.equal(leadInbox.messages.length, 0);

  server.store.close();
});

test('V4-008 unit: team_group_send duplicate suppression is recipient-set scoped and order-insensitive', () => {
  cleanup();
  const { adapter } = makeAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: adapter });

  const started = server.callTool('team_start', {
    objective: 'group send dedupe unit',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
  assert.equal(lead.ok, true);
  assert.equal(reviewer.ok, true);
  assert.equal(tester.ok, true);

  const leadId = String(lead.agent.agent_id);
  const reviewerId = String(reviewer.agent.agent_id);
  const testerId = String(tester.agent.agent_id);

  const first = server.callTool('team_group_send', {
    team_id: teamId,
    from_agent_id: leadId,
    summary: 'fanout plan',
    mentions: [`@agent:${reviewerId}`, `@agent:${testerId}`],
    idempotency_key: 'v4-008-group-send-2a'
  });
  const duplicate = server.callTool('team_group_send', {
    team_id: teamId,
    from_agent_id: leadId,
    summary: 'fanout plan',
    mentions: [`@agent:${testerId}`, `@agent:${reviewerId}`],
    idempotency_key: 'v4-008-group-send-2b'
  });

  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.duplicate_suppressed, true);
  assert.equal(duplicate.message.message_id, first.message.message_id);

  server.store.close();
});

test('V4-008 unit: team_group_send fails closed when mentions are unresolved', () => {
  cleanup();
  const { adapter } = makeAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: adapter });

  const started = server.callTool('team_start', {
    objective: 'group send unresolved unit',
    max_threads: 2
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  assert.equal(lead.ok, true);

  const failed = server.callTool('team_group_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    summary: '@role:does-not-exist',
    idempotency_key: 'v4-008-group-send-3'
  });
  assert.equal(failed.ok, false);
  assert.match(String(failed.error ?? ''), /unresolved mentions/);
  assert.equal(Array.isArray(failed.unresolved_mentions), true);
  assert.equal(failed.unresolved_mentions.length, 1);

  server.store.close();
});
