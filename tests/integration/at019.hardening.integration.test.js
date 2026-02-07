import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('AT-019 integration: smoke scripts validate fanout bands and hard cap', () => {
  const small = execFileSync('bash', ['./scripts/smoke.sh', 'small'], { encoding: 'utf8' });
  const medium = execFileSync('bash', ['./scripts/smoke.sh', 'medium'], { encoding: 'utf8' });
  const high = execFileSync('bash', ['./scripts/smoke.sh', 'high'], { encoding: 'utf8' });

  assert.match(small, /smoke:ok/);
  assert.match(medium, /smoke:ok/);
  assert.match(high, /smoke:ok/);
  assert.match(high, /smoke:threads=5|smoke:threads=6/);
});
