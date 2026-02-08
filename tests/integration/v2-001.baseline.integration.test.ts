import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('V2-001 integration: baseline freeze script verifies fixture contract', () => {
  const output = execFileSync('bash', ['./scripts/v2-baseline.sh'], { encoding: 'utf8' });
  assert.match(output, /v2-baseline:mode=verify/);
  assert.match(output, /v2-baseline:ok/);
});
