import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexTransport } from '../../mcp/runtime/transport-factory.js';
import { HeadlessTransport } from '../../mcp/runtime/transports/headless-transport.js';
import { TmuxTransport } from '../../mcp/runtime/transports/tmux-transport.js';

test('V4-011 unit: transport factory forces headless in CI for deterministic execution', () => {
  const resolved = createCodexTransport({
    mode: 'auto',
    ci: true,
    stdoutIsTTY: true,
    hasTmuxBinary: true
  });

  assert.equal(resolved.selected_backend, 'headless');
  assert.equal(resolved.reason, 'ci_headless');
  assert.equal(resolved.fallback_applied, false);
  assert.equal(resolved.transport instanceof HeadlessTransport, true);
});

test('V4-011 unit: transport factory forces headless in non-TTY mode', () => {
  const resolved = createCodexTransport({
    mode: 'auto',
    ci: false,
    stdoutIsTTY: false,
    hasTmuxBinary: true
  });

  assert.equal(resolved.selected_backend, 'headless');
  assert.equal(resolved.reason, 'non_tty_headless');
  assert.equal(resolved.fallback_applied, false);
  assert.equal(resolved.transport instanceof HeadlessTransport, true);
});

test('V4-011 unit: transport factory selects tmux when available in interactive auto mode', () => {
  const resolved = createCodexTransport({
    mode: 'auto',
    ci: false,
    stdoutIsTTY: true,
    hasTmuxBinary: true
  });

  assert.equal(resolved.selected_backend, 'tmux');
  assert.equal(resolved.reason, 'tmux_available');
  assert.equal(resolved.fallback_applied, false);
  assert.equal(resolved.transport instanceof TmuxTransport, true);
});

test('V4-011 unit: explicit tmux mode falls back to headless when tmux is unavailable', () => {
  const resolved = createCodexTransport({
    mode: 'tmux',
    ci: false,
    stdoutIsTTY: true,
    hasTmuxBinary: false
  });

  assert.equal(resolved.selected_backend, 'headless');
  assert.equal(resolved.reason, 'tmux_unavailable_fallback');
  assert.equal(resolved.fallback_applied, true);
  assert.equal(resolved.transport instanceof HeadlessTransport, true);
});

test('V4-011 unit: transport mode can be sourced from environment feature flag', () => {
  const resolved = createCodexTransport({
    env: {
      ATX_MANAGED_RUNTIME_TRANSPORT: 'headless'
    },
    ci: false,
    stdoutIsTTY: true,
    hasTmuxBinary: true
  });

  assert.equal(resolved.requested_mode, 'headless');
  assert.equal(resolved.mode_source, 'env');
  assert.equal(resolved.selected_backend, 'headless');
  assert.equal(resolved.reason, 'explicit_headless');
});
