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

test('AT-007 dependency DAG blocks downstream tasks until prerequisites are done', () => {
  const { server, teamId, workerId } = setup();

  const foundation = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'foundation',
    priority: 1
  }).task;

  const dependent = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'dependent',
    priority: 2,
    depends_on_task_ids: [foundation.task_id]
  }).task;

  assert.equal(dependent.status, 'blocked');
  assert.equal(dependent.unresolved_dependency_count, 1);

  const blockedClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: dependent.task_id,
    agent_id: workerId,
    expected_lock_version: dependent.lock_version
  });
  assert.equal(blockedClaim.ok, false);
  assert.match(blockedClaim.error, /task not claimable|unresolved dependencies/);

  const nextBefore = server.callTool('team_task_next', { team_id: teamId });
  assert.equal(nextBefore.ok, true);
  assert.equal(nextBefore.tasks.length, 1);
  assert.equal(nextBefore.tasks[0].task_id, foundation.task_id);

  const done = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: foundation.task_id,
    status: 'done',
    expected_lock_version: foundation.lock_version
  });
  assert.equal(done.ok, true);
  assert.equal(done.promoted_tasks.length, 1);
  assert.equal(done.promoted_tasks[0].task_id, dependent.task_id);

  const nextAfter = server.callTool('team_task_next', { team_id: teamId });
  assert.equal(nextAfter.ok, true);
  assert.equal(nextAfter.tasks[0].task_id, dependent.task_id);
  assert.equal(nextAfter.tasks[0].status, 'todo');
  assert.equal(nextAfter.tasks[0].unresolved_dependency_count, 0);

  server.store.close();
});

test('AT-007 dependency cycles are rejected', () => {
  const { server, teamId } = setup();

  const taskA = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'A',
    priority: 1
  }).task;
  const taskB = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'B',
    priority: 1,
    depends_on_task_ids: [taskA.task_id]
  }).task;

  const cycle = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: taskA.task_id,
    depends_on_task_ids: [taskB.task_id],
    expected_lock_version: taskA.lock_version
  });
  assert.equal(cycle.ok, false);
  assert.match(cycle.error, /dependency cycle detected/);

  server.store.close();
});

test('AT-007 speculative loser cancellation marks non-winning branches as cancelled', () => {
  const { server, teamId } = setup();

  const winner = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'winner',
    priority: 1
  }).task;
  const loserA = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'loser-a',
    priority: 2
  }).task;
  const loserB = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'loser-b',
    priority: 3
  }).task;

  const cancelled = server.callTool('team_task_cancel_others', {
    team_id: teamId,
    winner_task_id: winner.task_id,
    loser_task_ids: [loserA.task_id, loserB.task_id],
    reason: 'winner selected'
  });

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled_count, 2);
  assert.equal(cancelled.cancelled_tasks.every((task) => task.status === 'cancelled'), true);

  const queue = server.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(queue.ok, true);
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].task_id, winner.task_id);

  server.store.close();
});
