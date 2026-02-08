import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const reportPath = '.tmp/v2-016-benchmark-report.json';

afterEach(() => {
  rmSync(reportPath, { force: true });
});

test('V2-016 integration: benchmark report passes v2 quality-vs-cost gates', () => {
  const benchmark = execFileSync(
    'bash',
    ['./scripts/benchmark.sh', '--baseline', 'fixed-6', '--candidate', 'adaptive', '--out', reportPath],
    { encoding: 'utf8' }
  );
  assert.match(benchmark, /benchmark:pass=true/);

  const gates = execFileSync(
    'node',
    [
      '--import',
      'tsx',
      './scripts/v2-eval-gates.ts',
      '--report',
      reportPath,
      '--min-quality',
      '0.95',
      '--max-quality-drop',
      '0',
      '--min-token-reduction',
      '1'
    ],
    { encoding: 'utf8' }
  );
  assert.match(gates, /v2-eval-gates:pass=true/);

  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    baseline_summary: { median_tokens: number; median_quality: number };
    candidate_summary: { median_tokens: number; median_quality: number };
    pass: boolean;
  };
  assert.equal(report.pass, true);
  assert.equal(report.candidate_summary.median_tokens < report.baseline_summary.median_tokens, true);
  assert.equal(report.candidate_summary.median_quality >= report.baseline_summary.median_quality, true);
});
