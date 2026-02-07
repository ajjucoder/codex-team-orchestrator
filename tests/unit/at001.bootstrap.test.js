import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const required = [
  'mcp/server',
  'mcp/schemas',
  'mcp/store',
  'skills/agent-teams/references',
  'profiles',
  'scripts',
  'benchmarks',
  'docs/standards.md',
  'package.json'
];

test('AT-001 required structure exists', () => {
  for (const path of required) {
    assert.equal(existsSync(path), true, `expected path to exist: ${path}`);
  }
});

test('AT-001 package scripts exist', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const script of ['format', 'lint', 'test', 'test:unit', 'test:integration', 'verify']) {
    assert.equal(typeof pkg.scripts[script], 'string', `missing script: ${script}`);
  }
});
