import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-004-wave-telemetry-int.sqlite';
const logPathA = '.tmp/v4-004-wave-telemetry-int-a.log';
const logPathB = '.tmp/v4-004-wave-telemetry-int-b.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

afterEach(cleanup);

test('V4-004 integration: team_ui_state exposes persisted wave metrics across server instances', () => {
  cleanup();

  const serverA = createServer({ dbPath, logPath: logPathA });
  let teamId = '';

  try {
    serverA.start();
    registerTeamLifecycleTools(serverA);
    registerTaskBoardTools(serverA);
    registerAgentLifecycleTools(serverA);
    registerObservabilityTools(serverA);

    const started = serverA.callTool('team_start', {
      objective: 'wave telemetry cross-process',
      max_threads: 3
    });
    assert.equal(started.ok, true);
    teamId = String(started.team.team_id);

    const spawned = serverA.callTool('team_spawn', {
      team_id: teamId,
      role: 'implementer'
    });
    assert.equal(spawned.ok, true);

    const created = serverA.callTool('team_task_create', {
      team_id: teamId,
      title: 'execute and persist wave metrics',
      priority: 1,
      required_role: 'implementer'
    });
    assert.equal(created.ok, true);
    const taskId = String(created.task.task_id);

    const scheduler = createScheduler({
      store: serverA.store,
      tickIntervalMs: 25,
      readyTaskLimit: 50
    });
    const dispatchTick = scheduler.tick();
    assert.equal(dispatchTick.dispatched_count, 1);

    const inFlight = serverA.store.getTask(taskId);
    assert.notEqual(inFlight, null);
    assert.equal(inFlight?.status, 'in_progress');

    const doneUpdate = serverA.callTool('team_task_update', {
      team_id: teamId,
      task_id: taskId,
      status: 'done',
      expected_lock_version: Number(inFlight?.lock_version ?? 0),
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
    assert.equal(doneUpdate.ok, true);

    const settleTick = scheduler.tick();
    assert.equal(settleTick.dispatched_count, 0);

    const persistedWave = serverA.store.getTeamWaveState(teamId);
    assert.notEqual(persistedWave, null);
    assert.equal(persistedWave?.done_tasks, 1);
    assert.equal(persistedWave?.total_tasks, 1);
    assert.equal(persistedWave?.completion_pct, 100);
    assert.equal(Number(persistedWave?.wave_id ?? 0) >= 1, true);
    assert.equal(Number(persistedWave?.dispatched_total ?? 0) >= 1, true);
  } finally {
    serverA.store.close();
  }

  const serverB = createServer({ dbPath, logPath: logPathB });
  try {
    serverB.start();
    registerObservabilityTools(serverB);

    const uiState = serverB.callTool('team_ui_state', { team_id: teamId });
    assert.equal(uiState.ok, true);

    const progress = asRecord(uiState.progress);
    const wave = asRecord(progress.wave);
    assert.equal(String(wave.source), 'persisted');
    assert.equal(Number(wave.wave_id) >= 1, true);
    assert.equal(Number(wave.dispatched_total) >= 1, true);
    assert.equal(Number(wave.done_tasks), 1);
    assert.equal(Number(wave.total_tasks), 1);
    assert.equal(Number(wave.completion_pct), 100);
  } finally {
    serverB.store.close();
  }
});
