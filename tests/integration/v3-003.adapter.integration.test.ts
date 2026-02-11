import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import {
  WorkerAdapter,
  type WorkerCollectArtifactsInput,
  type WorkerCollectArtifactsResult,
  type WorkerInterruptInput,
  type WorkerInterruptResult,
  type WorkerPollInput,
  type WorkerPollResult,
  type WorkerProvider,
  type WorkerSendInstructionInput,
  type WorkerSendInstructionResult,
  type WorkerSpawnInput,
  type WorkerSpawnResult
} from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v3-003-int.sqlite';
const logPath = '.tmp/v3-003-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function makeAdapter(options: {
  failSpawnForRole?: string;
  failPoll?: boolean;
} = {}): { adapter: WorkerAdapter; calls: string[] } {
  const calls: string[] = [];
  const provider: WorkerProvider = {
    name: 'mock-int',
    spawn: (input: WorkerSpawnInput): WorkerSpawnResult => {
      calls.push(`spawn:${input.role}`);
      if (options.failSpawnForRole && input.role === options.failSpawnForRole) {
        throw {
          code: 'SPAWN_PROVIDER_DOWN',
          message: 'worker backend unavailable',
          retryable: true,
          details: { role: input.role }
        };
      }
      return {
        worker_id: `worker_${input.agent_id}`,
        status: 'spawned',
        metadata: { role: input.role }
      };
    },
    sendInstruction: (input: WorkerSendInstructionInput): WorkerSendInstructionResult => {
      calls.push(`send:${input.worker_id}`);
      return {
        accepted: true,
        instruction_id: 'instruction_int_1',
        status: 'queued'
      };
    },
    poll: (input: WorkerPollInput): WorkerPollResult => {
      calls.push(`poll:${input.worker_id}`);
      if (options.failPoll) {
        throw {
          code: 'POLL_TIMEOUT',
          message: 'poll timed out',
          retryable: true
        };
      }
      return {
        worker_id: input.worker_id,
        status: 'running',
        cursor: 'cursor_int_1',
        events: [{ type: 'heartbeat' }],
        output: { summary: 'running' }
      };
    },
    interrupt: (input: WorkerInterruptInput): WorkerInterruptResult => {
      calls.push(`interrupt:${input.worker_id}`);
      return {
        interrupted: true,
        status: 'interrupted'
      };
    },
    collectArtifacts: (input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult => {
      calls.push(`collect:${input.worker_id}`);
      return {
        worker_id: input.worker_id,
        artifacts: [{ artifact_id: 'artifact_patch', version: 1 }]
      };
    }
  };

  return {
    adapter: new WorkerAdapter(provider),
    calls
  };
}

test('V3-003 integration: lifecycle tools expose adapter success envelopes through spawn/send/pull path', () => {
  const { adapter, calls } = makeAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: adapter });

  const started = server.callTool('team_start', {
    objective: 'adapter success path',
    max_threads: 3,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  assert.equal(lead.worker_session.provider, 'mock-int');
  assert.equal(typeof lead.worker_session.worker_id, 'string');

  const sent = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    to_agent_id: worker.agent.agent_id,
    summary: 'ship patch v1',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 1 }],
    idempotency_key: 'v3-003-send-idem'
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.worker_delivery.accepted, true);
  assert.equal(sent.worker_delivery.status, 'queued');

  const retried = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    to_agent_id: worker.agent.agent_id,
    summary: 'ship patch v2',
    artifact_refs: [{ artifact_id: 'artifact_patch', version: 2 }],
    idempotency_key: 'v3-003-send-idem'
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.inserted, false);
  assert.equal(retried.message.message_id, sent.message.message_id);

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: worker.agent.agent_id,
    ack: false
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.worker_poll.status, 'running');
  assert.equal(Array.isArray(inbox.worker_artifacts), true);
  assert.equal(inbox.worker_artifacts.length, 1);
  assert.equal(inbox.worker_errors.length, 0);

  assert.equal(calls.some((entry) => entry.startsWith('spawn:')), true);
  assert.equal(calls.some((entry) => entry.startsWith('send:')), true);
  assert.equal(calls.some((entry) => entry.startsWith('poll:')), true);
  assert.equal(calls.some((entry) => entry.startsWith('collect:')), true);
  assert.equal(calls.filter((entry) => entry.startsWith('send:')).length, 1);

  server.store.close();
});

