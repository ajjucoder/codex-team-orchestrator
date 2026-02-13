import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-006-dag-wave-dispatch-int.sqlite';
const logPath = '.tmp/v4-006-dag-wave-dispatch-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-006 integration: profile flag enables DAG wave dispatch and default profile falls back to fair queue', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });

  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const deepTeam = server.callTool('team_start', {
      objective: 'wave-dispatch deep team',
      profile: 'deep',
      max_threads: 3
    });
    assert.equal(deepTeam.ok, true);
    const deepTeamId = String(deepTeam.team.team_id);

    const deepWorker = server.callTool('team_spawn', {
      team_id: deepTeamId,
      role: 'implementer'
    });
    assert.equal(deepWorker.ok, true);
    const deepWorkerId = String(deepWorker.agent.agent_id);

    const depDone = server.callTool('team_task_create', {
      team_id: deepTeamId,
      title: 'dep done',
      priority: 5,
      required_role: 'implementer'
    });
    assert.equal(depDone.ok, true);
    const depClaim = server.callTool('team_task_claim', {
      team_id: deepTeamId,
      task_id: String(depDone.task.task_id),
      agent_id: deepWorkerId,
      expected_lock_version: Number(depDone.task.lock_version)
    });
    assert.equal(depClaim.ok, true);
    const depFinish = server.callTool('team_task_update', {
      team_id: deepTeamId,
      task_id: String(depDone.task.task_id),
      status: 'done',
      expected_lock_version: Number(depClaim.task.lock_version),
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
    assert.equal(depFinish.ok, true);

    const wave1 = server.callTool('team_task_create', {
      team_id: deepTeamId,
      title: 'wave one task',
      priority: 1,
      required_role: 'implementer',
      depends_on_task_ids: [String(depDone.task.task_id)]
    });
    assert.equal(wave1.ok, true);
    const wave0 = server.callTool('team_task_create', {
      team_id: deepTeamId,
      title: 'wave zero task',
      priority: 3,
      required_role: 'implementer'
    });
    assert.equal(wave0.ok, true);

    const scheduler = createScheduler({
      server,
      tickIntervalMs: 25,
      readyTaskLimit: 100
    });

    const deepTick = scheduler.tick();
    assert.equal(deepTick.dispatched_count, 1);
    assert.equal(server.store.getTask(String(wave0.task.task_id))?.status, 'in_progress');
    assert.equal(server.store.getTask(String(wave1.task.task_id))?.status, 'todo');
    const deepWaveState = server.store.getTeamWaveState(deepTeamId);
    const deepMetadata = (deepWaveState?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(deepMetadata.dispatch_mode, 'wave_dispatch');

    const claimedWave0 = server.store.getTask(String(wave0.task.task_id));
    assert.notEqual(claimedWave0, null);
    const wave0Done = server.callTool('team_task_update', {
      team_id: deepTeamId,
      task_id: String(wave0.task.task_id),
      status: 'done',
      expected_lock_version: Number(claimedWave0?.lock_version ?? 0),
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
    assert.equal(wave0Done.ok, true);
    server.store.updateAgentStatus(deepWorkerId, 'idle');

    const deepTickTwo = scheduler.tick();
    assert.equal(deepTickTwo.dispatched_count, 1);
    assert.equal(server.store.getTask(String(wave1.task.task_id))?.status, 'in_progress');

    const defaultTeam = server.callTool('team_start', {
      objective: 'fair-queue default team',
      profile: 'default',
      max_threads: 2
    });
    assert.equal(defaultTeam.ok, true);
    const defaultTeamId = String(defaultTeam.team.team_id);
    const defaultWorker = server.callTool('team_spawn', {
      team_id: defaultTeamId,
      role: 'implementer'
    });
    assert.equal(defaultWorker.ok, true);

    const defaultTask = server.callTool('team_task_create', {
      team_id: defaultTeamId,
      title: 'default task',
      priority: 1,
      required_role: 'implementer'
    });
    assert.equal(defaultTask.ok, true);

    const defaultTick = scheduler.tick();
    assert.equal(defaultTick.dispatched_count >= 1, true);
    const defaultWaveState = server.store.getTeamWaveState(defaultTeamId);
    const defaultMetadata = (defaultWaveState?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(defaultMetadata.wave_dispatch_enabled, false);
    assert.equal(defaultMetadata.dispatch_mode, 'fair_queue');
  } finally {
    server.store.close();
  }
});
