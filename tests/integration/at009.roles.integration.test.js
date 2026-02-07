import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerRoleTools } from '../../mcp/server/tools/roles.js';

const dbPath = '.tmp/at009-int.sqlite';
const logPath = '.tmp/at009-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-009 integration: role catalog and spawn interplay produces structured traces', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerRoleTools(server);

  const team = server.callTool('team_start', {
    objective: 'role integration',
    max_threads: 3
  });
  const teamId = team.team.team_id;

  const catalog = server.callTool('team_role_catalog', { team_id: teamId });
  assert.equal(catalog.ok, true);
  assert.equal(catalog.roles.some((role) => role.name === 'reviewer'), true);

  const spawnReviewer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(spawnReviewer.ok, true);

  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /tool_call:team_role_catalog/);
  assert.match(logText, /tool_call:team_spawn/);

  server.store.close();
});
