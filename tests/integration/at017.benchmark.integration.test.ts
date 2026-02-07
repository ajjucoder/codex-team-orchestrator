import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('AT-017 integration: benchmark script emits pass gate and report artifact', () => {
  const outputPath = '.tmp/at017-integration-report.json';
  const output = execFileSync('bash', [
    './scripts/benchmark.sh',
    '--baseline',
    'fixed-6',
    '--candidate',
    'adaptive',
    '--mode',
    'replay',
    '--eval-set',
    'benchmarks/replay-eval-set.json',
    '--out',
    outputPath
  ], { encoding: 'utf8' });

  assert.match(output, /benchmark:pass=true/);
  assert.match(output, /benchmark:mode=replay/);
  assert.equal(existsSync(outputPath), true);
});
