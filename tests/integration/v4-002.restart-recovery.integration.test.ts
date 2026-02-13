import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v4-002-worker-session-int.sqlite';
const logPath = '.tmp/v4-002-worker-session-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-002 integration: restart recovers persisted worker sessions for send/pull workflow', () => {
  cleanup();

  const counters = {
    spawn: 0,
    send: 0,
    poll: 0,
    collect: 0
  };

  const provider: WorkerProvider = {
    name: 'v4-002-integration-provider',
    spawn: (input) => {
      counters.spawn += 1;
      return {
        worker_id: `worker_${input.agent_id}`,
        status: 'spawned'
      };
    },
    sendInstruction: () => {
      counters.send += 1;
      return {
        accepted: true,
        instruction_id: 'instruction_restart',
        status: 'queued'
      };
    },
    poll: (input) => {
      counters.poll += 1;
      return {
        worker_id: input.worker_id,
        status: 'running',
        events: [{ type: 'stdout', text: 'resumed' }]
      };
    },
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => {
      counters.collect += 1;
      return {
        worker_id: input.worker_id,
        artifacts: [{ artifact_id: 'artifact_restart', version: 1 }]
      };
    }
  };

  const adapter = new WorkerAdapter(provider);

  const bootServer = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  bootServer.start();
  registerTeamLifecycleTools(bootServer);
  registerAgentLifecycleTools(bootServer);

  const started = bootServer.callTool('team_start', {
    objective: 'restart integration test'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const sender = bootServer.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const receiver = bootServer.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(sender.ok, true);
  assert.equal(receiver.ok, true);

  const persistedBefore = bootServer.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(persistedBefore.length, 2);

  bootServer.store.close();

  const resumedServer = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  resumedServer.start();
  registerTeamLifecycleTools(resumedServer);
  registerAgentLifecycleTools(resumedServer);

  const resumedSessions = resumedServer.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(resumedSessions.length, 2);

  const send = resumedServer.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'resume after restart',
    artifact_refs: [],
    idempotency_key: 'v4-002-restart-1'
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);
  assert.equal(send.worker_delivery.status, 'queued');

  const pull = resumedServer.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(pull.ok, true);
  assert.equal(pull.worker_adapter_active, true);
  assert.equal(pull.worker_poll.status, 'running');

  assert.equal(counters.spawn, 2);
  assert.equal(counters.send, 1);
  assert.equal(counters.poll, 1);
  assert.equal(counters.collect, 1);

  const persistedAfter = resumedServer.store.getWorkerRuntimeSession(receiver.agent.agent_id as string);
  assert.notEqual(persistedAfter, null);
  assert.equal(persistedAfter?.lifecycle_state, 'active');

  resumedServer.store.close();
});

test('V4-002 integration: managed runtime headless recovers from stale worker IDs after restart', () => {
  cleanup();

  const bootServer = createServer({
    dbPath,
    logPath,
    managedRuntime: {
      enabled: true,
      provider: 'codex',
      transportMode: 'headless'
    }
  });
  bootServer.start();
  registerTeamLifecycleTools(bootServer);
  registerAgentLifecycleTools(bootServer);

  const started = bootServer.callTool('team_start', {
    objective: 'restart stale worker id recovery'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const sender = bootServer.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const receiver = bootServer.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(sender.ok, true);
  assert.equal(receiver.ok, true);

  const persistedBefore = bootServer.store.getWorkerRuntimeSession(receiver.agent.agent_id as string);
  assert.notEqual(persistedBefore, null);
  const workerBefore = String(persistedBefore?.worker_id ?? '');
  assert.equal(workerBefore.length > 0, true);

  bootServer.store.close();

  const resumedServer = createServer({
    dbPath,
    logPath,
    managedRuntime: {
      enabled: true,
      provider: 'codex',
      transportMode: 'headless'
    }
  });
  resumedServer.start();
  registerTeamLifecycleTools(resumedServer);
  registerAgentLifecycleTools(resumedServer);

  const send = resumedServer.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'resume with stale worker id recovery',
    artifact_refs: [],
    idempotency_key: 'v4-002-managed-runtime-restart'
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);
  assert.equal(send.worker_delivery.status, 'queued');

  const pull = resumedServer.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(pull.ok, true);
  assert.equal(pull.worker_adapter_active, true);
  assert.equal(pull.worker_poll.status, 'running');

  const persistedAfter = resumedServer.store.getWorkerRuntimeSession(receiver.agent.agent_id as string);
  assert.notEqual(persistedAfter, null);
  assert.notEqual(persistedAfter?.worker_id, workerBefore);
  assert.equal(persistedAfter?.lifecycle_state, 'active');

  resumedServer.store.close();
});
