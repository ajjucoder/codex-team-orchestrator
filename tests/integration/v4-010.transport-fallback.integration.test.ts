import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/v4-010-transport-fallback-int.sqlite';
const logPath = '.tmp/v4-010-transport-fallback-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

function buildManagedRuntimeServer(config: {
  transportMode?: 'auto' | 'tmux' | 'headless';
  transportFactory?: {
    ci?: boolean;
    stdoutIsTTY?: boolean;
    hasTmuxBinary?: boolean;
  };
}) {
  const server = createServer({
    dbPath,
    logPath,
    managedRuntime: {
      enabled: true,
      provider: 'codex',
      transportMode: config.transportMode,
      transportFactory: config.transportFactory
    }
  });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  return server;
}

test('V4-010 integration: managed runtime auto mode deterministically falls back to headless in CI', () => {
  cleanup();

  const server = buildManagedRuntimeServer({
    transportFactory: {
      ci: true,
      stdoutIsTTY: true,
      hasTmuxBinary: true
    }
  });

  const started = server.callTool('team_start', {
    objective: 'transport fallback ci'
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
  assert.match(String(receiver.worker_session.worker_id), /^headless_/);

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'fallback headless dispatch',
    idempotency_key: 'v4-010-send-ci',
    artifact_refs: []
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.worker_adapter_active, true);
  const firstEvent = (inbox.worker_poll.events?.[0] ?? {}) as Record<string, unknown>;
  assert.equal(firstEvent.type, 'instruction_received');

  server.store.close();
});

test('V4-010 integration: explicit tmux mode fails over to headless when tmux is unavailable', () => {
  cleanup();

  const server = buildManagedRuntimeServer({
    transportMode: 'tmux',
    transportFactory: {
      ci: false,
      stdoutIsTTY: true,
      hasTmuxBinary: false
    }
  });

  const started = server.callTool('team_start', {
    objective: 'transport fallback tmux-unavailable'
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
  assert.match(String(sender.worker_session.worker_id), /^headless_/);
  assert.match(String(receiver.worker_session.worker_id), /^headless_/);

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'tmux fallback dispatch',
    idempotency_key: 'v4-010-send-tmux',
    artifact_refs: []
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(inbox.ok, true);
  const firstEvent = (inbox.worker_poll.events?.[0] ?? {}) as Record<string, unknown>;
  assert.equal(firstEvent.type, 'instruction_received');

  server.store.close();
});
