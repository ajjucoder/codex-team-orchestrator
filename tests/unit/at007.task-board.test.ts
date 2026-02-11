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
    required_role: 'implementer',
    priority: 2
  });

  assert.equal(created.ok, true);
  assert.match(created.task.task_id, /^task_/);
  assert.equal(created.task.lock_version, 0);
  assert.equal(created.task.required_role, 'implementer');

  const listed = server.callTool('team_task_list', { team_id: teamId });
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].status, 'todo');
  assert.equal(listed.tasks[0].required_role, 'implementer');

  server.store.close();
});

test('AT-007 required_role must be a known role on create/update', () => {
  const { server, teamId } = setup();

  const invalidCreate = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'invalid role',
    required_role: 'unknown-role',
    priority: 2
  });
  assert.equal(invalidCreate.ok, false);
  assert.match(invalidCreate.error, /unknown required_role/);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'valid',
    required_role: 'tester',
    priority: 2
  });
  assert.equal(created.ok, true);

  const invalidUpdate = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: created.task.task_id,
    required_role: 'invalid-role',
    expected_lock_version: created.task.lock_version
  });
  assert.equal(invalidUpdate.ok, false);
  assert.match(invalidUpdate.error, /unknown required_role/);

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

test('AT-007 claim enforces required_role against claiming agent', () => {
  const { server, teamId, workerId } = setup();
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Review me',
    required_role: 'reviewer',
    priority: 1
  }).task;

  const wrongRoleClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: workerId,
    expected_lock_version: task.lock_version
  });
  assert.equal(wrongRoleClaim.ok, false);
  assert.match(wrongRoleClaim.error, /requires role reviewer/);

  const correctClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: reviewer.agent.agent_id,
    expected_lock_version: task.lock_version
  });
  assert.equal(correctClaim.ok, true);
  assert.equal(correctClaim.task.claimed_by, reviewer.agent.agent_id);

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

  const nextBeforeByWorker = server.callTool('team_task_next', { team_id: teamId, for_agent_id: workerId });
  assert.equal(nextBeforeByWorker.ok, true);
  assert.equal(nextBeforeByWorker.role_filter, 'implementer');
  assert.equal(nextBeforeByWorker.tasks.length, 1);
  assert.equal(nextBeforeByWorker.tasks[0].task_id, foundation.task_id);

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

test('AT-007 dependency updates are blocked while task is in_progress', () => {
  const { server, teamId, workerId } = setup();

  const blocker = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'blocker',
    priority: 1
  }).task;
  const target = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'target',
    priority: 2
  }).task;

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: target.task_id,
    agent_id: workerId,
    expected_lock_version: target.lock_version
  });
  assert.equal(claimed.ok, true);

  const updateDeps = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: target.task_id,
    expected_lock_version: claimed.task.lock_version,
    depends_on_task_ids: [blocker.task_id]
  });
  assert.equal(updateDeps.ok, false);
  assert.match(updateDeps.error, /cannot change dependencies while task is in_progress/);

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

test('AT-007 team_task_next applies role filter before limit for for_agent_id queries', () => {
  const { server, teamId, workerId } = setup();
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(reviewer.ok, true);

  const reviewerA = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'review-a',
    priority: 1,
    required_role: 'reviewer'
  }).task;
  const reviewerB = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'review-b',
    priority: 2,
    required_role: 'reviewer'
  }).task;
  const implementerTask = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'implementer-task',
    priority: 3,
    required_role: 'implementer'
  }).task;

  const globalNext = server.callTool('team_task_next', { team_id: teamId, limit: 2 });
  assert.equal(globalNext.ok, true);
  assert.equal(globalNext.tasks.length, 2);
  assert.equal(globalNext.tasks[0].task_id, reviewerA.task_id);
  assert.equal(globalNext.tasks[1].task_id, reviewerB.task_id);

  const implementerNext = server.callTool('team_task_next', {
    team_id: teamId,
    for_agent_id: workerId,
    limit: 2
  });
  assert.equal(implementerNext.ok, true);
  assert.equal(implementerNext.role_filter, 'implementer');
  assert.equal(implementerNext.tasks.length, 1);
  assert.equal(implementerNext.tasks[0].task_id, implementerTask.task_id);

  server.store.close();
});
