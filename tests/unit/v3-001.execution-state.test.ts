import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { validateEntity, validateTool } from '../../mcp/server/contracts.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v3-001-unit.sqlite';
const logPath = '.tmp/v3-001-unit.log';
const EXECUTION_STATUSES = [
  'queued',
  'dispatching',
  'executing',
  'validating',
  'integrating',
  'failed_terminal'
] as const;

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-001 migration registers execution attempt schema', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const versionRow = store.db
    .prepare('SELECT version FROM schema_migrations WHERE version = ?')
    .get('007_task_execution_attempts') as { version?: string } | undefined;
  assert.equal(versionRow?.version, '007_task_execution_attempts');

  const tableRow = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_execution_attempts'")
    .get() as { name?: string } | undefined;
  assert.equal(tableRow?.name, 'task_execution_attempts');

  const columns = store.db.prepare('PRAGMA table_info(task_execution_attempts)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  for (const required of [
    'execution_id',
    'team_id',
    'task_id',
    'attempt_no',
    'status',
    'lease_owner_agent_id',
    'lease_expires_at',
    'retry_count',
    'metadata_json',
    'created_at',
    'updated_at'
  ]) {
    assert.equal(columnNames.has(required), true, `missing column ${required}`);
  }

  store.close();
});

test('V3-001 schemas accept new execution-state statuses', () => {
  for (const status of EXECUTION_STATUSES) {
    const entityResult = validateEntity('task.schema.json', {
      task_id: 'task_v3_status',
      team_id: 'team_v3_status',
      title: 'status acceptance',
      status,
      priority: 1,
      created_at: new Date().toISOString()
    });
    assert.equal(entityResult.ok, true, entityResult.errors.join('; '));

    const listResult = validateTool('team_task_list.schema.json', {
      team_id: 'team_v3_status',
      status
    });
    assert.equal(listResult.ok, true, listResult.errors.join('; '));

    const updateResult = validateTool('team_task_update.schema.json', {
      team_id: 'team_v3_status',
      task_id: 'task_v3_status',
      expected_lock_version: 0,
      status
    });
    assert.equal(updateResult.ok, true, updateResult.errors.join('; '));
  }
});

test('V3-001 execution attempts keep execution_id immutable and persist retry_count', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();

  const now = new Date().toISOString();
  store.createTeam({
    team_id: 'team_v3_attempt',
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  store.createTask({
    task_id: 'task_v3_attempt',
    team_id: 'team_v3_attempt',
    title: 'execution attempt',
    status: 'queued',
    priority: 1,
    created_at: now,
    updated_at: now
  });

  const created = store.createExecutionAttempt({
    execution_id: 'exec_v3_attempt_1',
    team_id: 'team_v3_attempt',
    task_id: 'task_v3_attempt',
    attempt_no: 1,
    status: 'queued',
    retry_count: 0,
    metadata: { phase: 'queued' },
    created_at: now,
    updated_at: now
  });
  assert.equal(created?.execution_id, 'exec_v3_attempt_1');
  assert.equal(created?.retry_count, 0);

  const patchWithImmutableFields = {
    status: 'executing',
    retry_count: 2,
    metadata: { phase: 'executing' },
    execution_id: 'exec_v3_attempt_mutated',
    attempt_no: 999
  } as unknown as Parameters<SqliteStore['updateExecutionAttempt']>[0]['patch'];

  const updated = store.updateExecutionAttempt({
    execution_id: 'exec_v3_attempt_1',
    patch: patchWithImmutableFields
  });

  assert.equal(updated?.execution_id, 'exec_v3_attempt_1');
  assert.equal(updated?.attempt_no, 1);
  assert.equal(updated?.retry_count, 2);
  assert.equal(updated?.status, 'executing');
  assert.equal(store.getExecutionAttempt('exec_v3_attempt_mutated'), null);

  store.close();

  const reopened = new SqliteStore(dbPath);
  reopened.migrate();
  const persisted = reopened.getExecutionAttempt('exec_v3_attempt_1');
  assert.equal(persisted?.retry_count, 2);
  assert.equal(persisted?.status, 'executing');
  assert.deepEqual(persisted?.metadata, { phase: 'executing' });

  const listed = reopened.listExecutionAttempts('team_v3_attempt', 'task_v3_attempt');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].execution_id, 'exec_v3_attempt_1');
  reopened.close();
});

test('V3-001 task board tools honor queued status in update/list path', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTaskBoardTools(server);

  const team = server.callTool('team_start', {
    objective: 'execution-state tool path',
    max_threads: 2
  });
  const teamId = team.team.team_id;

  const queuedCandidate = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'queued candidate',
    priority: 1
  });
  const todoControl = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'todo control',
    priority: 2
  });
  assert.equal(queuedCandidate.ok, true);
  assert.equal(todoControl.ok, true);

  const updated = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: queuedCandidate.task.task_id,
    status: 'queued',
    expected_lock_version: queuedCandidate.task.lock_version
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.status, 'queued');

  const queuedOnly = server.callTool('team_task_list', {
    team_id: teamId,
    status: 'queued'
  });
  assert.equal(queuedOnly.ok, true);
  assert.equal(queuedOnly.tasks.length, 1);
  assert.equal(queuedOnly.tasks[0].task_id, queuedCandidate.task.task_id);
  assert.equal(queuedOnly.tasks[0].status, 'queued');

  const todoOnly = server.callTool('team_task_list', {
    team_id: teamId,
    status: 'todo'
  });
  assert.equal(todoOnly.ok, true);
  assert.equal(todoOnly.tasks.length, 1);
  assert.equal(todoOnly.tasks[0].task_id, todoControl.task.task_id);

  server.store.close();
});
