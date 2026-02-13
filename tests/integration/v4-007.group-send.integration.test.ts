import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v4-007-group-send-int.sqlite';
const logPath = '.tmp/v4-007-group-send-int.log';

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
    name: 'mock-v4-007',
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

test('V4-007 integration: team_group_send handles @all routing, active dispatch, and duplicate suppression', () => {
  cleanup();
  const { adapter, sendCalls } = makeAdapter();
  const server = createServer({ dbPath, logPath });

  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerAgentLifecycleTools(server, { workerAdapter: adapter });

    const started = server.callTool('team_start', {
      objective: 'group send integration',
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

    server.store.updateWorkerRuntimeSessionState({
      agent_id: testerId,
      lifecycle_state: 'offline',
      touch_seen: true,
      team_id: teamId
    });

    const first = server.callTool('team_group_send', {
      team_id: teamId,
      from_agent_id: leadId,
      summary: 'group rollout update',
      mentions: ['@all'],
      idempotency_key: 'v4-007-group-send-1'
    });
    assert.equal(first.ok, true);
    assert.equal(first.inserted, true);
    assert.equal(first.recipient_count, 2);
    assert.deepEqual(first.recipient_agent_ids, [reviewerId, testerId]);
    assert.deepEqual(sendCalls, [`worker_${reviewerId}`]);

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
    assert.equal(reviewerInbox.ok, true);
    assert.equal(testerInbox.ok, true);
    assert.equal(reviewerInbox.messages.length, 1);
    assert.equal(testerInbox.messages.length, 1);

    const duplicate = server.callTool('team_group_send', {
      team_id: teamId,
      from_agent_id: leadId,
      summary: 'group rollout update',
      mentions: [`@agent:${testerId}`, `@agent:${reviewerId}`],
      idempotency_key: 'v4-007-group-send-2'
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.duplicate_suppressed, true);
    assert.equal(duplicate.message.message_id, first.message.message_id);
  } finally {
    server.store.close();
  }
});
