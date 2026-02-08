import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v2-011-unit.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('V2-011 store orphan recovery is deterministic and idempotent', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_recover_unit',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_recover_a',
    team_id: 'team_recover_unit',
    role: 'implementer',
    status: 'busy',
    created_at: now
  });
  store.createTask({
    task_id: 'task_recover_a',
    team_id: 'team_recover_unit',
    title: 'recover me',
    status: 'in_progress',
    priority: 1,
    claimed_by: 'agent_recover_a',
    lease_owner_agent_id: 'agent_recover_a',
    lease_expires_at: '2000-01-01T00:00:00.000Z',
    created_at: now,
    updated_at: now
  });

  const first = store.recoverExpiredTaskLeases('team_recover_unit', new Date().toISOString());
  assert.equal(first.recovered, 1);
  assert.equal(first.tasks[0].status, 'todo');
  assert.equal(first.tasks[0].lease_owner_agent_id, null);
  assert.equal(first.tasks[0].lease_expires_at, null);

  const second = store.recoverExpiredTaskLeases('team_recover_unit', new Date().toISOString());
  assert.equal(second.recovered, 0);

  const stale = store.markStaleAgentsOffline('team_recover_unit', new Date().toISOString());
  assert.equal(stale.marked_offline, 1);
  assert.equal(stale.agents[0].status, 'offline');

  const staleAgain = store.markStaleAgentsOffline('team_recover_unit', new Date().toISOString());
  assert.equal(staleAgain.marked_offline, 0);

  store.close();
});
