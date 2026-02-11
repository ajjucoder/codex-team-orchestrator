import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const reportPath = '.tmp/v3-206-chaos-report.json';

afterEach(() => {
  rmSync(reportPath, { force: true });
});

test('V3-206 chaos harness reports bounded MTTR and failed-run-rate metrics', () => {
  const output = execFileSync('bash', [
    './scripts/chaos/run-chaos.sh',
    '--out',
    reportPath,
    '--runs',
    '30',
    '--seed',
    '42'
  ], { encoding: 'utf8' });

  assert.match(output, /chaos:ok/);
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  assert.equal(Number(report.total_runs), 30);
  assert.equal(Number(report.failed_run_rate) >= 0, true);
  assert.equal(Number(report.failed_run_rate) <= 1, true);
  assert.equal(Number(report.mttr_ms) > 0, true);
  assert.equal(Number(report.mttr_ms) <= 120000, true);
});
