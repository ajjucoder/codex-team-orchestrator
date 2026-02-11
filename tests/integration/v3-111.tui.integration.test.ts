import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/v3-111-tui-int.sqlite';
const logPath = '.tmp/v3-111-tui-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runTui(teamId: string, extraArgs: string[] = []): string {
  return execFileSync(
    'node',
    [
      '--import',
      'tsx',
      'scripts/team-tui.ts',
      '--db',
      dbPath,
      '--team',
      teamId,
      '--once',
      '--no-input',
      ...extraArgs
    ],
    { encoding: 'utf8' }
  );
}

function countByStatus(server: ReturnType<typeof createServer>, teamId: string, status: string): number {
  const listed = server.callTool('team_task_list', { team_id: teamId, status });
  if (listed.ok !== true || !Array.isArray(listed.tasks)) return 0;
  return listed.tasks.length;
}

afterEach(cleanup);

test('V3-111 integration: team-tui command path and status output are deterministic', () => {
  cleanup();

  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'team tui integration',
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

    const todoTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'todo-task',
      priority: 2
    }).task;
    assert.equal(todoTask.status, 'todo');

    const blockedBase = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-base',
      priority: 3
    }).task;
    const blockedTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-task',
      priority: 4,
      depends_on_task_ids: [blockedBase.task_id]
    }).task;
    assert.equal(blockedTask.status, 'blocked');

    const statusOutput = runTui(teamId, ['--command', 'none']);
    assert.match(statusOutput, new RegExp(`team-tui team=${teamId} status=active`));
    assert.match(statusOutput, /controls: p=pause r=resume d=drain t=retry q=quit/);
    assert.match(statusOutput, /workers total=\d+ idle=\d+ busy=\d+ offline=\d+ util=\d+%/);
    assert.match(statusOutput, /tasks running=\d+ todo=\d+ blocked=\d+ done=\d+ failed=\d+ cancelled=\d+ total=\d+/);
    assert.match(statusOutput, /worker-tree:/);
    assert.match(statusOutput, /@infra-dev/);
    assert.match(statusOutput, /recent-feed:/);
    assert.match(statusOutput, /team-tui:ok/);

    const drainOutput = runTui(teamId, ['--command', 'drain']);
    assert.match(drainOutput, /team-tui:command=drain/);
    assert.match(drainOutput, /team-tui:drained=3/);
    assert.equal(countByStatus(server, teamId, 'cancelled'), 3);

    const retryBaseCreated = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'retry-base',
      priority: 5
    });
    assert.equal(retryBaseCreated.ok, true);
    const retryBase = retryBaseCreated.task as { task_id: string };

    const retryTargetCreated = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'retry-target',
      priority: 5,
      depends_on_task_ids: [retryBase.task_id]
    });
    assert.equal(retryTargetCreated.ok, true);
    const retryTarget = retryTargetCreated.task as { task_id: string; status: string };
    assert.equal(retryTarget.status, 'blocked');
    const retryBefore = server.store.getTask(retryTarget.task_id);
    assert.notEqual(retryBefore, null);
    const retryBeforeVersion = Number(retryBefore?.lock_version ?? 0);

    const retryOutput = runTui(teamId, ['--command', 'retry', '--task', String(retryTarget.task_id)]);
    assert.match(retryOutput, /team-tui:command=retry/);
    assert.match(retryOutput, /team-tui:retried=1/);
    const retryAfter = server.store.getTask(retryTarget.task_id);
    assert.notEqual(retryAfter, null);
    assert.equal(Number(retryAfter?.lock_version ?? 0) > retryBeforeVersion, true);

    const pauseOutput = runTui(teamId, ['--command', 'pause']);
    assert.match(pauseOutput, /team-tui:command=pause/);
    const pausedStatus = server.callTool('team_status', { team_id: teamId });
    assert.equal(pausedStatus.ok, true);
    assert.equal(pausedStatus.team.status, 'finalized');

    const resumeOutput = runTui(teamId, ['--command', 'resume']);
    assert.match(resumeOutput, /team-tui:command=resume/);
    const resumedStatus = server.callTool('team_status', { team_id: teamId });
    assert.equal(resumedStatus.ok, true);
    assert.equal(resumedStatus.team.status, 'active');
  } finally {
    server.store.close();
  }
});
