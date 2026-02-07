import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';

for (const script of ['scripts/install.sh', 'scripts/uninstall.sh', 'scripts/check-config.sh']) {
  test(`AT-016 script exists: ${script}`, () => {
    assert.equal(existsSync(script), true);
    const mode = statSync(script).mode;
    assert.equal(Boolean(mode & 0o100), true, `${script} should be executable`);
  });
}
