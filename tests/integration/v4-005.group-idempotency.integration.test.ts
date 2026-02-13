import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-005-group-idempotency-int.sqlite';
const logPath = '.tmp/v4-005-group-idempotency-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-005 integration: group-scoped idempotency allows same key across different recipient sets without route collisions', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });

  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'group idempotency integration',
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

    const senderId = String(lead.agent.agent_id);
    const reviewerId = String(reviewer.agent.agent_id);
    const testerId = String(tester.agent.agent_id);
    const implementerId = String(implementer.agent.agent_id);
    const createdAt = new Date().toISOString();

    const groupAB = server.store.appendMessage({
      message_id: 'msg_v4_005_group_ab',
      team_id: teamId,
      from_agent_id: senderId,
      to_agent_id: null,
      delivery_mode: 'group',
      idempotency_key: 'shared-key',
      payload: { summary: 'group-ab', artifact_refs: [] },
      created_at: createdAt,
      recipient_agent_ids: [reviewerId, testerId]
    });
    assert.equal(groupAB.inserted, true);

    const groupAC = server.store.appendMessage({
      message_id: 'msg_v4_005_group_ac',
      team_id: teamId,
      from_agent_id: senderId,
      to_agent_id: null,
      delivery_mode: 'group',
      idempotency_key: 'shared-key',
      payload: { summary: 'group-ac', artifact_refs: [] },
      created_at: createdAt,
      recipient_agent_ids: [reviewerId, implementerId]
    });
    assert.equal(groupAC.inserted, true);
    assert.notEqual(groupAB.message.message_id, groupAC.message.message_id);

    const groupABDuplicate = server.store.appendMessage({
      message_id: 'msg_v4_005_group_ab_dup',
      team_id: teamId,
      from_agent_id: senderId,
      to_agent_id: null,
      delivery_mode: 'group',
      idempotency_key: 'shared-key',
      payload: { summary: 'group-ab-dup', artifact_refs: [] },
      created_at: createdAt,
      recipient_agent_ids: [testerId, reviewerId]
    });
    assert.equal(groupABDuplicate.inserted, false);
    assert.equal(groupABDuplicate.message.message_id, groupAB.message.message_id);

    const direct = server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: senderId,
      to_agent_id: implementerId,
      summary: 'direct-msg',
      artifact_refs: [],
      idempotency_key: 'shared-key'
    });
    assert.equal(direct.ok, true);
    assert.equal(direct.inserted, true);

    const broadcast = server.callTool('team_broadcast', {
      team_id: teamId,
      from_agent_id: senderId,
      summary: 'broadcast-msg',
      artifact_refs: [],
      idempotency_key: 'shared-key'
    });
    assert.equal(broadcast.ok, true);
    assert.equal(broadcast.inserted, true);

    const reviewerInbox = server.callTool('team_pull_inbox', {
      team_id: teamId,
      agent_id: reviewerId,
      ack: false,
      limit: 20
    });
    const testerInbox = server.callTool('team_pull_inbox', {
      team_id: teamId,
      agent_id: testerId,
      ack: false,
      limit: 20
    });
    const implementerInbox = server.callTool('team_pull_inbox', {
      team_id: teamId,
      agent_id: implementerId,
      ack: false,
      limit: 20
    });

    assert.equal(reviewerInbox.ok, true);
    assert.equal(testerInbox.ok, true);
    assert.equal(implementerInbox.ok, true);
    assert.equal(reviewerInbox.messages.length, 3);
    assert.equal(testerInbox.messages.length, 2);
    assert.equal(implementerInbox.messages.length, 3);
  } finally {
    server.store.close();
  }
});
