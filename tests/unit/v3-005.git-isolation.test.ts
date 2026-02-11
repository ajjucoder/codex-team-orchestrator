import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuntimeGitIsolationManager } from '../../mcp/runtime/git-manager.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v3-005-unit.sqlite';
const repoRoot = '.tmp/v3-005-unit-repo';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function createTeamAndAgents(store: SqliteStore, teamId: string): void {
  const now = new Date().toISOString();
  store.createTeam({
    team_id: teamId,
    status: 'active',
    profile: 'default',
    max_threads: 4,
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_impl',
    team_id: teamId,
    role: 'implementer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
  store.createAgent({
    agent_id: 'agent_review',
    team_id: teamId,
    role: 'reviewer',
    status: 'idle',
    created_at: now,
    updated_at: now
  });
}

test('V3-005 unit: unique branch/worktree allocation is persisted per active worker', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  createTeamAndAgents(store, 'team_v3_005_unit_alloc');

  const manager = new RuntimeGitIsolationManager({
    store,
    repoRoot
  });

  const allocA = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_alloc',
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  const allocB = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_alloc',
    agent_id: 'agent_review',
    role: 'reviewer'
  });

  assert.equal(allocA.ok, true);
  assert.equal(allocB.ok, true);
  assert.notEqual(allocA.assignment?.branch, allocB.assignment?.branch);
  assert.notEqual(allocA.assignment?.worktree_path, allocB.assignment?.worktree_path);
  assert.equal(existsSync(String(allocA.assignment?.worktree_path ?? '')), true);
  assert.equal(existsSync(String(allocB.assignment?.worktree_path ?? '')), true);
  assert.match(String(allocA.assignment?.branch ?? ''), /^team\/run-[\w-]+\/implementer-1$/);
  assert.match(String(allocB.assignment?.branch ?? ''), /^team\/run-[\w-]+\/reviewer-1$/);

  const team = store.getTeam('team_v3_005_unit_alloc');
  const runtimeIsolation = asRecord(asRecord(team?.metadata).runtime_git_isolation);
  const assignments = asRecord(runtimeIsolation.assignments);
  assert.equal(Object.keys(assignments).length, 2);
  assert.equal(asRecord(assignments.agent_impl).branch, allocA.assignment?.branch);
  assert.equal(asRecord(assignments.agent_review).branch, allocB.assignment?.branch);

  store.close();
});

test('V3-005 unit: worker command context fails closed outside assigned worktree', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  createTeamAndAgents(store, 'team_v3_005_unit_guard');

  const manager = new RuntimeGitIsolationManager({
    store,
    repoRoot
  });
  const alloc = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_guard',
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  assert.equal(alloc.ok, true);

  const inside = resolve(String(alloc.assignment?.worktree_path), 'src');
  mkdirSync(inside, { recursive: true });

  const allowed = manager.assertWorkerContext({
    team_id: 'team_v3_005_unit_guard',
    agent_id: 'agent_impl',
    cwd: inside
  });
  assert.equal(allowed.ok, true);

  const denied = manager.assertWorkerContext({
    team_id: 'team_v3_005_unit_guard',
    agent_id: 'agent_impl',
    cwd: resolve(repoRoot)
  });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error ?? ''), /outside assigned worktree/);

  const missingAssignment = manager.assertWorkerContext({
    team_id: 'team_v3_005_unit_guard',
    agent_id: 'agent_unknown',
    cwd: inside
  });
  assert.equal(missingAssignment.ok, false);
  assert.match(String(missingAssignment.error ?? ''), /no git assignment/);

  store.close();
});

test('V3-005 unit: orphan cleanup removes released worker assignments and worktrees', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  createTeamAndAgents(store, 'team_v3_005_unit_cleanup');

  const manager = new RuntimeGitIsolationManager({
    store,
    repoRoot
  });
  const allocA = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_cleanup',
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  const allocB = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_cleanup',
    agent_id: 'agent_review',
    role: 'reviewer'
  });
  assert.equal(allocA.ok, true);
  assert.equal(allocB.ok, true);

  const orphanCleanup = manager.cleanupOrphanAssignments({
    team_id: 'team_v3_005_unit_cleanup',
    active_agent_ids: new Set(['agent_impl'])
  });
  assert.equal(orphanCleanup.released_count, 1);
  assert.equal(manager.getTeamAssignments('team_v3_005_unit_cleanup').length, 1);
  assert.equal(existsSync(String(allocB.assignment?.worktree_path ?? '')), false);

  const finalizedCleanup = manager.releaseTeamAssignments('team_v3_005_unit_cleanup', 'team_finalized');
  assert.equal(finalizedCleanup.released_count, 1);
  assert.equal(manager.getTeamAssignments('team_v3_005_unit_cleanup').length, 0);
  assert.equal(existsSync(String(allocA.assignment?.worktree_path ?? '')), false);

  store.close();
});
