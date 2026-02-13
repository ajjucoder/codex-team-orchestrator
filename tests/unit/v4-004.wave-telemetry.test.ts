import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RuntimeScheduler } from '../../mcp/runtime/scheduler.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v4-004-wave-telemetry-unit.sqlite';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

afterEach(cleanup);

test('V4-004 unit: scheduler persists wave telemetry with completion progress tied to task state', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  const teamId = 'team_v4_004_wave';
  store.createTeam({
    team_id: teamId,
    status: 'active',
    profile: 'default',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_004_impl',
    team_id: teamId,
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_004_wave_1',
    team_id: teamId,
    title: 'wave telemetry task',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50
  });

  const firstTick = scheduler.tick();
  assert.equal(firstTick.dispatched_count, 1);

  const waveAfterDispatch = store.getTeamWaveState(teamId);
  assert.notEqual(waveAfterDispatch, null);
  assert.equal(waveAfterDispatch?.wave_id, 1);
  assert.equal(waveAfterDispatch?.tick_count, 1);
  assert.equal(waveAfterDispatch?.dispatched_count, 1);
  assert.equal(waveAfterDispatch?.dispatched_total, 1);
  assert.equal(waveAfterDispatch?.done_tasks, 0);
  assert.equal(waveAfterDispatch?.total_tasks, 1);
  assert.equal(waveAfterDispatch?.completion_pct, 0);
  const firstWaveId = Number(waveAfterDispatch?.wave_id ?? 0);

  const inFlight = store.getTask('task_v4_004_wave_1');
  assert.notEqual(inFlight, null);
  assert.equal(inFlight?.status, 'in_progress');
  const markDone = store.updateTask({
    team_id: teamId,
    task_id: 'task_v4_004_wave_1',
    expected_lock_version: Number(inFlight?.lock_version ?? 0),
    patch: {
      status: 'done'
    }
  });
  assert.equal(markDone.ok, true);
  store.updateAgentStatus('agent_v4_004_impl', 'idle');

  const secondTick = scheduler.tick();
  assert.equal(secondTick.dispatched_count, 0);

  const waveAfterDone = store.getTeamWaveState(teamId);
  assert.notEqual(waveAfterDone, null);
  assert.equal(Number(waveAfterDone?.wave_id ?? 0) >= firstWaveId, true);
  assert.equal(waveAfterDone?.tick_count, 2);
  assert.equal(waveAfterDone?.done_tasks, 1);
  assert.equal(waveAfterDone?.total_tasks, 1);
  assert.equal(waveAfterDone?.completion_pct, 100);

  store.close();
});

test('V4-004 unit: persisted wave telemetry survives store reopen for cross-process reads', () => {
  cleanup();
  const now = new Date().toISOString();
  const teamId = 'team_v4_004_restart';

  const firstStore = new SqliteStore(dbPath);
  firstStore.migrate();
  firstStore.createTeam({
    team_id: teamId,
    status: 'active',
    profile: 'default',
    max_threads: 1,
    created_at: now,
    updated_at: now
  });
  firstStore.createAgent({
    agent_id: 'agent_v4_004_restart',
    team_id: teamId,
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  firstStore.createTask({
    task_id: 'task_v4_004_restart',
    team_id: teamId,
    title: 'persist wave',
    status: 'todo',
    priority: 1,
    created_at: now,
    updated_at: now
  });

  const scheduler = new RuntimeScheduler({
    store: firstStore,
    tickIntervalMs: 25,
    readyTaskLimit: 50
  });
  const tick = scheduler.tick();
  assert.equal(tick.dispatched_count, 1);

  const beforeClose = firstStore.getTeamWaveState(teamId);
  assert.notEqual(beforeClose, null);
  firstStore.close();

  const secondStore = new SqliteStore(dbPath);
  secondStore.migrate();
  const afterReopen = secondStore.getTeamWaveState(teamId);
  assert.notEqual(afterReopen, null);
  assert.equal(afterReopen?.team_id, teamId);
  assert.equal(afterReopen?.wave_id, beforeClose?.wave_id);
  assert.equal(afterReopen?.dispatched_total, beforeClose?.dispatched_total);
  assert.equal(afterReopen?.tick_count, beforeClose?.tick_count);
  secondStore.close();
});
