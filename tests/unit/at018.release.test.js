import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('AT-018 release metadata and docs exist', () => {
  for (const path of [
    'LICENSE',
    'CHANGELOG.md',
    '.github/workflows/ci.yml',
    'docs/release-checklist.md',
    'scripts/package-release.sh',
    'scripts/release-ready.sh'
  ]) {
    assert.equal(existsSync(path), true, `missing ${path}`);
  }

  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /benchmark\.sh/);
});
