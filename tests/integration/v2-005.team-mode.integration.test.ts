import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-005-int.sqlite';
const logPath = '.tmp/v2-005-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-005 integration: team mode defaults and is visible via team_status', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'mode visibility',
    profile: 'default'
  });
  assert.equal(started.ok, true);

  const teamId = started.team.team_id;
  const statusDefault = server.callTool('team_status', { team_id: teamId });
  assert.equal(statusDefault.ok, true);
  assert.equal(statusDefault.team.mode, 'default');

  const updated = server.store.updateTeamMode(teamId, 'delegate');
  assert.ok(updated);

  const statusDelegate = server.callTool('team_status', { team_id: teamId });
  assert.equal(statusDelegate.ok, true);
  assert.equal(statusDelegate.team.mode, 'delegate');

  server.store.close();
});
