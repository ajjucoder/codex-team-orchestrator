import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';

const dbPath = '.tmp/at007-unit.sqlite';
const logPath = '.tmp/at007-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function setup() {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', { objective: 'task board', max_threads: 3 });
  const teamId = team.team.team_id;
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });

  return { server, teamId, workerId: worker.agent.agent_id };
}

test('AT-007 create and list tasks', () => {
  const { server, teamId } = setup();

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Implement AT-007',
    description: 'lock-safe board',
    priority: 2
  });

  assert.equal(created.ok, true);
  assert.match(created.task.task_id, /^task_/);
  assert.equal(created.task.lock_version, 0);

  const listed = server.callTool('team_task_list', { team_id: teamId });
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].status, 'todo');

  server.store.close();
});

test('AT-007 claim/update enforce optimistic lock version', () => {
  const { server, teamId, workerId } = setup();

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Claim me',
    priority: 1
  }).task;

  const claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: workerId,
    expected_lock_version: 0
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.task.claimed_by, workerId);
  assert.equal(claim.task.lock_version, 1);

  const staleClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: workerId,
    expected_lock_version: 0
  });
  assert.equal(staleClaim.ok, false);
  assert.match(staleClaim.error, /lock conflict/);

  const update = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task_id,
    status: 'done',
    expected_lock_version: 1
  });
  assert.equal(update.ok, true);
  assert.equal(update.task.status, 'done');
  assert.equal(update.task.lock_version, 2);

  server.store.close();
});
