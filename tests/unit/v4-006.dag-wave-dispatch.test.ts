import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RuntimeScheduler } from '../../mcp/runtime/scheduler.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';
import type { TeamRecord } from '../../mcp/store/entities.js';

const dbPath = '.tmp/v4-006-dag-wave-dispatch-unit.sqlite';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function policyForTeam(team: TeamRecord): Record<string, unknown> {
  return {
    scheduler: {
      wave_dispatch: {
        enabled: team.profile === 'deep'
      }
    }
  };
}

afterEach(cleanup);

test('V4-006 unit: wave dispatch can be enabled by profile and dispatches only the minimum ready wave', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_006_wave',
    status: 'active',
    profile: 'deep',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_006_wave',
    team_id: 'team_v4_006_wave',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });

  store.createTask({
    task_id: 'task_dep_done',
    team_id: 'team_v4_006_wave',
    title: 'dependency done',
    status: 'done',
    priority: 5,
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_wave_0',
    team_id: 'team_v4_006_wave',
    title: 'wave zero',
    status: 'todo',
    priority: 3,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_wave_1',
    team_id: 'team_v4_006_wave',
    title: 'wave one',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.setTaskDependencies({
    team_id: 'team_v4_006_wave',
    task_id: 'task_wave_1',
    depends_on_task_ids: ['task_dep_done']
  });
  store.refreshAllTaskReadiness('team_v4_006_wave');

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    resolveTeamPolicy: policyForTeam
  });

  const firstTick = scheduler.tick();
  assert.equal(firstTick.dispatched_count, 1);
  assert.equal(store.getTask('task_wave_0')?.status, 'in_progress');
  assert.equal(store.getTask('task_wave_1')?.status, 'todo');

  const firstWaveState = store.getTeamWaveState('team_v4_006_wave');
  const firstMetadata = (firstWaveState?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(firstMetadata.wave_dispatch_enabled, true);
  assert.equal(firstMetadata.dispatch_mode, 'wave_dispatch');
  assert.equal(firstMetadata.selected_wave, 0);

  const wave0Task = store.getTask('task_wave_0');
  assert.notEqual(wave0Task, null);
  const done = store.updateTask({
    team_id: 'team_v4_006_wave',
    task_id: 'task_wave_0',
    expected_lock_version: Number(wave0Task?.lock_version ?? 0),
    patch: { status: 'done' }
  });
  assert.equal(done.ok, true);
  store.updateAgentStatus('agent_v4_006_wave', 'idle');

  const secondTick = scheduler.tick();
  assert.equal(secondTick.dispatched_count, 1);
  assert.equal(store.getTask('task_wave_1')?.status, 'in_progress');

  store.close();
});

test('V4-006 unit: cycle detection triggers fair-queue fallback instead of stalling dispatch', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_006_cycle',
    status: 'active',
    profile: 'deep',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_006_cycle',
    team_id: 'team_v4_006_cycle',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });

  store.createTask({
    task_id: 'task_cycle_a',
    team_id: 'team_v4_006_cycle',
    title: 'cycle a',
    status: 'todo',
    priority: 3,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_cycle_b',
    team_id: 'team_v4_006_cycle',
    title: 'cycle b',
    status: 'todo',
    priority: 4,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_ready_c',
    team_id: 'team_v4_006_cycle',
    title: 'ready task',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.setTaskDependencies({
    team_id: 'team_v4_006_cycle',
    task_id: 'task_cycle_a',
    depends_on_task_ids: ['task_cycle_b']
  });
  store.setTaskDependencies({
    team_id: 'team_v4_006_cycle',
    task_id: 'task_cycle_b',
    depends_on_task_ids: ['task_cycle_a']
  });
  store.refreshAllTaskReadiness('team_v4_006_cycle');

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    resolveTeamPolicy: policyForTeam
  });

  const tick = scheduler.tick();
  assert.equal(tick.dispatched_count, 1);
  assert.equal(store.getTask('task_ready_c')?.status, 'in_progress');

  const events = store.listEvents('team_v4_006_cycle', 50);
  assert.equal(
    events.some((event) => String(event.event_type ?? '') === 'scheduler_wave_dispatch_fallback'),
    true
  );

  const waveState = store.getTeamWaveState('team_v4_006_cycle');
  const metadata = (waveState?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.dispatch_mode, 'wave_dispatch_fallback');

  store.close();
});

test('V4-006 unit: wave dispatch disabled profile keeps fair queue mode', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_006_disabled',
    status: 'active',
    profile: 'default',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_006_disabled',
    team_id: 'team_v4_006_disabled',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_006_disabled',
    team_id: 'team_v4_006_disabled',
    title: 'fair queue task',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    resolveTeamPolicy: policyForTeam
  });
  const tick = scheduler.tick();
  assert.equal(tick.dispatched_count, 1);

  const waveState = store.getTeamWaveState('team_v4_006_disabled');
  const metadata = (waveState?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.wave_dispatch_enabled, false);
  assert.equal(metadata.dispatch_mode, 'fair_queue');

  store.close();
});
