import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerModeTools } from '../../mcp/server/tools/modes.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-007-unit.sqlite';
const logPath = '.tmp/v2-007-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-007 mode transitions enforce lead role and rollback invalid transitions', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerModeTools(server);

  const started = server.callTool('team_start', { objective: 'mode transitions', profile: 'default' });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);

  const deniedNonLead = server.callTool('team_mode_set', {
    team_id: teamId,
    mode: 'plan',
    reason: 'non lead should fail'
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(deniedNonLead.ok, false);
  assert.match(String(deniedNonLead.error ?? ''), /requires lead role/);

  const setPlan = server.callTool('team_mode_set', {
    team_id: teamId,
    mode: 'plan',
    reason: 'planning'
  }, {
    auth_agent_id: lead.agent.agent_id
  });
  assert.equal(setPlan.ok, true);
  assert.equal(setPlan.mode, 'plan');

  const invalidTransition = server.callTool('team_mode_set', {
    team_id: teamId,
    mode: 'delegate',
    reason: 'invalid direct transition'
  }, {
    auth_agent_id: lead.agent.agent_id
  });
  assert.equal(invalidTransition.ok, false);
  assert.match(String(invalidTransition.error ?? ''), /invalid mode transition plan -> delegate/);

  const persisted = server.store.getTeam(teamId);
  assert.equal(persisted?.mode, 'plan');

  const events = server.store.listEvents(teamId, 50);
  const transitionEvent = events.find((event) => event.event_type === 'team_mode_transition');
  assert.ok(transitionEvent);
  assert.equal(transitionEvent?.agent_id, lead.agent.agent_id);

  server.store.close();
});
