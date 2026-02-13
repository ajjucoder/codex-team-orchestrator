import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendCommand,
  listSupportedBackends,
  registerBackendCommandBuilder,
  resetBackendCommandBuilders
} from '../../mcp/runtime/model-router.js';
import { TmuxManager } from '../../mcp/runtime/tmux-manager.js';
import { TmuxTransport } from '../../mcp/runtime/transports/tmux-transport.js';

afterEach(() => {
  resetBackendCommandBuilders();
});

test('V4-014 unit: backend command builder returns default codex command with model args', () => {
  const command = buildBackendCommand({
    backend: 'codex',
    role: 'implementer',
    model: 'gpt-5',
    metadata: {}
  });

  assert.equal(command.backend, 'codex');
  assert.equal(command.command, 'codex');
  assert.deepEqual(command.args, ['--model', 'gpt-5']);
});

test('V4-014 unit: backend command builder is provider-pluggable via registration', () => {
  registerBackendCommandBuilder('codex', ({ role, model }) => ({
    command: 'codex-custom',
    args: ['--role', role, ...(model ? ['--model', model] : [])]
  }));

  const command = buildBackendCommand({
    backend: 'codex',
    role: 'reviewer',
    model: 'gpt-5-mini',
    metadata: {}
  });

  assert.equal(command.command, 'codex-custom');
  assert.deepEqual(command.args, ['--role', 'reviewer', '--model', 'gpt-5-mini']);
});

test('V4-014 unit: unsupported backend states fail closed with actionable error', () => {
  assert.throws(() => {
    buildBackendCommand({
      backend: 'unsupported-backend',
      role: 'implementer',
      model: null,
      metadata: {}
    });
  }, /unsupported backend .*supported backends/i);

  assert.deepEqual(listSupportedBackends(), ['claude', 'codex', 'opencode']);
});

test('V4-014 unit: tmux transport uses backend command builder for launch command construction', () => {
  const calls: string[][] = [];
  const manager = new TmuxManager({
    runner: (args) => {
      calls.push(args);
      return '';
    }
  });
  const transport = new TmuxTransport({ manager });

  const spawned = transport.spawn({
    team_id: 'team_v4_014',
    agent_id: 'agent_v4_014',
    role: 'implementer',
    model: 'claude-sonnet',
    metadata: {
      backend: 'claude'
    }
  }) as Record<string, unknown>;

  assert.equal(calls.length >= 1, true);
  const newSessionCall = calls[0] ?? [];
  assert.deepEqual(newSessionCall.slice(0, 4), ['new-session', '-d', '-s', 'team_v4_014_agent_v4_014']);
  assert.equal(newSessionCall.includes('claude'), true);
  assert.equal(newSessionCall.includes('--model'), true);
  assert.equal(newSessionCall.includes('claude-sonnet'), true);

  const metadata = (spawned.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.runtime_backend, 'claude');
  assert.deepEqual(metadata.launch_command, ['claude', '--model', 'claude-sonnet']);
});

test('V4-014 unit: tmux transport rejects unsupported backend launch requests with structured error', () => {
  const manager = new TmuxManager({ runner: () => '' });
  const transport = new TmuxTransport({ manager });

  assert.throws(() => {
    transport.spawn({
      team_id: 'team_v4_014',
      agent_id: 'agent_v4_014_invalid',
      role: 'reviewer',
      model: null,
      metadata: {
        backend: 'invalid-backend'
      }
    });
  }, /BACKEND_COMMAND_UNSUPPORTED|backend selection failed/);
});
