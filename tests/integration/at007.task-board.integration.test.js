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

test('AT-007 integration: DAG-ready queue returns unblocked tasks in priority order', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', { objective: 'dag queue', max_threads: 4 });
  const teamId = team.team.team_id;

  const rootLow = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'root-low',
    priority: 3
  }).task;
  const rootHigh = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'root-high',
    priority: 1
  }).task;
  const child = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'child',
    priority: 2,
    depends_on_task_ids: [rootHigh.task_id]
  }).task;

  assert.equal(child.status, 'blocked');

  const nextBefore = server.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(nextBefore.ok, true);
  assert.equal(nextBefore.tasks.length, 2);
  assert.equal(nextBefore.tasks[0].task_id, rootHigh.task_id);
  assert.equal(nextBefore.tasks[1].task_id, rootLow.task_id);

  const done = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: rootHigh.task_id,
    status: 'done',
    expected_lock_version: rootHigh.lock_version
  });
  assert.equal(done.ok, true);

  const nextAfter = server.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(nextAfter.ok, true);
  assert.equal(nextAfter.tasks.length, 2);
  assert.equal(nextAfter.tasks[0].task_id, child.task_id);
  assert.equal(nextAfter.tasks[1].task_id, rootLow.task_id);

  server.store.close();
});

test('AT-007 integration: loser-cancel policy emits cancellation and removes branches from ready queue', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', { objective: 'cancel losers', max_threads: 4 });
  const teamId = team.team.team_id;

  const winner = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'winner',
    priority: 1
  }).task;
  const loserA = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'loser-A',
    priority: 2
  }).task;
  const loserB = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'loser-B',
    priority: 3
  }).task;

  const cancel = server.callTool('team_task_cancel_others', {
    team_id: teamId,
    winner_task_id: winner.task_id,
    loser_task_ids: [loserA.task_id, loserB.task_id],
    reason: 'best branch selected'
  });

  assert.equal(cancel.ok, true);
  assert.equal(cancel.cancelled_count, 2);

  const tasks = server.callTool('team_task_list', { team_id: teamId });
  const cancelledTasks = tasks.tasks.filter((task) => task.status === 'cancelled');
  assert.equal(cancelledTasks.length, 2);

  const next = server.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(next.ok, true);
  assert.equal(next.tasks.length, 1);
  assert.equal(next.tasks[0].task_id, winner.task_id);

  const events = server.store.replayEvents(teamId, 100);
  assert.equal(events.some((event) => event.event_type === 'speculative_loser_cancelled'), true);

  server.store.close();
});
