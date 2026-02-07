import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';

const dbPath = '.tmp/at007-int.sqlite';
const logPath = '.tmp/at007-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-007 integration: conflicting claims result in single winner', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', { objective: 'conflict test', max_threads: 4 });
  const teamId = team.team.team_id;
  const workerA = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const workerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Resolve lock conflict',
    priority: 1
  }).task;

  const claimA = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: workerA.agent.agent_id,
    expected_lock_version: 0
  });

  const claimB = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: workerB.agent.agent_id,
    expected_lock_version: 0
  });

  assert.equal(claimA.ok, true);
  assert.equal(claimB.ok, false);
  assert.match(claimB.error, /lock conflict/);

  const finalState = server.callTool('team_task_list', { team_id: teamId });
  assert.equal(finalState.ok, true);
  assert.equal(finalState.tasks[0].claimed_by, workerA.agent.agent_id);
  assert.equal(finalState.tasks[0].lock_version, 1);

  server.store.close();
});
