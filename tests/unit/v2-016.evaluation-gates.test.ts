import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const passReportPath = '.tmp/v2-016-pass-report.json';
const failReportPath = '.tmp/v2-016-fail-report.json';

afterEach(() => {
  rmSync(passReportPath, { force: true });
  rmSync(failReportPath, { force: true });
});

test('V2-016 eval gates pass for acceptable quality-vs-cost report', () => {
  writeFileSync(passReportPath, `${JSON.stringify({
    pass: true,
    baseline_summary: { median_tokens: 10000, median_quality: 1 },
    candidate_summary: { median_tokens: 9200, median_quality: 1 },
    deltas: { median_tokens: -800, median_quality: 0 }
  })}\n`);

  const output = execFileSync(
    'node',
    [
      '--import',
      'tsx',
      './scripts/v2-eval-gates.ts',
      '--report',
      passReportPath,
      '--min-quality',
      '0.95',
      '--max-quality-drop',
      '0',
      '--min-token-reduction',
      '100'
    ],
    { encoding: 'utf8' }
  );
  assert.match(output, /v2-eval-gates:pass=true/);
});

test('V2-016 eval gates fail when candidate quality drops', () => {
  writeFileSync(failReportPath, `${JSON.stringify({
    pass: true,
    baseline_summary: { median_tokens: 10000, median_quality: 1 },
    candidate_summary: { median_tokens: 9500, median_quality: 0.9 },
    deltas: { median_tokens: -500, median_quality: -0.1 }
  })}\n`);

  let threw = false;
  try {
    execFileSync(
      'node',
      [
        '--import',
        'tsx',
        './scripts/v2-eval-gates.ts',
        '--report',
        failReportPath,
        '--min-quality',
        '0.95',
        '--max-quality-drop',
        '0',
        '--min-token-reduction',
        '100'
      ],
      { encoding: 'utf8' }
    );
  } catch (error) {
    threw = true;
    const details = error as { status?: number; stdout?: string };
    assert.equal(details.status, 1);
    assert.match(String(details.stdout ?? ''), /v2-eval-gates:pass=false/);
  }
  assert.equal(threw, true);
});
