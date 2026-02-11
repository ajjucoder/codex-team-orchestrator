import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { createCodexWorkerAdapter, type CodexTransport } from '../../mcp/runtime/providers/codex.js';

class MockProvider implements WorkerProvider {
  readonly name = 'mock-provider';
  readonly calls: string[] = [];

  spawn(input: WorkerSpawnInput): WorkerSpawnResult {
    this.calls.push(`spawn:${input.agent_id}`);
    return {
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned',
      metadata: { role: input.role }
    };
  }

  sendInstruction(input: WorkerSendInstructionInput): WorkerSendInstructionResult {
    this.calls.push(`send:${input.worker_id}`);
    return {
      accepted: true,
      instruction_id: 'instruction_1',
      status: 'queued'
    };
  }

  poll(input: WorkerPollInput): WorkerPollResult {
    this.calls.push(`poll:${input.worker_id}`);
    return {
      worker_id: input.worker_id,
      status: 'running',
      cursor: 'cursor_1',
      events: [{ type: 'heartbeat' }],
      output: { summary: 'working' }
    };
  }

  interrupt(input: WorkerInterruptInput): WorkerInterruptResult {
    this.calls.push(`interrupt:${input.worker_id}`);
    return {
      interrupted: true,
      status: 'interrupted'
    };
  }

