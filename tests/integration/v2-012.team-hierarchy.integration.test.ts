import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-012-int.sqlite';
const logPath = '.tmp/v2-012-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-012 integration: team_start supports parent-child hierarchy and status visibility', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const root = server.callTool('team_start', {
    objective: 'root team',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(root.ok, true);
  const rootTeamId = root.team.team_id;

  const child = server.callTool('team_start', {
    objective: 'child team',
    profile: 'default',
    max_threads: 3,
    parent_team_id: rootTeamId
  });
  assert.equal(child.ok, true);
  assert.equal(child.team.parent_team_id, rootTeamId);
  assert.equal(child.team.root_team_id, rootTeamId);
  assert.equal(child.team.hierarchy_depth, 1);

  const grandchild = server.callTool('team_start', {
    objective: 'grandchild team',
    profile: 'default',
    max_threads: 2,
    parent_team_id: child.team.team_id
  });
  assert.equal(grandchild.ok, true);
  assert.equal(grandchild.team.root_team_id, rootTeamId);
  assert.equal(grandchild.team.hierarchy_depth, 2);

  const childStatus = server.callTool('team_status', { team_id: child.team.team_id });
  assert.equal(childStatus.ok, true);
  assert.equal(childStatus.team.parent_team_id, rootTeamId);
  assert.equal(childStatus.team.root_team_id, rootTeamId);
  assert.equal(childStatus.team.hierarchy_depth, 1);

  const descendants = server.store.listChildTeams(rootTeamId, true);
  assert.deepEqual(
    descendants.map((team) => team.team_id),
    [child.team.team_id, grandchild.team.team_id]
  );
  assert.equal(server.store.isDescendantTeam(rootTeamId, grandchild.team.team_id), true);

  const invalidParent = server.callTool('team_start', {
    objective: 'bad child',
    parent_team_id: 'team_missing_parent'
  });
  assert.equal(invalidParent.ok, false);
  assert.match(String(invalidParent.error ?? ''), /parent team not found/);

  server.store.close();
});
