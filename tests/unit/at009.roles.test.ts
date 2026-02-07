import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { ROLE_NAMES } from '../../mcp/server/role-pack.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerRoleTools } from '../../mcp/server/tools/roles.js';

const dbPath = '.tmp/at009-unit.sqlite';
const logPath = '.tmp/at009-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-009 role pack includes required v1 roles', () => {
  assert.deepEqual(
    [...ROLE_NAMES].sort(),
    ['implementer', 'lead', 'planner', 'researcher', 'reviewer', 'tester'].sort()
  );
});

test('AT-009 team_role_catalog returns role definitions', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerRoleTools(server);

  const team = server.callTool('team_start', { objective: 'roles test' });
  const catalog = server.callTool('team_role_catalog', { team_id: team.team.team_id });

  assert.equal(catalog.ok, true);
  assert.equal(catalog.role_pack_version, 'v1');
  assert.equal(catalog.roles.length, 6);

  server.store.close();
});

test('AT-009 team_spawn rejects unknown roles', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const team = server.callTool('team_start', { objective: 'reject unknown role' });
  const result = server.callTool('team_spawn', {
    team_id: team.team.team_id,
    role: 'mystery'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown role/);

  server.store.close();
});
