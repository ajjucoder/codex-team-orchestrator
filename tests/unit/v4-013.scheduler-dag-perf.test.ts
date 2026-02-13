import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RuntimeScheduler } from '../../mcp/runtime/scheduler.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';
import type { TeamRecord } from '../../mcp/store/entities.js';

const dbPath = '.tmp/v4-013-scheduler-dag-perf-unit.sqlite';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function policyForTeam(team: TeamRecord): Record<string, unknown> {
  return {
    scheduler: {
      wave_dispatch: {
        enabled: team.profile === 'deep',
        perf_guard: {
          max_dag_compute_ms: 999,
          max_dag_tasks: 999,
          max_dag_edges: 999
        }
      }
    }
  };
}

afterEach(cleanup);

test('V4-013 unit: scheduler reuses cached DAG analysis when graph shape is unchanged', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_013_cache',
    status: 'active',
    profile: 'deep',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_013_cache',
    team_id: 'team_v4_013_cache',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_013_root',
    team_id: 'team_v4_013_cache',
    title: 'root',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_013_child',
    team_id: 'team_v4_013_cache',
    title: 'child',
    status: 'todo',
    priority: 2,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.setTaskDependencies({
    team_id: 'team_v4_013_cache',
    task_id: 'task_v4_013_child',
    depends_on_task_ids: ['task_v4_013_root']
  });
  store.refreshAllTaskReadiness('team_v4_013_cache');

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    resolveTeamPolicy: policyForTeam
  });

  const firstTick = scheduler.tick();
  assert.equal(firstTick.dispatched_count, 1);
  const firstWave = store.getTeamWaveState('team_v4_013_cache');
  const firstMetadata = (firstWave?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(firstMetadata.wave_dispatch_enabled, true);
  assert.equal(firstMetadata.dag_recomputed, true);
  assert.equal(firstMetadata.dag_cache_hit, false);

  const secondTick = scheduler.tick();
  assert.equal(secondTick.dispatched_count, 0);
  const secondWave = store.getTeamWaveState('team_v4_013_cache');
  const secondMetadata = (secondWave?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(secondMetadata.wave_dispatch_enabled, true);
  assert.equal(secondMetadata.dag_recomputed, false);
  assert.equal(secondMetadata.dag_cache_hit, true);

  store.close();
});

test('V4-013 unit: scheduler emits deterministic DAG perf-guard metrics when thresholds are exceeded', () => {
  cleanup();
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v4_013_guard',
    status: 'active',
    profile: 'deep',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_v4_013_guard',
    team_id: 'team_v4_013_guard',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_013_guard_a',
    team_id: 'team_v4_013_guard',
    title: 'A',
    status: 'todo',
    priority: 1,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v4_013_guard_b',
    team_id: 'team_v4_013_guard',
    title: 'B',
    status: 'todo',
    priority: 2,
    required_role: 'implementer',
    created_at: now,
    updated_at: now
  });
  store.refreshAllTaskReadiness('team_v4_013_guard');

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    resolveTeamPolicy: () => ({
      scheduler: {
        wave_dispatch: {
          enabled: true,
          perf_guard: {
            max_dag_compute_ms: 999,
            max_dag_tasks: 1,
            max_dag_edges: 999
          }
        }
      }
    })
  });

  const tick = scheduler.tick();
  assert.equal(tick.dispatched_count, 1);

  const events = store.listEvents('team_v4_013_guard', 50);
  const guardEvent = events.find((event) => event.event_type === 'scheduler_wave_dispatch_perf_guard');
  assert.notEqual(guardEvent, undefined);
  const guardPayload = (guardEvent?.payload ?? {}) as Record<string, unknown>;
  assert.equal(guardPayload.max_dag_tasks, 1);
  assert.equal(Number(guardPayload.dag_task_count ?? 0) >= 2, true);

  const waveState = store.getTeamWaveState('team_v4_013_guard');
  const metadata = (waveState?.metadata ?? {}) as Record<string, unknown>;
  const perfGuard = (metadata.dag_perf_guard ?? {}) as Record<string, unknown>;
  assert.equal(perfGuard.triggered, true);
  assert.equal(perfGuard.max_dag_tasks, 1);
  assert.equal(metadata.dag_recomputed, true);

  store.close();
});
