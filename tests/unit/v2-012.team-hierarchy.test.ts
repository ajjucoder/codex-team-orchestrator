import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v2-012-unit.sqlite';

function migrationSql(versionFile: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '../../mcp/store/migrations', versionFile), 'utf8');
}

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test('V2-012 migration backfills hierarchy defaults for legacy teams', () => {
  const db = new DatabaseSync(dbPath);
  db.exec(migrationSql('001_initial.sql'));
  db.exec(migrationSql('002_task_dependencies.sql'));
  db.exec(migrationSql('003_task_required_role.sql'));
  db.exec(migrationSql('004_team_mode.sql'));
  db.exec(migrationSql('005_agent_heartbeat_and_task_leases.sql'));
  for (const version of [
    '001_initial',
    '002_task_dependencies',
    '003_task_required_role',
    '004_team_mode',
    '005_agent_heartbeat_and_task_leases'
  ]) {
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
      version,
      new Date().toISOString()
    );
  }
  db.prepare(
    'INSERT INTO teams(team_id, status, mode, profile, objective, max_threads, session_model, created_at, updated_at, last_active_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'team_legacy_hierarchy',
    'active',
    'default',
    'default',
    'legacy hierarchy',
    3,
    null,
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    '{}'
  );
  db.close();

  const store = new SqliteStore(dbPath);
  store.migrate();
  const legacy = store.getTeam('team_legacy_hierarchy');
  assert.ok(legacy);
  assert.equal(legacy?.parent_team_id, null);
  assert.equal(legacy?.root_team_id, 'team_legacy_hierarchy');
  assert.equal(legacy?.hierarchy_depth, 0);

  const links = store.listTeamHierarchyLinks('team_legacy_hierarchy');
  assert.equal(
    links.some((link) => link.ancestor_team_id === 'team_legacy_hierarchy'
      && link.descendant_team_id === 'team_legacy_hierarchy'
      && link.depth === 0),
    true
  );
  store.close();
});

test('V2-012 store persists validated parent-child hierarchy and query APIs', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  const now = new Date().toISOString();

  const root = store.createTeam({
    team_id: 'team_hierarchy_root',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  assert.ok(root);
  assert.equal(root?.parent_team_id, null);
  assert.equal(root?.root_team_id, 'team_hierarchy_root');
  assert.equal(root?.hierarchy_depth, 0);

  const child = store.createTeam({
    team_id: 'team_hierarchy_child',
    parent_team_id: 'team_hierarchy_root',
    status: 'active',
    profile: 'default',
    max_threads: 3,
    created_at: now,
    updated_at: now
  });
  assert.ok(child);
  assert.equal(child?.parent_team_id, 'team_hierarchy_root');
  assert.equal(child?.root_team_id, 'team_hierarchy_root');
  assert.equal(child?.hierarchy_depth, 1);

  const grandchild = store.createTeam({
    team_id: 'team_hierarchy_grandchild',
    parent_team_id: 'team_hierarchy_child',
    status: 'active',
    profile: 'default',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  assert.ok(grandchild);
  assert.equal(grandchild?.parent_team_id, 'team_hierarchy_child');
  assert.equal(grandchild?.root_team_id, 'team_hierarchy_root');
  assert.equal(grandchild?.hierarchy_depth, 2);

  const directChildren = store.listChildTeams('team_hierarchy_root', false);
  assert.deepEqual(directChildren.map((team) => team.team_id), ['team_hierarchy_child']);

  const descendants = store.listChildTeams('team_hierarchy_root', true);
  assert.deepEqual(
    descendants.map((team) => team.team_id),
    ['team_hierarchy_child', 'team_hierarchy_grandchild']
  );

  const lineage = store.listTeamLineage('team_hierarchy_grandchild');
  assert.deepEqual(lineage.map((team) => team.team_id), ['team_hierarchy_root', 'team_hierarchy_child']);

  assert.equal(store.isDescendantTeam('team_hierarchy_root', 'team_hierarchy_grandchild'), true);
  assert.equal(store.isDescendantTeam('team_hierarchy_child', 'team_hierarchy_root'), false);

  const rejected = store.createTeam({
    team_id: 'team_hierarchy_invalid',
    parent_team_id: 'team_missing_parent',
    status: 'active',
    profile: 'default',
    max_threads: 2,
    created_at: now,
    updated_at: now
  });
  assert.equal(rejected, null);

  store.close();
});
