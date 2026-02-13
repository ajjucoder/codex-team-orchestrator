import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/v3-111-team-card-unit.sqlite';
const logPath = '.tmp/v3-111-team-card-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runCard(teamId: string, mode: 'launch' | 'progress' | 'timeout' | 'complete'): string {
  return execFileSync(
    'node',
    [
      '--import',
      'tsx',
      'scripts/team-card.ts',
      '--db',
      dbPath,
      '--team',
      teamId,
      '--mode',
      mode
    ],
    { encoding: 'utf8' }
  );
}

afterEach(cleanup);

test('V3-111 unit: team-card renders all modes with deterministic markdown sections', () => {
  cleanup();

  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'team card mode coverage',
      max_threads: 4
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const worker = server.callTool('team_spawn', {
      team_id: teamId,
      role: 'implementer'
    });
    assert.equal(worker.ok, true);
    const workerId = worker.agent.agent_id as string;
    const workerMeta = server.store.updateAgentMetadata(workerId, {
      specialist_handle: '@infra-dev',
      specialist_domain: 'infra'
    });
    assert.notEqual(workerMeta, null);

    const doneTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'done-task',
      priority: 1
    }).task;
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

    const activeTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'active-task',
      priority: 2
    }).task;
    const activeClaim = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: activeTask.task_id,
      agent_id: workerId,
      expected_lock_version: activeTask.lock_version
    });
    assert.equal(activeClaim.ok, true);

    const blockedBase = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-base',
      priority: 3
    }).task;
    const blockedTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-child',
      priority: 4,
      depends_on_task_ids: [blockedBase.task_id]
    }).task;
    assert.equal(blockedTask.status, 'blocked');

    const failedTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'failed-task',
      priority: 5
    }).task;
    const failedClaim = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: failedTask.task_id,
      agent_id: workerId,
      expected_lock_version: failedTask.lock_version
    });
    assert.equal(failedClaim.ok, true);
    const failedUpdate = server.callTool('team_task_update', {
      team_id: teamId,
      task_id: failedTask.task_id,
      status: 'failed_terminal',
      expected_lock_version: failedClaim.task.lock_version,
      quality_checks_passed: false,
      artifact_refs_count: 0
    });
    assert.equal(failedUpdate.ok, true);

    const launch = runCard(teamId, 'launch');
    const progressOne = runCard(teamId, 'progress');
    const progressTwo = runCard(teamId, 'progress');
    const timeout = runCard(teamId, 'timeout');
    const complete = runCard(teamId, 'complete');

    assert.match(launch, /^# Team Launch/m);
    assert.equal(launch.includes(`- Team: \`${teamId}\``), true);
    assert.match(launch, /## Worker Tree/);
    assert.match(launch, /## Initial Queue Spotlight/);

    assert.equal(progressOne, progressTwo);
    assert.match(progressOne, /^# Team Progress/m);
    assert.match(progressOne, /## Active Tasks/);
    assert.match(progressOne, /## Evidence Links/);
    assert.match(progressOne, /## Failure Highlights/);
    assert.match(progressOne, /@infra-dev/);
    assert.equal(progressOne.includes('wave source='), false);

    assert.match(timeout, /^# Team Timeout/m);
    assert.match(timeout, /## Blockers Requiring Operator Action/);
    assert.match(timeout, /## Operator Actions/);

    assert.match(complete, /^# Team Complete/m);
    assert.match(complete, /## Completion Evidence/);
    assert.match(complete, /## Residual Risk Signals/);
  } finally {
    server.store.close();
  }
});
