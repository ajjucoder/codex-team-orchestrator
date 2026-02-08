import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v2-010-unit.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('V2-010 store lease lifecycle supports contention, expiry recovery, renew, and release', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_lease_unit',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_lease_a',
    team_id: 'team_lease_unit',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_lease_b',
    team_id: 'team_lease_unit',
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_lease_unit',
    team_id: 'team_lease_unit',
    title: 'lease task',
    status: 'todo',
    priority: 1,
    created_at: now,
    updated_at: now
  });

  const claimed = store.claimTask({
    team_id: 'team_lease_unit',
    task_id: 'task_lease_unit',
    agent_id: 'agent_lease_a',
    expected_lock_version: 0
  });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.task?.lease_owner_agent_id, 'agent_lease_a');
  assert.ok(claimed.task?.lease_expires_at);

  const acquireDenied = store.acquireTaskLease({
    team_id: 'team_lease_unit',
    task_id: 'task_lease_unit',
    agent_id: 'agent_lease_b'
  });
  assert.equal(acquireDenied.ok, false);
  assert.match(String(acquireDenied.error ?? ''), /currently held/);

  store.db
    .prepare('UPDATE tasks SET lease_expires_at = ? WHERE team_id = ? AND task_id = ?')
    .run('2000-01-01T00:00:00.000Z', 'team_lease_unit', 'task_lease_unit');

  const acquireRecovered = store.acquireTaskLease({
    team_id: 'team_lease_unit',
    task_id: 'task_lease_unit',
    agent_id: 'agent_lease_b'
  });
  assert.equal(acquireRecovered.ok, true);
  assert.equal(acquireRecovered.task?.lease_owner_agent_id, 'agent_lease_b');

  const renewed = store.renewTaskLease({
    team_id: 'team_lease_unit',
    task_id: 'task_lease_unit',
    agent_id: 'agent_lease_b',
    lease_ms: 5000
  });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.task?.lease_owner_agent_id, 'agent_lease_b');

  const released = store.releaseTaskLease({
    team_id: 'team_lease_unit',
    task_id: 'task_lease_unit',
    agent_id: 'agent_lease_b'
  });
  assert.equal(released.ok, true);
  assert.equal(released.task?.lease_owner_agent_id, null);
  assert.equal(released.task?.lease_expires_at, null);

  const heartbeat = store.heartbeatAgent('agent_lease_a');
  assert.ok(heartbeat?.last_heartbeat_at);

  store.close();
});
