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
