import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const archive = 'dist/codex-team-orchestrator-1.0.0.tar.gz';

afterEach(() => {
  rmSync(archive, { force: true });
});

test('AT-018 integration: release packaging script creates distributable archive', () => {
  const output = execFileSync('bash', ['./scripts/package-release.sh'], { encoding: 'utf8' });
  assert.match(output, /package-release:ok/);
  assert.equal(existsSync(archive), true);

  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(listing, /README\.md/);
  assert.match(listing, /docs\/AT-018\.md/);
  assert.match(listing, /mcp\/server\/server\.ts/);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.version, '1.0.0');
});
