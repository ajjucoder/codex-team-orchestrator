import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerHierarchyTools } from '../../mcp/server/tools/hierarchy.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/v3-107-federation.sqlite';
const logPath = '.tmp/v3-107-federation.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-107 integration: parent-child federation enforces delegation boundaries and escalation visibility', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerHierarchyTools(server);
  registerTaskBoardTools(server);
  registerAgentLifecycleTools(server);

  const parent = server.callTool('team_start', { objective: 'federation parent', max_threads: 4 });
  const parentId = parent.team.team_id as string;
  const child = server.callTool('team_child_start', {
    team_id: parentId,
    objective: 'federation child',
    max_threads: 3
  });
  assert.equal(child.ok, true);
  const childId = child.child_team.team_id as string;

  const delegated = server.callTool('team_delegate_task', {
    team_id: parentId,
    child_team_id: childId,
    title: 'child objective',
    priority: 2,
    required_role: 'implementer'
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.task.team_id, childId);

  const listed = server.callTool('team_child_list', { team_id: parentId, recursive: true });
  assert.equal(listed.ok, true);
  assert.equal(listed.child_count >= 1, true);

  const unrelated = server.callTool('team_start', { objective: 'unrelated parent', max_threads: 2 });
  const unrelatedId = unrelated.team.team_id as string;
  const unauthorized = server.callTool('team_delegate_task', {
    team_id: unrelatedId,
    child_team_id: childId,
    title: 'should fail',
    priority: 3
  });
  assert.equal(unauthorized.ok, false);
  assert.match(String(unauthorized.error ?? ''), /is not delegated under parent/);

  const parentLead = server.callTool('team_spawn', { team_id: parentId, role: 'lead' }).agent.agent_id as string;
  const childWorker = server.callTool('team_spawn', { team_id: childId, role: 'implementer' }).agent.agent_id as string;
  const crossTeamSend = server.callTool('team_send', {
    team_id: parentId,
    from_agent_id: parentLead,
    to_agent_id: childWorker,
    summary: 'cross-team should fail',
    artifact_refs: [],
    idempotency_key: 'v3-107-cross-team'
  });
  assert.equal(crossTeamSend.ok, false);
  assert.match(String(crossTeamSend.error ?? ''), /to_agent not in team/);

  const finalized = server.callTool('team_finalize', {
    team_id: childId,
    reason: 'child_failure'
  });
  assert.equal(finalized.ok, true);

  const rollup = server.callTool('team_hierarchy_rollup', {
    team_id: parentId,
    include_parent: true
  });
  assert.equal(rollup.ok, true);
  const escalation = (rollup.escalation_candidates as Array<Record<string, unknown>>)
    .find((row) => row.team_id === childId);
  assert.ok(escalation);
  assert.equal(escalation?.recommended_action, 'escalate_to_parent');

  server.store.close();
  cleanup();
});
