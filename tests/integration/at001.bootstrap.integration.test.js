import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('AT-001 lint script is runnable from integration path', () => {
  const output = execFileSync('npm', ['run', 'lint'], { encoding: 'utf8' });
  assert.match(output, /validated/);
});
