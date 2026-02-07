import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/at005-int.sqlite';
const logPath = '.tmp/at005-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-005 integration: lifecycle tools emit structured events and persist state', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'end-to-end lifecycle',
    profile: 'default',
    max_threads: 3
  }, {
    active_session_model: 'gpt-5-codex'
  });
  assert.equal(started.ok, true);

  const teamId = started.team.team_id;
  const finalized = server.callTool('team_finalize', {
    team_id: teamId,
    reason: 'acceptance-complete'
  }, {
    agent_id: 'agent_lead'
  });
  assert.equal(finalized.ok, true);

  const persisted = server.store.getTeam(teamId);
  assert.equal(persisted.status, 'finalized');

  const events = server.store.listEvents(teamId, 20);
  assert.equal(events.some((event) => event.event_type === 'team_finalized'), true);

  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /tool_call:team_start/);
  assert.match(logText, /tool_call:team_finalize/);

  server.store.close();
});
