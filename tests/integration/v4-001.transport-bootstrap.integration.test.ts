import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import type { CodexTransport } from '../../mcp/runtime/providers/codex.js';

const dbPath = '.tmp/v4-001-transport-bootstrap-int.sqlite';
const logPath = '.tmp/v4-001-transport-bootstrap-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-001 integration: managed runtime transport wiring dispatches through team_send/team_pull_inbox path', () => {
  cleanup();

  const calls = {
    spawn: 0,
    send: 0,
    poll: 0,
    collectArtifacts: 0,
    interrupt: 0
  };

  const transport: CodexTransport = {
    spawn: (input) => {
      calls.spawn += 1;
      return {
        worker_id: `worker_${input.agent_id}`,
        status: 'spawned'
      };
    },
    sendInstruction: () => {
      calls.send += 1;
      return {
        accepted: true,
        instruction_id: 'instruction_001',
        status: 'queued'
      };
    },
    poll: (input) => {
      calls.poll += 1;
      return {
        worker_id: input.worker_id,
        status: 'running',
        events: [{ type: 'stdout', text: 'ok' }]
      };
    },
    interrupt: () => {
      calls.interrupt += 1;
      return {
        interrupted: true,
        status: 'interrupted'
      };
    },
    collectArtifacts: (input) => {
      calls.collectArtifacts += 1;
      return {
        worker_id: input.worker_id,
        artifacts: [{ artifact_id: 'artifact_bootstrap', version: 1 }]
      };
    }
  };

  const server = createServer({
    dbPath,
    logPath,
    managedRuntime: {
      enabled: true,
      provider: 'codex',
      transport
    }
  });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'managed runtime bootstrap integration'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const sender = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const receiver = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(sender.ok, true);
  assert.equal(receiver.ok, true);

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'bootstrap transport dispatch',
    idempotency_key: 'v4-001-send-a',
    artifact_refs: []
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);
  assert.equal(send.worker_delivery.status, 'queued');

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.worker_adapter_active, true);
  assert.equal(inbox.worker_poll.status, 'running');
  assert.equal(Array.isArray(inbox.worker_artifacts), true);

  assert.equal(calls.spawn, 2);
  assert.equal(calls.send, 1);
  assert.equal(calls.poll, 1);
  assert.equal(calls.collectArtifacts, 1);

  server.store.close();
});

test('V4-001 integration: default server bootstrap remains compatible when no transport is configured', () => {
  cleanup();

  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'default bootstrap compatibility'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const sender = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const receiver = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(sender.ok, true);
  assert.equal(receiver.ok, true);
  assert.equal(sender.worker_session ?? null, null);
  assert.equal(receiver.worker_session ?? null, null);

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'default send path',
    idempotency_key: 'v4-001-send-b',
    artifact_refs: []
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);
  assert.equal(send.worker_delivery ?? null, null);

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.worker_adapter_active, false);

  server.store.close();
});
