import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerModeTools } from '../../mcp/server/tools/modes.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-007-int.sqlite';
const logPath = '.tmp/v2-007-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-007 integration: ttl mode transitions auto-reset safely', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerModeTools(server);

  const started = server.callTool('team_start', { objective: 'ttl transition', profile: 'default' });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  assert.equal(lead.ok, true);

  const setPlan = server.callTool('team_mode_set', {
    team_id: teamId,
    mode: 'plan',
    reason: 'short plan window',
    ttl_ms: 1
  }, {
    auth_agent_id: lead.agent.agent_id
  });
  assert.equal(setPlan.ok, true);
  assert.equal(setPlan.mode, 'plan');

  const target = Date.now() + 5;
  while (Date.now() < target) {
    // wait for ttl window to expire
  }

  const mode = server.callTool('team_mode_get', { team_id: teamId });
  assert.equal(mode.ok, true);
  assert.equal(mode.mode, 'default');
  assert.equal(mode.ttl_reset, true);
  assert.equal(mode.transition.reason, 'ttl_expired_auto_reset');

  const persisted = server.store.getTeam(teamId);
  assert.equal(persisted?.mode, 'default');

  server.store.close();
});
