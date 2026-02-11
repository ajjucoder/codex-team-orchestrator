import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v3-001-int.sqlite';
const migrationDir = join(process.cwd(), 'mcp', 'store', 'migrations');
const legacyVersions = [
  '001_initial',
  '002_task_dependencies',
  '003_task_required_role',
  '004_team_mode',
  '005_agent_heartbeat_and_task_leases',
  '006_team_hierarchy'
] as const;

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

function bootstrapLegacySchema(): void {
  const db = new DatabaseSync(dbPath);
  const appliedAt = new Date().toISOString();
  for (const version of legacyVersions) {
    const sql = readFileSync(join(migrationDir, `${version}.sql`), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(version, appliedAt);
  }
  db.close();
}

test('V3-001 integration: legacy data upgrades cleanly and execution attempts persist', () => {
  bootstrapLegacySchema();

  const legacyStore = new SqliteStore(dbPath);
  const now = new Date().toISOString();
  legacyStore.createTeam({
    team_id: 'team_v3_legacy',
    status: 'active',
    profile: 'default',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });
  legacyStore.createTask({
    task_id: 'task_v3_legacy',
    team_id: 'team_v3_legacy',
    title: 'legacy task',
    description: 'created before v3 migration',
    status: 'todo',
    priority: 1,
    created_at: now,
    updated_at: now
  });
  const beforeMigrationTask = legacyStore.getTask('task_v3_legacy');
  legacyStore.close();

  const store = new SqliteStore(dbPath);
  store.migrate();

  const migrationRow = store.db
    .prepare('SELECT version FROM schema_migrations WHERE version = ?')
    .get('007_task_execution_attempts') as { version?: string } | undefined;
  assert.equal(migrationRow?.version, '007_task_execution_attempts');

  const afterMigrationTask = store.getTask('task_v3_legacy');
  assert.equal(afterMigrationTask?.task_id, beforeMigrationTask?.task_id);
  assert.equal(afterMigrationTask?.title, 'legacy task');
  assert.equal(afterMigrationTask?.description, 'created before v3 migration');
  assert.equal(afterMigrationTask?.status, 'todo');
  assert.equal(afterMigrationTask?.lock_version, beforeMigrationTask?.lock_version);

  const created = store.createExecutionAttempt({
    execution_id: 'exec_v3_legacy_1',
    team_id: 'team_v3_legacy',
    task_id: 'task_v3_legacy',
    attempt_no: 1,
    status: 'dispatching',
    retry_count: 1,
    metadata: { origin: 'integration-test' },
    created_at: now,
    updated_at: now
  });
  assert.equal(created?.execution_id, 'exec_v3_legacy_1');
  assert.equal(created?.status, 'dispatching');

  const updated = store.updateExecutionAttempt({
    execution_id: 'exec_v3_legacy_1',
    patch: {
      status: 'failed_terminal',
      retry_count: 3,
      metadata: { origin: 'integration-test', terminal: true }
    }
  });
  assert.equal(updated?.execution_id, 'exec_v3_legacy_1');
  assert.equal(updated?.status, 'failed_terminal');
  assert.equal(updated?.retry_count, 3);

  const listed = store.listExecutionAttempts('team_v3_legacy', 'task_v3_legacy');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].execution_id, 'exec_v3_legacy_1');
  assert.equal(listed[0].attempt_no, 1);
  assert.equal(listed[0].retry_count, 3);

  store.close();
});
