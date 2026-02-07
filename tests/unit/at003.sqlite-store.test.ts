import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { SqliteStore, withRetry } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/at003-unit.sqlite';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('AT-003 migrations create schema and record version', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  const rows = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.equal(rows.length >= 3, true);
  assert.equal(rows[0].version, '001_initial');
  assert.equal(rows[1].version, '002_task_dependencies');
  assert.equal(rows[2].version, '003_task_required_role');
  store.close();
  assert.equal(existsSync(dbPath), true);
});

test('AT-003 CRUD for team and agent works', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const team = store.createTeam({
    team_id: 'team_store',
    status: 'active',
    profile: 'default',
    objective: 'test',
    max_threads: 4,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  assert.equal(team.team_id, 'team_store');

  const agent = store.createAgent({
    agent_id: 'agent_store',
    team_id: 'team_store',
    role: 'implementer',
    status: 'idle',
    model: 'inherit',
    created_at: new Date().toISOString()
  });
  assert.equal(agent.agent_id, 'agent_store');

  const listed = store.listAgentsByTeam('team_store');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].role, 'implementer');

  store.close();
});

test('AT-003 lock retry helper retries SQLITE_BUSY', () => {
  let calls = 0;
  const value = withRetry(() => {
    calls += 1;
    if (calls < 3) {
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return 'ok';
  }, { retries: 3, backoffMs: 1 });

  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});
