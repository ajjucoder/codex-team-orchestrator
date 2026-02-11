import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/v3-101-console.sqlite';
const logPath = '.tmp/v3-101-console.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

beforeEach(cleanup);
afterEach(cleanup);

test('V3-101 integration: team console shows telemetry, evidence links, and operator commands', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTaskBoardTools(server);
  registerAgentLifecycleTools(server);
  registerObservabilityTools(server);

  const started = server.callTool('team_start', { objective: 'console verification', max_threads: 4 });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(worker.ok, true);
  const workerId = worker.agent.agent_id as string;

  const doneTask = server.callTool('team_task_create', { team_id: teamId, title: 'done-task', priority: 1 }).task;
  const doneClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: doneTask.task_id,
    agent_id: workerId,
    expected_lock_version: doneTask.lock_version
  });
  assert.equal(doneClaim.ok, true);
  const doneUpdate = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: doneTask.task_id,
    status: 'done',
    expected_lock_version: doneClaim.task.lock_version,
    quality_checks_passed: true,
    artifact_refs_count: 1
  });
  assert.equal(doneUpdate.ok, true);

  const blocker = server.callTool('team_task_create', { team_id: teamId, title: 'blocker', priority: 2 }).task;
  const blocked = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'blocked',
    priority: 3,
    depends_on_task_ids: [blocker.task_id]
  }).task;
  assert.equal(blocked.status, 'blocked');

  const snapshotOutput = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/team-console.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--once'
  ], { encoding: 'utf8' });
  assert.match(snapshotOutput, /console:workers/);
  assert.match(snapshotOutput, /console:tasks/);
  assert.match(snapshotOutput, new RegExp(`console:evidence task=${doneTask.task_id} link=replay://${teamId}/event/`));

  const drainOutput = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/team-console.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--command',
    'drain',
    '--once'
  ], { encoding: 'utf8' });
  assert.match(drainOutput, /console:command=drain/);
  assert.match(drainOutput, /console:drained=2/);

  const blockedRetryBase = server.callTool('team_task_create', { team_id: teamId, title: 'retry-base', priority: 4 }).task;
  const blockedRetryTarget = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'retry-target',
    priority: 5,
    depends_on_task_ids: [blockedRetryBase.task_id]
  }).task;
  assert.equal(blockedRetryTarget.status, 'blocked');

  const retryOutput = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/team-console.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--command',
    'retry',
    '--task',
    blockedRetryTarget.task_id,
    '--once'
  ], { encoding: 'utf8' });
  assert.match(retryOutput, /console:command=retry/);
  assert.match(retryOutput, /console:retried=1/);

  const pauseOutput = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/team-console.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--command',
    'pause',
    '--once'
  ], { encoding: 'utf8' });
  assert.match(pauseOutput, /console:command=pause/);

  const resumedOutput = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/team-console.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--command',
    'resume',
    '--once'
  ], { encoding: 'utf8' });
  assert.match(resumedOutput, /console:command=resume/);
  assert.match(resumedOutput, /console:ok/);

  server.store.close();
});
