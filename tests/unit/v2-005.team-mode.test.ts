import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v2-005-unit.sqlite';

function migrationSql(versionFile: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '../../mcp/store/migrations', versionFile), 'utf8');
}

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('V2-005 migration sets existing teams to default mode', () => {
  const db = new DatabaseSync(dbPath);
  db.exec(migrationSql('001_initial.sql'));
  db.exec(migrationSql('002_task_dependencies.sql'));
  db.exec(migrationSql('003_task_required_role.sql'));
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run('001_initial', new Date().toISOString());
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run('002_task_dependencies', new Date().toISOString());
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run('003_task_required_role', new Date().toISOString());
  db.prepare(
    'INSERT INTO teams(team_id, status, profile, objective, max_threads, session_model, created_at, updated_at, last_active_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'team_legacy_mode',
    'active',
    'default',
    'legacy migration',
    4,
    null,
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    '{}'
  );
  db.close();

  const store = new SqliteStore(dbPath);
  store.migrate();
  const legacy = store.getTeam('team_legacy_mode');
  assert.ok(legacy);
  assert.equal(legacy?.mode, 'default');
  store.close();
});

test('V2-005 store persists explicit mode changes', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  const now = new Date().toISOString();
  const team = store.createTeam({
    team_id: 'team_mode_write',
    status: 'active',
    profile: 'default',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });
  assert.ok(team);
  assert.equal(team?.mode, 'default');

  const updated = store.updateTeamMode('team_mode_write', 'plan');
  assert.ok(updated);
  assert.equal(updated?.mode, 'plan');

  const loaded = store.getTeam('team_mode_write');
  assert.equal(loaded?.mode, 'plan');
  store.close();
});
