import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerHierarchyTools } from '../../mcp/server/tools/hierarchy.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-013-int.sqlite';
const logPath = '.tmp/v2-013-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-013 integration: hierarchical delegation supports rollups and isolation', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerHierarchyTools(server);

  const parent = server.callTool('team_start', {
    objective: 'parent',
    profile: 'default',
    max_threads: 4
  });
  const unrelated = server.callTool('team_start', {
    objective: 'unrelated',
    profile: 'default',
    max_threads: 2
  });
  assert.equal(parent.ok, true);
  assert.equal(unrelated.ok, true);

  const childA = server.callTool('team_child_start', {
    team_id: parent.team.team_id,
    objective: 'child-a',
    max_threads: 3
  });
  const childB = server.callTool('team_child_start', {
    team_id: parent.team.team_id,
    objective: 'child-b',
    max_threads: 2
  });
  assert.equal(childA.ok, true);
  assert.equal(childB.ok, true);

  const delegatedA = server.callTool('team_delegate_task', {
    team_id: parent.team.team_id,
    child_team_id: childA.child_team.team_id,
    title: 'implement feature A',
    priority: 1,
    required_role: 'implementer'
  });
  const delegatedB = server.callTool('team_delegate_task', {
    team_id: parent.team.team_id,
    child_team_id: childB.child_team.team_id,
    title: 'review feature B',
    priority: 2,
    required_role: 'reviewer'
  });
  assert.equal(delegatedA.ok, true);
  assert.equal(delegatedB.ok, true);

  const blockedCrossTenant = server.callTool('team_delegate_task', {
    team_id: unrelated.team.team_id,
    child_team_id: childA.child_team.team_id,
    title: 'cross-tenant attempt',
    priority: 3
  });
  assert.equal(blockedCrossTenant.ok, false);

  const children = server.callTool('team_child_list', {
    team_id: parent.team.team_id,
    recursive: true,
    include_metrics: true
  });
  assert.equal(children.ok, true);
  assert.equal(children.child_count, 2);
  assert.equal(
    children.teams.every((team: Record<string, unknown>) => team.metrics && typeof team.metrics === 'object'),
    true
  );

  const rollup = server.callTool('team_hierarchy_rollup', {
    team_id: parent.team.team_id,
    include_parent: true
  });
  assert.equal(rollup.ok, true);
  assert.equal(rollup.descendant_count, 2);
  assert.equal(rollup.totals.teams, 3);
  assert.equal(rollup.totals.tasks.todo, 2);

  server.store.close();
});
