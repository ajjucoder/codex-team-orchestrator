import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildV2BaselineSnapshot } from '../../benchmarks/v2-baseline.js';

test('V2-001 baseline snapshot matches frozen fixture', () => {
  const expected = JSON.parse(readFileSync('tests/fixtures/v2-001-baseline.snapshot.json', 'utf8'));
  const actual = buildV2BaselineSnapshot();
  assert.deepEqual(actual, expected);
});
