import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerHierarchyTools } from '../../mcp/server/tools/hierarchy.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-013-unit.sqlite';
const logPath = '.tmp/v2-013-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-013 tools create/list child teams and enforce delegated task scope', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerHierarchyTools(server);

  const parent = server.callTool('team_start', {
    objective: 'parent',
    profile: 'default',
    max_threads: 4
  });
  const outsider = server.callTool('team_start', {
    objective: 'outsider',
    profile: 'default',
    max_threads: 2
  });
  assert.equal(parent.ok, true);
  assert.equal(outsider.ok, true);

  const child = server.callTool('team_child_start', {
    team_id: parent.team.team_id,
    objective: 'child'
  });
  assert.equal(child.ok, true);

  const grandchild = server.callTool('team_child_start', {
    team_id: child.child_team.team_id,
    objective: 'grandchild'
  });
  assert.equal(grandchild.ok, true);

  const listRecursive = server.callTool('team_child_list', {
    team_id: parent.team.team_id,
    recursive: true
  });
  assert.equal(listRecursive.ok, true);
  assert.equal(listRecursive.child_count, 2);

  const delegated = server.callTool('team_delegate_task', {
    team_id: parent.team.team_id,
    child_team_id: grandchild.child_team.team_id,
    title: 'delegate implementation',
    required_role: 'implementer',
    priority: 2
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.task.team_id, grandchild.child_team.team_id);

  const denied = server.callTool('team_delegate_task', {
    team_id: outsider.team.team_id,
    child_team_id: grandchild.child_team.team_id,
    title: 'unauthorized delegation',
    priority: 2
  });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error ?? ''), /not delegated under parent/);

  const rollup = server.callTool('team_hierarchy_rollup', {
    team_id: parent.team.team_id
  });
  assert.equal(rollup.ok, true);
  assert.equal(rollup.totals.teams, 3);
  assert.equal(rollup.totals.tasks.todo, 1);

  server.store.close();
});
