import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const codexHome = '.tmp/at016-codex-home';

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
});

test('AT-016 integration: install/check/uninstall scripts succeed in isolated CODEX_HOME', () => {
  const env = { ...process.env, CODEX_HOME: codexHome };

  const installOutput = execFileSync('bash', ['./scripts/install.sh'], { encoding: 'utf8', env });
  assert.match(installOutput, /install:ok/);
  assert.equal(existsSync(`${codexHome}/skills/agent-teams/SKILL.md`), true);

  const checkOutput = execFileSync('bash', ['./scripts/check-config.sh'], { encoding: 'utf8', env });
  assert.match(checkOutput, /check-config:ok/);

  const uninstallOutput = execFileSync('bash', ['./scripts/uninstall.sh'], { encoding: 'utf8', env });
  assert.match(uninstallOutput, /uninstall:ok/);
  assert.equal(existsSync(`${codexHome}/skills/agent-teams`), false);
});