test('V3-003 integration: lifecycle tools surface structured adapter failures without breaking inbox behavior', () => {
  const spawnFailing = makeAdapter({ failSpawnForRole: 'reviewer' });
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: spawnFailing.adapter });

  const started = server.callTool('team_start', {
    objective: 'adapter failure path',
    max_threads: 2,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const blockedSpawn = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(blockedSpawn.ok, false);
  assert.match(String(blockedSpawn.error ?? ''), /worker adapter spawn failed/);
  assert.equal(blockedSpawn.worker_error.domain, 'worker_adapter');
  assert.equal(blockedSpawn.worker_error.code, 'SPAWN_PROVIDER_DOWN');
  assert.equal(blockedSpawn.worker_error.operation, 'spawn');
  assert.equal(blockedSpawn.worker_error.retryable, true);

  const status = server.callTool('team_status', { team_id: teamId });
  assert.equal(status.ok, true);
  assert.equal(status.metrics.agents, 0);

  const pollFailing = makeAdapter({ failPoll: true });
  const pollServer = createServer({
    dbPath: '.tmp/v3-003-int-poll.sqlite',
    logPath: '.tmp/v3-003-int-poll.log'
  });
  pollServer.start();
  registerTeamLifecycleTools(pollServer);
  registerAgentLifecycleTools(pollServer, { workerAdapter: pollFailing.adapter });

  const pollTeam = pollServer.callTool('team_start', {
    objective: 'adapter poll failure',
    max_threads: 3,
    profile: 'default'
  });
  const pollTeamId = pollTeam.team.team_id;
  const pollLead = pollServer.callTool('team_spawn', { team_id: pollTeamId, role: 'lead' });
  const pollWorker = pollServer.callTool('team_spawn', { team_id: pollTeamId, role: 'implementer' });
  assert.equal(pollLead.ok, true);
  assert.equal(pollWorker.ok, true);

  pollServer.callTool('team_send', {
    team_id: pollTeamId,
    from_agent_id: pollLead.agent.agent_id,
    to_agent_id: pollWorker.agent.agent_id,
    summary: 'poll failure still returns inbox',
    artifact_refs: [],
    idempotency_key: 'v3-003-poll-fail'
  });

  const inbox = pollServer.callTool('team_pull_inbox', {
    team_id: pollTeamId,
    agent_id: pollWorker.agent.agent_id,
    ack: false
  });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.worker_errors.length, 1);
  assert.equal(inbox.worker_errors[0].domain, 'worker_adapter');
  assert.equal(inbox.worker_errors[0].operation, 'poll');
  assert.equal(inbox.worker_errors[0].code, 'POLL_TIMEOUT');

  pollServer.store.close();
  rmSync('.tmp/v3-003-int-poll.sqlite', { force: true });
  rmSync('.tmp/v3-003-int-poll.sqlite-wal', { force: true });
  rmSync('.tmp/v3-003-int-poll.sqlite-shm', { force: true });
  rmSync('.tmp/v3-003-int-poll.log', { force: true });

  server.store.close();
});

test('V3-003 integration: invalid explicit workerAdapter config fails closed with structured envelopes', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, {
    workerAdapter: {
      spawn: true
    } as unknown as WorkerAdapter
  });

  const started = server.callTool('team_start', {
    objective: 'invalid adapter config',
    max_threads: 2,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;
  const ts = new Date().toISOString();
  server.store.createAgent({
    agent_id: 'agent_fake_from',
    team_id: teamId,
    role: 'lead',
    status: 'idle',
    created_at: ts,
    updated_at: ts
  });
  server.store.createAgent({
    agent_id: 'agent_fake_to',
    team_id: teamId,
    role: 'implementer',
    status: 'idle',
    created_at: ts,
    updated_at: ts
  });
  server.store.createAgent({
    agent_id: 'agent_fake',
    team_id: teamId,
    role: 'reviewer',
    status: 'idle',
    created_at: ts,
    updated_at: ts
  });

  const spawn = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  assert.equal(spawn.ok, false);
  assert.equal(spawn.worker_error.code, 'INVALID_WORKER_ADAPTER');
  assert.equal(spawn.worker_error.operation, 'spawn');
  assert.equal(spawn.worker_error.details.source, 'options');

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: 'agent_fake_from',
    to_agent_id: 'agent_fake_to',
    summary: 'should fail closed',
    artifact_refs: [],
    idempotency_key: 'v3-003-invalid-adapter-send'
  });
  assert.equal(send.ok, false);
  assert.equal(send.worker_error.code, 'INVALID_WORKER_ADAPTER');
  assert.equal(send.worker_error.operation, 'send_instruction');
  assert.equal(send.worker_error.details.source, 'options');

  const pull = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: 'agent_fake',
    ack: false
  });
  assert.equal(pull.ok, false);
  assert.equal(pull.worker_error.code, 'INVALID_WORKER_ADAPTER');
  assert.equal(pull.worker_error.operation, 'poll');
  assert.equal(pull.worker_error.details.source, 'options');

  server.store.close();
});
