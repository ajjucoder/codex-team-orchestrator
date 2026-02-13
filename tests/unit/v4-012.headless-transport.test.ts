import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexWorkerAdapter } from '../../mcp/runtime/providers/codex.js';
import { createCodexTransport } from '../../mcp/runtime/transport-factory.js';

test('V4-012 unit: headless fallback remains deterministic in CI by preserving full instruction payload', () => {
  const resolved = createCodexTransport({
    mode: 'auto',
    ci: true,
    stdoutIsTTY: true,
    hasTmuxBinary: true
  });
  assert.equal(resolved.selected_backend, 'headless');

  const adapter = createCodexWorkerAdapter(resolved.transport);
  const spawn = adapter.spawn({
    team_id: 'team_v4_012',
    agent_id: 'agent_v4_012',
    role: 'implementer',
    model: null,
    metadata: {}
  });
  assert.equal(spawn.ok, true);

  const workerId = spawn.ok ? spawn.data.worker_id : '';
  const payload = 'line one\nline two\n$unsafe()';
  const sent = adapter.sendInstruction({
    worker_id: workerId,
    instruction: payload,
    idempotency_key: 'v4-012-headless-1',
    artifact_refs: []
  });
  assert.equal(sent.ok, true);

  const polled = adapter.poll({
    worker_id: workerId,
    cursor: null,
    limit: 10
  });
  assert.equal(polled.ok, true);
  if (!polled.ok) return;
  const events = polled.data.events ?? [];
  assert.equal(events.length >= 1, true);
  const first = events[0] as Record<string, unknown>;
  assert.equal(first.type, 'instruction_received');
  assert.equal(first.instruction, payload);
});

test('V4-012 unit: explicit tmux mode still fails over to headless when tmux cannot be used', () => {
  const resolved = createCodexTransport({
    mode: 'tmux',
    ci: false,
    stdoutIsTTY: true,
    hasTmuxBinary: false
  });

  assert.equal(resolved.selected_backend, 'headless');
  assert.equal(resolved.fallback_applied, true);

  const adapter = createCodexWorkerAdapter(resolved.transport);
  const spawn = adapter.spawn({
    team_id: 'team_v4_012',
    agent_id: 'agent_v4_012_tmux_fallback',
    role: 'reviewer',
    model: null,
    metadata: {}
  });
  assert.equal(spawn.ok, true);
  if (spawn.ok) {
    assert.match(spawn.data.worker_id, /^headless_/);
  }
});
