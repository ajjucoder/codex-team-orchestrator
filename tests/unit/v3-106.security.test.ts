import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommandPolicy, redactSensitiveValue, scanForSecrets } from '../../mcp/server/guardrails.js';

test('V3-106 unit: command policy blocks dangerous commands and plan-mode execution', () => {
  const policy = {
    command_policy: {
      default_allow: false,
      block_in_plan_mode: true,
      deny_patterns: 'rm\\s+-rf',
      allow_prefixes: {
        default: 'git status,npm run test'
      }
    }
  };

  const dangerous = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'rm -rf /tmp/test'
  });
  assert.equal(dangerous.allowed, false);
  assert.match(String(dangerous.matched_rule), /deny_pattern/);

  const planBlocked = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'plan',
    command: 'npm run test'
  });
  assert.equal(planBlocked.allowed, false);
  assert.equal(planBlocked.matched_rule, 'plan_mode_block');
});

test('V3-106 unit: secret scan and redaction sanitize sensitive payloads', () => {
  const scan = scanForSecrets('Authorization: Bearer abcdefghijklmnop');
  assert.equal(scan.matched, true);

  const redacted = redactSensitiveValue({
    token: 'abcd',
    nested: {
      message: 'api_key=supersecretvalue'
    }
  }) as Record<string, unknown>;
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal((redacted.nested as Record<string, unknown>).message, '[REDACTED_SECRET]');
});

test('V3-106 unit: allow-prefix matching requires command boundary and blocks chained commands', () => {
  const policy = {
    command_policy: {
      default_allow: false,
      allow_prefixes: {
        default: 'git status'
      }
    }
  };

  const exactMatch = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'git status'
  });
  assert.equal(exactMatch.allowed, true);
  assert.equal(exactMatch.matched_rule, 'allow_prefix:git status');

  const boundaryMatch = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'git status --short'
  });
  assert.equal(boundaryMatch.allowed, true);
  assert.equal(boundaryMatch.matched_rule, 'allow_prefix:git status');

  const boundaryMiss = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'git statusx --short'
  });
  assert.equal(boundaryMiss.allowed, false);
  assert.equal(boundaryMiss.matched_rule, 'allow_prefix_miss');

  const chainedCommand = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'git status && echo ok'
  });
  assert.equal(chainedCommand.allowed, false);
  assert.equal(chainedCommand.matched_rule, 'allow_prefix_chained_command_block');
});

test('V3-106 unit: deny-pattern precedence and default fallback remain intact', () => {
  const policy = {
    command_policy: {
      default_allow: true,
      deny_patterns: 'git\\s+status\\s+--short',
      allow_prefixes: {
        default: 'git status'
      }
    }
  };

  const denyPrecedence = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'git status --short'
  });
  assert.equal(denyPrecedence.allowed, false);
  assert.match(String(denyPrecedence.matched_rule), /deny_pattern/);

  const defaultFallback = evaluateCommandPolicy({
    policy,
    role: 'implementer',
    mode: 'default',
    command: 'echo hello world'
  });
  assert.equal(defaultFallback.allowed, true);
  assert.equal(defaultFallback.matched_rule, 'default_allow');
});