  collectArtifacts(input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult {
    this.calls.push(`collect:${input.worker_id}`);
    return {
      worker_id: input.worker_id,
      artifacts: [
        { artifact_id: 'artifact_patch', version: 1 }
      ]
    };
  }
}

test('V3-003 unit: adapter wraps provider operations with normalized success envelopes', () => {
  const provider = new MockProvider();
  const adapter = new WorkerAdapter(provider);

  const spawn = adapter.spawn({
    team_id: 'team_v3',
    agent_id: 'agent_impl',
    role: 'implementer',
    model: 'gpt-5'
  });
  assert.equal(spawn.ok, true);
  if (spawn.ok) {
    assert.equal(spawn.provider, 'mock-provider');
    assert.equal(spawn.operation, 'spawn');
    assert.equal(spawn.data.worker_id, 'worker_agent_impl');
  }

  const send = adapter.sendInstruction({
    worker_id: 'worker_agent_impl',
    instruction: 'apply patch'
  });
  assert.equal(send.ok, true);
  if (send.ok) {
    assert.equal(send.operation, 'send_instruction');
    assert.equal(send.data.accepted, true);
  }

  const poll = adapter.poll({
    worker_id: 'worker_agent_impl'
  });
  assert.equal(poll.ok, true);
  if (poll.ok) {
    assert.equal(poll.operation, 'poll');
    assert.equal(poll.data.status, 'running');
  }

  const interrupt = adapter.interrupt({
    worker_id: 'worker_agent_impl',
    reason: 'cancel'
  });
  assert.equal(interrupt.ok, true);
  if (interrupt.ok) {
    assert.equal(interrupt.operation, 'interrupt');
    assert.equal(interrupt.data.interrupted, true);
  }

  const artifacts = adapter.collectArtifacts({
    worker_id: 'worker_agent_impl'
  });
  assert.equal(artifacts.ok, true);
  if (artifacts.ok) {
    assert.equal(artifacts.operation, 'collect_artifacts');
    assert.equal(artifacts.data.artifacts[0]?.artifact_id, 'artifact_patch');
  }

  assert.deepEqual(provider.calls, [
    'spawn:agent_impl',
    'send:worker_agent_impl',
    'poll:worker_agent_impl',
    'interrupt:worker_agent_impl',
    'collect:worker_agent_impl'
  ]);
});

test('V3-003 unit: adapter normalizes unknown failures into structured error envelopes', () => {
  const provider: WorkerProvider = {
    name: 'failing-provider',
    spawn: () => {
      throw { code: 'SPAWN_TIMEOUT', message: 'spawn timed out', retryable: true, details: { timeout_ms: 2500 } };
    },
    sendInstruction: () => {
      throw new Error('send exploded');
    },
    poll: () => ({
      worker_id: 'worker_x',
      status: 'running'
    }),
    interrupt: () => ({
      interrupted: true,
      status: 'interrupted'
    }),
    collectArtifacts: () => ({
      worker_id: 'worker_x',
      artifacts: []
    })
  };

  const adapter = new WorkerAdapter(provider);

  const spawn = adapter.spawn({
    team_id: 'team_v3',
    agent_id: 'agent_fail',
    role: 'implementer',
    model: null
  });
  assert.equal(spawn.ok, false);
  if (!spawn.ok) {
    assert.equal(spawn.provider, 'failing-provider');
    assert.equal(spawn.error.operation, 'spawn');
    assert.equal(spawn.error.code, 'SPAWN_TIMEOUT');
    assert.equal(spawn.error.retryable, true);
    assert.equal(spawn.error.details.timeout_ms, 2500);
  }

  const send = adapter.sendInstruction({
    worker_id: 'worker_x',
    instruction: 'do work'
  });
  assert.equal(send.ok, false);
  if (!send.ok) {
    assert.equal(send.error.operation, 'send_instruction');
    assert.equal(send.error.code, 'WORKER_PROVIDER_ERROR');
    assert.equal(send.error.message, 'send exploded');
    assert.equal(send.error.worker_id, 'worker_x');
  }
});

test('V3-003 unit: codex provider works via injected transport and malformed responses map to envelopes', () => {
  const transport: CodexTransport = {
    spawn: () => ({
      worker_id: 'worker_codex_1',
      status: 'spawned',
      metadata: { backend: 'stub' }
    }),
    sendInstruction: () => ({
      accepted: true,
      instruction_id: 'instruction_codex_1',
      status: 'queued'
    }),
    poll: () => ({
      worker_id: 'worker_codex_1',
      status: 'running',
      events: [{ type: 'output' }],
      output: { summary: 'ok' }
    }),
    interrupt: () => ({
      interrupted: true,
      status: 'interrupted'
    }),
    collectArtifacts: () => ({
      worker_id: 'worker_codex_1',
      artifacts: [
        { artifact_id: 'artifact_patch', version: 2, name: 'Patch' }
      ]
    })
  };

  const adapter = createCodexWorkerAdapter(transport);
  const spawned = adapter.spawn({
    team_id: 'team_v3',
    agent_id: 'agent_codex',
    role: 'reviewer',
    model: 'gpt-5-codex'
  });
  assert.equal(spawned.ok, true);
  if (spawned.ok) {
    assert.equal(spawned.provider, 'codex');
    assert.equal(spawned.data.worker_id, 'worker_codex_1');
  }

  const artifacts = adapter.collectArtifacts({
    worker_id: 'worker_codex_1',
    limit: 10
  });
  assert.equal(artifacts.ok, true);
  if (artifacts.ok) {
    assert.equal(artifacts.data.artifacts.length, 1);
    assert.equal(artifacts.data.artifacts[0]?.artifact_id, 'artifact_patch');
  }

  const malformed = createCodexWorkerAdapter({
    ...transport,
    spawn: () => ({})
  });
  const malformedSpawn = malformed.spawn({
    team_id: 'team_v3',
    agent_id: 'agent_codex_bad',
    role: 'implementer',
    model: null
  });
  assert.equal(malformedSpawn.ok, false);
  if (!malformedSpawn.ok) {
    assert.equal(malformedSpawn.error.code, 'PROVIDER_BAD_RESPONSE');
    assert.equal(malformedSpawn.error.operation, 'spawn');
    assert.match(malformedSpawn.error.message, /missing worker_id/);
  }

  const malformedSend = createCodexWorkerAdapter({
    ...transport,
    sendInstruction: () => ({
      status: 'queued'
    })
  });
  const malformedSendResult = malformedSend.sendInstruction({
    worker_id: 'worker_codex_1',
    instruction: 'run tests'
  });
  assert.equal(malformedSendResult.ok, false);
  if (!malformedSendResult.ok) {
    assert.equal(malformedSendResult.error.code, 'PROVIDER_BAD_RESPONSE');
    assert.equal(malformedSendResult.error.operation, 'send_instruction');
    assert.match(malformedSendResult.error.message, /boolean accepted/);
  }

  const malformedInterrupt = createCodexWorkerAdapter({
    ...transport,
    interrupt: () => ({
      status: 'interrupted'
    })
  });
  const malformedInterruptResult = malformedInterrupt.interrupt({
    worker_id: 'worker_codex_1',
    reason: 'cancel'
  });
  assert.equal(malformedInterruptResult.ok, false);
  if (!malformedInterruptResult.ok) {
    assert.equal(malformedInterruptResult.error.code, 'PROVIDER_BAD_RESPONSE');
    assert.equal(malformedInterruptResult.error.operation, 'interrupt');
    assert.match(malformedInterruptResult.error.message, /boolean interrupted/);
  }
});
