import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerPolicyTools } from '../../mcp/server/tools/policies.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/at011-int.sqlite';
const logPath = '.tmp/at011-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-011 integration: profile swap changes behavior without code edits', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerPolicyTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', {
    objective: 'profile driven behavior',
    profile: 'default'
  });
  const teamId = team.team.team_id;

  const baseline = server.callTool('team_policy_get', { team_id: teamId });
  assert.equal(baseline.ok, true);
  assert.equal(baseline.policy.profile, 'default');

  const switched = server.callTool('team_policy_set_profile', {
    team_id: teamId,
    profile: 'deep'
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.team.max_threads, 5);

  const agents = [];
  for (let i = 0; i < 5; i += 1) {
    const spawned = server.callTool('team_spawn', {
      team_id: teamId,
      role: 'implementer'
    });
    agents.push(spawned.ok);
  }
  assert.equal(agents.every(Boolean), true);

  const overflow = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /max_threads exceeded/);

  server.store.close();
});
