import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../../benchmarks/harness.js';

test('AT-017 benchmark shows lower median token usage for adaptive with no quality regression', () => {
  const { report } = runBenchmark({
    evalSetPath: 'benchmarks/eval-set.json',
    baseline: 'fixed-6',
    candidate: 'adaptive',
    outputPath: '.tmp/at017-unit-benchmark.json'
  });

  assert.equal(report.pass, true);
  assert.equal(report.candidate_summary.median_tokens < report.baseline_summary.median_tokens, true);
  assert.equal(report.candidate_summary.median_quality >= report.baseline_summary.median_quality, true);
});
