import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookEngine } from '../../mcp/server/hooks.js';

test('V2-008 hook engine enforces ordered pre-hook block semantics', () => {
  const engine = new HookEngine();
  const order: string[] = [];

  engine.register({
    name: 'hook_b',
    event: 'spawn',
    phase: 'pre',
    order: 20,
    handler: () => {
      order.push('b');
      return { allow: true };
    }
  });
  engine.register({
    name: 'hook_a',
    event: 'spawn',
    phase: 'pre',
    order: 10,
    handler: () => {
      order.push('a');
      return { allow: true };
    }
  });
  engine.register({
    name: 'hook_c_block',
    event: 'spawn',
    phase: 'pre',
    order: 30,
    handler: () => {
      order.push('c');
      return { allow: false, reason: 'blocked by policy' };
    }
  });

  const result = engine.dispatch('pre', {
    event: 'spawn',
    tool_name: 'team_spawn',
    input: {},
    context: {},
    result: null
  });
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(result.ok, false);
  assert.equal(result.blocked_by, 'hook_c_block');
  assert.equal(result.deny_reason, 'blocked by policy');
});

test('V2-008 hook engine supports timeout behavior with fail-open override', () => {
  const failClosed = new HookEngine();
  failClosed.register({
    name: 'slow_fail_closed',
    event: 'spawn',
    phase: 'pre',
    timeout_ms: 0,
    handler: () => {
      const end = Date.now() + 2;
      while (Date.now() < end) {
        // intentional delay for timeout
      }
      return { allow: true };
    }
  });

  const closedResult = failClosed.dispatch('pre', {
    event: 'spawn',
    tool_name: 'team_spawn',
    input: {},
    context: {},
    result: null
  });
  assert.equal(closedResult.ok, false);
  assert.equal(closedResult.blocked_by, 'slow_fail_closed');

  const failOpen = new HookEngine();
  failOpen.register({
    name: 'slow_fail_open',
    event: 'spawn',
    phase: 'pre',
    timeout_ms: 0,
    fail_closed: false,
    handler: () => {
      const end = Date.now() + 2;
      while (Date.now() < end) {
        // intentional delay for timeout
      }
      return { allow: true };
    }
  });

  const openResult = failOpen.dispatch('pre', {
    event: 'spawn',
    tool_name: 'team_spawn',
    input: {},
    context: {},
    result: null
  });
  assert.equal(openResult.ok, true);
});

test('V2-008 post hooks are traced without blocking tool completion', () => {
  const engine = new HookEngine();
  engine.register({
    name: 'post_advisory',
    event: 'resume',
    phase: 'post',
    handler: () => ({ allow: false, reason: 'advisory only' })
  });

  const result = engine.dispatch('post', {
    event: 'resume',
    tool_name: 'team_resume',
    input: {},
    context: {},
    result: { ok: true }
  });
  assert.equal(result.ok, true);
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0].outcome, 'block');
});
