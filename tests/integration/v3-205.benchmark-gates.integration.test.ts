import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const benchmarkOut = '.tmp/v3-205-benchmark-report.json';
const chaosOut = '.tmp/v3-205-chaos-report.json';

afterEach(() => {
  rmSync(benchmarkOut, { force: true });
  rmSync(chaosOut, { force: true });
});

test('V3-205 integration: v3 benchmark gates enforce quality/cost/reliability/recovery thresholds', () => {
  const benchmarkOutput = execFileSync('bash', [
    './scripts/benchmark.sh',
    '--baseline',
    'fixed-6',
    '--candidate',
    'adaptive',
    '--mode',
    'synthetic',
    '--eval-set',
    'benchmarks/eval-set.json',
    '--out',
    benchmarkOut
  ], { encoding: 'utf8' });
  assert.match(benchmarkOutput, /benchmark:pass=true/);

  const chaosOutput = execFileSync('bash', [
    './scripts/chaos/run-chaos.sh',
    '--out',
    chaosOut,
    '--runs',
    '24',
    '--seed',
    '42'
  ], { encoding: 'utf8' });
  assert.match(chaosOutput, /chaos:ok/);

  const gates = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/v3-eval-gates.ts',
    '--report',
    benchmarkOut,
    '--chaos-report',
    chaosOut,
    '--min-quality',
    '0.95',
    '--max-quality-drop',
    '0',
    '--min-token-reduction',
    '1',
    '--max-failed-run-rate',
    '0.2',
    '--max-mttr-ms',
    '120000'
  ], { encoding: 'utf8' });
  assert.match(gates, /v3-eval-gates:pass=true/);
});
