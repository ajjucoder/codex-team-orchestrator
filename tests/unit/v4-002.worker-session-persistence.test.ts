import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v4-002-worker-session-unit.sqlite';
const logPath = '.tmp/v4-002-worker-session-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-002 unit: migration and store methods persist worker runtime sessions', () => {
  cleanup();

  const store = new SqliteStore(dbPath);
  store.migrate();

  const migration = store.db
    .prepare("SELECT version FROM schema_migrations WHERE version = '009_worker_runtime_sessions'")
    .get() as Record<string, unknown> | undefined;
  assert.notEqual(migration, undefined);

  const table = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_runtime_sessions'")
    .get() as Record<string, unknown> | undefined;
  assert.equal(String(table?.name ?? ''), 'worker_runtime_sessions');

  const now = new Date().toISOString();
  const team = store.createTeam({
    team_id: 'team_v4_002',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now,
    metadata: {}
  });
  assert.notEqual(team, null);

  const agent = store.createAgent({
    agent_id: 'agent_v4_002',
    team_id: 'team_v4_002',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now,
    metadata: {}
  });
  assert.notEqual(agent, null);

  const inserted = store.upsertWorkerRuntimeSession({
    team_id: 'team_v4_002',
    agent_id: 'agent_v4_002',
    worker_id: 'worker_v4_002',
    provider: 'mock-provider',
    transport_backend: 'headless',
    session_ref: 'session_ref_1',
    pane_ref: 'pane_ref_1',
    lifecycle_state: 'active',
    metadata: { source: 'unit-test' },
    created_at: now,
    updated_at: now,
    last_seen_at: now
  });
  assert.notEqual(inserted, null);
  assert.equal(inserted?.worker_id, 'worker_v4_002');

  const updated = store.updateWorkerRuntimeSessionState({
    agent_id: 'agent_v4_002',
    lifecycle_state: 'interrupted',
    metadata_patch: { reason: 'manual_interrupt' },
    touch_seen: true,
    team_id: 'team_v4_002'
  });
  assert.notEqual(updated, null);
  assert.equal(updated?.lifecycle_state, 'interrupted');
  assert.equal(updated?.metadata.reason, 'manual_interrupt');

  const listed = store.listWorkerRuntimeSessionsByTeam('team_v4_002');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.agent_id, 'agent_v4_002');

  const deleted = store.deleteWorkerRuntimeSession('agent_v4_002');
  assert.equal(deleted, true);
  assert.equal(store.getWorkerRuntimeSession('agent_v4_002'), null);

  store.close();
});

test('V4-002 unit: team_send and team_pull_inbox resolve persisted worker session after restart', () => {
  cleanup();

  const calls = {
    spawn: 0,
    send: 0,
    poll: 0,
    collect: 0
  };

  const provider: WorkerProvider = {
    name: 'v4-002-provider',
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
        instruction_id: 'instruction_v4_002',
        status: 'queued'
      };
    },
    poll: (input) => {
      calls.poll += 1;
      return {
        worker_id: input.worker_id,
        status: 'running',
        events: []
      };
    },
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => {
      calls.collect += 1;
      return {
        worker_id: input.worker_id,
        artifacts: []
      };
    }
  };

  const adapter = new WorkerAdapter(provider);

  const serverA = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'worker session persistence'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const sender = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const receiver = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(sender.ok, true);
  assert.equal(receiver.ok, true);

  const receiverSessionBeforeRestart = serverA.store.getWorkerRuntimeSession(receiver.agent.agent_id as string);
  assert.notEqual(receiverSessionBeforeRestart, null);
  assert.equal(receiverSessionBeforeRestart?.provider, 'v4-002-provider');

  serverA.store.close();

  const serverB = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);

  const send = serverB.callTool('team_send', {
    team_id: teamId,
    from_agent_id: sender.agent.agent_id,
    to_agent_id: receiver.agent.agent_id,
    summary: 'restart-safe delivery',
    artifact_refs: [],
    idempotency_key: 'v4-002-idem-1'
  });
  assert.equal(send.ok, true);
  assert.equal(send.inserted, true);
  assert.equal(send.worker_delivery.status, 'queued');

  const inbox = serverB.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: receiver.agent.agent_id,
    ack: true
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.worker_adapter_active, true);

  assert.equal(calls.spawn, 2);
  assert.equal(calls.send, 1);
  assert.equal(calls.poll, 1);
  assert.equal(calls.collect, 1);

  const receiverSessionAfterRestart = serverB.store.getWorkerRuntimeSession(receiver.agent.agent_id as string);
  assert.notEqual(receiverSessionAfterRestart, null);
  assert.equal(receiverSessionAfterRestart?.lifecycle_state, 'active');

  serverB.store.close();
});
