import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexWorkerAdapter } from '../../mcp/runtime/providers/codex.js';
import { HeadlessTransport } from '../../mcp/runtime/transports/headless-transport.js';
import { TmuxManager } from '../../mcp/runtime/tmux-manager.js';
import { TmuxTransport } from '../../mcp/runtime/transports/tmux-transport.js';

const MULTILINE_PAYLOAD = 'echo hello\nrm -rf /\n$(cat ~/.ssh/id_rsa)';

test('V4-003 integration: headless transport preserves multiline instruction content through framed channel', () => {
  const transport = new HeadlessTransport({ maxInstructionBytes: 64 * 1024 });
  const adapter = createCodexWorkerAdapter(transport);

  const spawned = adapter.spawn({
    team_id: 'team_v4_003',
    agent_id: 'agent_headless',
    role: 'implementer',
    model: null,
    metadata: {}
  });
  assert.equal(spawned.ok, true);

  const workerId = spawned.ok ? spawned.data.worker_id : '';
  const sent = adapter.sendInstruction({
    worker_id: workerId,
    instruction: MULTILINE_PAYLOAD,
    idempotency_key: 'v4-003-headless-1',
    artifact_refs: []
  });
  assert.equal(sent.ok, true);
  if (sent.ok) {
    assert.equal(sent.data.accepted, true);
  }

  const polled = adapter.poll({ worker_id: workerId, cursor: null, limit: 10 });
  assert.equal(polled.ok, true);
  if (polled.ok) {
    const events = polled.data.events ?? [];
    assert.equal(events.length >= 1, true);
    const firstEvent = events[0] as Record<string, unknown>;
    assert.equal(String(firstEvent.instruction ?? ''), MULTILINE_PAYLOAD);
  }
});

test('V4-003 integration: tmux transport command args stay payload-free while dispatch remains accepted', () => {
  const calls: string[][] = [];
  const manager = new TmuxManager({
    runner: (args) => {
      calls.push(args);
      return '';
    }
  });

  const transport = new TmuxTransport({ manager, maxInstructionBytes: 64 * 1024 });
  const adapter = createCodexWorkerAdapter(transport);

  const spawned = adapter.spawn({
    team_id: 'team_v4_003',
    agent_id: 'agent_tmux',
    role: 'reviewer',
    model: null,
    metadata: {}
  });
  assert.equal(spawned.ok, true);

  const workerId = spawned.ok ? spawned.data.worker_id : '';
  const sent = adapter.sendInstruction({
    worker_id: workerId,
    instruction: MULTILINE_PAYLOAD,
    idempotency_key: 'v4-003-tmux-1',
    artifact_refs: []
  });
  assert.equal(sent.ok, true);
  if (sent.ok) {
    assert.equal(sent.data.accepted, true);
    assert.equal(sent.data.status, 'queued');
  }

  const allArgs = calls.flat();
  assert.equal(allArgs.some((arg) => arg.includes('rm -rf')), false);
  assert.equal(allArgs.some((arg) => arg.includes('id_rsa')), false);
});
