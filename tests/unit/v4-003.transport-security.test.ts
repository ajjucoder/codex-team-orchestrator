import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmuxManager } from '../../mcp/runtime/tmux-manager.js';
import { TmuxTransport, decodeInstructionFrame, encodeInstructionFrame } from '../../mcp/runtime/transports/tmux-transport.js';

const INJECTION_PAYLOAD = 'line1\nline2; rm -rf /\n$(touch /tmp/pwned)';

test('V4-003 unit: instruction framing is multiline-safe and avoids raw payload embedding', () => {
  const encoded = encodeInstructionFrame({
    instruction: INJECTION_PAYLOAD,
    cwd: '/tmp/workdir',
    idempotency_key: 'idem-v4-003',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }],
    metadata: { source: 'unit-test' }
  }, 64 * 1024);

  assert.equal(encoded.byte_length > 0, true);
  assert.equal(encoded.frame.includes(INJECTION_PAYLOAD), false);

  const decoded = decodeInstructionFrame(encoded.frame);
  assert.equal(decoded.instruction, INJECTION_PAYLOAD);
  assert.equal(decoded.cwd, '/tmp/workdir');
  assert.equal(decoded.idempotency_key, 'idem-v4-003');
  assert.deepEqual(decoded.artifact_refs, [{ artifact_id: 'artifact_a', version: 1 }]);
});

test('V4-003 unit: instruction frame enforces max payload bytes', () => {
  const oversized = 'x'.repeat(5000);
  assert.throws(() => {
    encodeInstructionFrame({ instruction: oversized }, 1024);
  }, /INSTRUCTION_TOO_LARGE|exceeds max bytes/);
});

test('V4-003 unit: tmux manager writes framed payload via file-buffer path (no raw payload in args)', () => {
  const calls: string[][] = [];
  const manager = new TmuxManager({
    runner: (args) => {
      calls.push(args);
      return '';
    }
  });

  const encoded = encodeInstructionFrame({
    instruction: INJECTION_PAYLOAD,
    idempotency_key: 'idem-injection'
  });

  const result = manager.sendFramedInstruction({
    session_name: 'safe_session',
    pane_ref: 'safe_session:0.0',
    frame: encoded.frame,
    idempotency_key: 'idem-injection'
  });

  assert.equal(result.accepted, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.[0], 'load-buffer');
  assert.equal(calls[1]?.[0], 'paste-buffer');
  assert.equal(calls[2]?.[0], 'send-keys');

  const allArgs = calls.flat();
  assert.equal(allArgs.some((arg) => arg.includes('rm -rf')), false);
  assert.equal(allArgs.some((arg) => arg.includes('/tmp/pwned')), false);
});

test('V4-003 unit: tmux manager preserves pane target format for interrupts', () => {
  const calls: string[][] = [];
  const manager = new TmuxManager({
    runner: (args) => {
      calls.push(args);
      return '';
    }
  });

  manager.interruptSession('team_x:0.0');
  assert.deepEqual(calls[0], ['send-keys', '-t', 'team_x:0.0', 'C-c']);
});

test('V4-003 unit: tmux transport delegates framed send through manager with injection-safe args', () => {
  const calls: string[][] = [];
  const manager = new TmuxManager({
    runner: (args) => {
      calls.push(args);
      return '';
    }
  });
  const transport = new TmuxTransport({ manager });

  const spawned = transport.spawn({
    team_id: 'team_v4_003',
    agent_id: 'agent_v4_003',
    role: 'implementer',
    model: null,
    metadata: {}
  }) as Record<string, unknown>;
  const workerId = String(spawned.worker_id);

  const send = transport.sendInstruction({
    worker_id: workerId,
    instruction: INJECTION_PAYLOAD,
    idempotency_key: 'idem-transport',
    artifact_refs: []
  }) as Record<string, unknown>;

  assert.equal(send.accepted, true);
  assert.equal(send.status, 'queued');

  const allArgs = calls.flat();
  assert.equal(allArgs.some((arg) => arg.includes('rm -rf')), false);
  assert.equal(allArgs.some((arg) => arg.includes('/tmp/pwned')), false);
});
