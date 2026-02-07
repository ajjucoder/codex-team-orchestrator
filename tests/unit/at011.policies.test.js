import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { parseSimpleYaml, PolicyEngine } from '../../mcp/server/policy-engine.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerPolicyTools } from '../../mcp/server/tools/policies.js';

const dbPath = '.tmp/at011-unit.sqlite';
const logPath = '.tmp/at011-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-011 simple YAML parser handles nested maps and scalar types', () => {
  const parsed = parseSimpleYaml('profile: fast\nlimits:\n  default_max_threads: 2\nguardrails:\n  compact_messages: true\n');
  assert.equal(parsed.profile, 'fast');
  assert.equal(parsed.limits.default_max_threads, 2);
  assert.equal(parsed.guardrails.compact_messages, true);
});

test('AT-011 policy engine loads swappable profiles', () => {
  const engine = new PolicyEngine('profiles');
  const fast = engine.loadProfile('fast');
  const deep = engine.loadProfile('deep');

  assert.equal(fast.profile, 'fast');
  assert.equal(deep.profile, 'deep');
  assert.notEqual(fast.budgets.token_soft_limit, deep.budgets.token_soft_limit);
});

test('AT-011 policy tools expose and switch profile', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerPolicyTools(server);

  const team = server.callTool('team_start', {
    objective: 'policy switch',
    profile: 'default'
  });
  const teamId = team.team.team_id;

  const before = server.callTool('team_policy_get', { team_id: teamId });
  assert.equal(before.ok, true);
  assert.equal(before.profile, 'default');

  const switched = server.callTool('team_policy_set_profile', {
    team_id: teamId,
    profile: 'fast'
  });

  assert.equal(switched.ok, true);
  assert.equal(switched.team.profile, 'fast');
  assert.equal(switched.team.max_threads, 2);

  server.store.close();
});
