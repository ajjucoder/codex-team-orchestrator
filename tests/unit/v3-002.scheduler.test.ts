import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { TaskRecord } from '../../mcp/store/entities.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';
import { createFairTaskQueue } from '../../mcp/runtime/queue.js';
import { RuntimeScheduler } from '../../mcp/runtime/scheduler.js';

const dbPath = '.tmp/v3-002-unit.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

function makeTask(taskId: string, priority: number, requiredRole: string | null, createdAt: string): TaskRecord {
  return {
    task_id: taskId,
    team_id: 'team_v3_queue',
    title: taskId,
    description: '',
    required_role: requiredRole,
    status: 'todo',
    priority,
    claimed_by: null,
    lease_owner_agent_id: null,
    lease_expires_at: null,
    lock_version: 0,
    created_at: createdAt,
    updated_at: createdAt
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1200): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail('timed out waiting for condition');
}

test('V3-002 fair queue prevents starvation across role/priority buckets', () => {
  const tasks = [
    makeTask('p1_impl_1', 1, 'implementer', '2026-01-01T00:00:00.001Z'),
    makeTask('p1_impl_2', 1, 'implementer', '2026-01-01T00:00:00.002Z'),
    makeTask('p1_impl_3', 1, 'implementer', '2026-01-01T00:00:00.003Z'),
    makeTask('p3_reviewer_1', 3, 'reviewer', '2026-01-01T00:00:00.004Z'),
    makeTask('p3_reviewer_2', 3, 'reviewer', '2026-01-01T00:00:00.005Z')
  ];
  const queue = createFairTaskQueue(tasks, 0);

  const picked: string[] = [];
  while (queue.remaining() > 0) {
    const next = queue.takeAny();
    if (!next) break;
    picked.push(next.task_id);
  }

  assert.deepEqual(picked, [
    'p1_impl_1',
    'p3_reviewer_1',
    'p1_impl_2',
    'p3_reviewer_2',
    'p1_impl_3'
  ]);
});

test('V3-002 scheduler tick is deterministic and stop/restart preserves in-flight ownership', async () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v3_sched',
    status: 'active',
    profile: 'default',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_impl_a',
    team_id: 'team_v3_sched',
    role: 'implementer',
    status: 'idle',
    created_at: '2026-01-01T00:00:00.001Z',
    updated_at: '2026-01-01T00:00:00.001Z'
  });
  store.createAgent({
    agent_id: 'agent_impl_b',
    team_id: 'team_v3_sched',
    role: 'implementer',
    status: 'idle',
    created_at: '2026-01-01T00:00:00.002Z',
    updated_at: '2026-01-01T00:00:00.002Z'
  });
  store.createTask({
    task_id: 'task_inflight',
    team_id: 'team_v3_sched',
    title: 'keep ownership',
    required_role: 'implementer',
    status: 'todo',
    priority: 1,
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
  assert.equal(store.getTask('task_inflight')?.status, 'in_progress');
  const inflightOwner = store.getTask('task_inflight')?.claimed_by;
  assert.equal(inflightOwner, 'agent_impl_a');

  scheduler.start();
  scheduler.stop();

  store.createTask({
    task_id: 'task_after_stop',
    team_id: 'team_v3_sched',
    title: 'dispatch after restart only',
    required_role: 'implementer',
    status: 'todo',
    priority: 2,
    created_at: now,
    updated_at: now
  });

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(store.getTask('task_after_stop')?.status, 'todo');

  scheduler.start();
  await waitFor(() => store.getTask('task_after_stop')?.status === 'in_progress');
  scheduler.stop();

  assert.equal(store.getTask('task_after_stop')?.claimed_by, 'agent_impl_b');
  assert.equal(store.getTask('task_inflight')?.claimed_by, inflightOwner);
  assert.equal(store.getTask('task_inflight')?.status, 'in_progress');

  store.close();
});

test('V3-002 scheduler fairness dispatches lower-priority band despite heavy high-priority backlog', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v3_fairness',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_fair_impl',
    team_id: 'team_v3_fairness',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_fair_review',
    team_id: 'team_v3_fairness',
    role: 'reviewer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });

  for (let i = 0; i < 260; i += 1) {
    store.createTask({
      task_id: `task_fair_high_${i}`,
      team_id: 'team_v3_fairness',
      title: `high ${i}`,
      required_role: 'implementer',
      status: 'todo',
      priority: 1,
      created_at: now,
      updated_at: now
    });
  }
  store.createTask({
    task_id: 'task_fair_low_reviewer',
    team_id: 'team_v3_fairness',
    title: 'low reviewer',
    required_role: 'reviewer',
    status: 'todo',
    priority: 9,
    created_at: now,
    updated_at: now
  });

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 5
  });
  const tick = scheduler.tick();

  assert.equal(tick.dispatched_count, 2);
  const lowBand = store.getTask('task_fair_low_reviewer');
  assert.equal(lowBand?.status, 'in_progress');
  assert.equal(lowBand?.claimed_by, 'agent_fair_review');

  store.close();
});

test('V3-002 scheduler reserves idle agents before claim and skips stale-idle snapshots', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v3_reserve',
    status: 'active',
    profile: 'default',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_reserve_impl',
    team_id: 'team_v3_reserve',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_reserve_only',
    team_id: 'team_v3_reserve',
    title: 'reservation guard',
    required_role: 'implementer',
    status: 'todo',
    priority: 1,
    created_at: now,
    updated_at: now
  });

  const originalListAgentsByTeam = store.listAgentsByTeam.bind(store);
  (store as unknown as { listAgentsByTeam: typeof store.listAgentsByTeam }).listAgentsByTeam = ((teamId: string) => {
    const snapshot = originalListAgentsByTeam(teamId).map((agent) => ({
      ...agent,
      status: 'idle' as const
    }));
    store.updateAgentStatus('agent_reserve_impl', 'busy');
    return snapshot;
  }) as typeof store.listAgentsByTeam;

  const scheduler = new RuntimeScheduler({
    store,
    tickIntervalMs: 25,
    readyTaskLimit: 20
  });
  const tick = scheduler.tick();

  assert.equal(tick.dispatched_count, 0);
  assert.equal(store.getTask('task_reserve_only')?.status, 'todo');
  assert.equal(store.getTask('task_reserve_only')?.claimed_by, null);
  assert.equal(store.getAgent('agent_reserve_impl')?.status, 'busy');

  store.close();
});
