import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';

const dbPath = '.tmp/v3-002-int.sqlite';
const logPathA = '.tmp/v3-002-int-a.log';
const logPathB = '.tmp/v3-002-int-b.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for scheduler condition');
}

test('V3-002 integration: scheduler auto-dispatches and restart keeps in-flight ownership', async () => {
  const serverA = createServer({ dbPath, logPath: logPathA });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);
  registerTaskBoardTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'v3-002 scheduler integration',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const implementer = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const reviewer = serverA.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const spareImplementer = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);
  assert.equal(spareImplementer.ok, true);

  const taskA = serverA.callTool('team_task_create', {
    team_id: teamId,
    title: 'implement first',
    required_role: 'implementer',
    priority: 1
  });
  const taskB = serverA.callTool('team_task_create', {
    team_id: teamId,
    title: 'review later',
    required_role: 'reviewer',
    priority: 5
  });
  assert.equal(taskA.ok, true);
  assert.equal(taskB.ok, true);

  const schedulerA = createScheduler({
    server: serverA,
    tickIntervalMs: 25,
    readyTaskLimit: 50
  });
  schedulerA.start();

  await waitFor(() => {
    const a = serverA.store.getTask(taskA.task.task_id);
    const b = serverA.store.getTask(taskB.task.task_id);
    return a?.status === 'in_progress' && b?.status === 'in_progress';
  });

  const taskABeforeRestart = serverA.store.getTask(taskA.task.task_id);
  const taskBBeforeRestart = serverA.store.getTask(taskB.task.task_id);
  assert.equal(taskABeforeRestart?.status, 'in_progress');
  assert.equal(taskBBeforeRestart?.status, 'in_progress');
  assert.equal(Boolean(taskABeforeRestart?.claimed_by), true);
  assert.equal(Boolean(taskBBeforeRestart?.claimed_by), true);

  schedulerA.stop();
  serverA.store.close();

  const serverB = createServer({ dbPath, logPath: logPathB });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);
  registerTaskBoardTools(serverB);

  const schedulerB = createScheduler({
    server: serverB,
    tickIntervalMs: 25,
    readyTaskLimit: 50
  });
  schedulerB.start();

  const taskAAfterRestart = serverB.store.getTask(taskA.task.task_id);
  const taskBAfterRestart = serverB.store.getTask(taskB.task.task_id);
  assert.equal(taskAAfterRestart?.status, 'in_progress');
  assert.equal(taskBAfterRestart?.status, 'in_progress');
  assert.equal(taskAAfterRestart?.claimed_by, taskABeforeRestart?.claimed_by);
  assert.equal(taskBAfterRestart?.claimed_by, taskBBeforeRestart?.claimed_by);

  const taskC = serverB.callTool('team_task_create', {
    team_id: teamId,
    title: 'dispatch after restart',
    required_role: 'implementer',
    priority: 2
  });
  assert.equal(taskC.ok, true);

  await waitFor(() => serverB.store.getTask(taskC.task.task_id)?.status === 'in_progress');

  const taskCAfterDispatch = serverB.store.getTask(taskC.task.task_id);
  assert.equal(taskCAfterDispatch?.status, 'in_progress');
  assert.equal(taskCAfterDispatch?.claimed_by === taskABeforeRestart?.claimed_by, false);
  assert.equal(serverB.store.getTask(taskA.task.task_id)?.claimed_by, taskABeforeRestart?.claimed_by);
  assert.equal(serverB.store.getTask(taskB.task.task_id)?.claimed_by, taskBBeforeRestart?.claimed_by);

  schedulerB.stop();
  serverB.store.close();
});

test('V3-002 integration: heavy high-priority backlog does not starve lower role/priority bands', async () => {
  const server = createServer({ dbPath, logPath: logPathA });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-002 fairness backlog',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);

  const now = new Date().toISOString();
  for (let i = 0; i < 260; i += 1) {
    server.store.createTask({
      task_id: `task_v3_int_high_${i}`,
      team_id: teamId,
      title: `high-${i}`,
      required_role: 'implementer',
      status: 'todo',
      priority: 1,
      created_at: now,
      updated_at: now
    });
  }
  server.store.createTask({
    task_id: 'task_v3_int_low_reviewer',
    team_id: teamId,
    title: 'low reviewer',
    required_role: 'reviewer',
    status: 'todo',
    priority: 9,
    created_at: now,
    updated_at: now
  });

  const scheduler = createScheduler({
    server,
    tickIntervalMs: 20,
    readyTaskLimit: 5
  });
  scheduler.start();

  await waitFor(() => server.store.getTask('task_v3_int_low_reviewer')?.status === 'in_progress');
  const lowTask = server.store.getTask('task_v3_int_low_reviewer');
  assert.equal(lowTask?.claimed_by, reviewer.agent.agent_id);

  scheduler.stop();
  server.store.close();
});
