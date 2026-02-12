import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuntimeGitIsolationManager } from '../../mcp/runtime/git-manager.js';
import { WorkerAdapter } from '../../mcp/runtime/worker-adapter.js';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { SqliteStore } from '../../mcp/store/sqlite-store.js';

const dbPath = '.tmp/v3-005-unit.sqlite';
const logPath = '.tmp/v3-005-unit.log';
const repoRoot = '.tmp/v3-005-unit-repo';
const gitRepoRoot = '.tmp/v3-005-unit-git-repo';
const fallbackRepoRoot = '.tmp/v3-005-unit-fallback-repo';
const defaultModeWorktreeRoot = '.tmp/v3-005-unit-default-worktrees';
const nonGitCleanupWorktreeRoot = resolve('.tmp/v3-005-unit-nongit-cleanup-worktrees');

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(gitRepoRoot, { recursive: true, force: true });
  rmSync(fallbackRepoRoot, { recursive: true, force: true });
  rmSync(defaultModeWorktreeRoot, { recursive: true, force: true });
  rmSync(nonGitCleanupWorktreeRoot, { recursive: true, force: true });
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

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

function initGitRepo(repoPath: string): string {
  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ['init']);
  runGit(repoPath, ['checkout', '-B', 'main']);
  runGit(repoPath, ['config', 'user.email', 'tests@example.com']);
  runGit(repoPath, ['config', 'user.name', 'v3-005-tests']);
  writeFileSync(resolve(repoPath, 'README.md'), 'seed\n', 'utf8');
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['commit', '-m', 'seed']);
  return 'main';
}

function commitInWorktree(worktreePath: string, fileName: string, content: string): void {
  writeFileSync(resolve(worktreePath, fileName), `${content}\n`, 'utf8');
  runGit(worktreePath, ['add', fileName]);
  runGit(worktreePath, ['commit', '-m', `add ${fileName}`]);
}

function gitBranchExists(repoPath: string, branch: string): boolean {
  return runGit(repoPath, ['branch', '--list', branch]).length > 0;
}

function gitShowFile(repoPath: string, ref: string, fileName: string): string | null {
  try {
    return runGit(repoPath, ['show', `${ref}:${fileName}`]);
  } catch {
    return null;
  }
}

function createTask(
  store: SqliteStore,
  input: {
    teamId: string;
    taskId: string;
    requiredRole: string;
    claimedBy: string;
    status: 'in_progress' | 'done';
    priority: number;
  }
): void {
  const now = new Date().toISOString();
  store.createTask({
    task_id: input.taskId,
    team_id: input.teamId,
    title: input.taskId,
    description: '',
    required_role: input.requiredRole,
    status: input.status,
    priority: input.priority,
    claimed_by: input.claimedBy,
    lock_version: 0,
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

test('V3-005 unit: default manager mode stays filesystem-only without git operations', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  createTeamAndAgents(store, 'team_v3_005_unit_default_mode');

  const manager = new RuntimeGitIsolationManager({
    store,
    worktreeRoot: defaultModeWorktreeRoot
  });
  const allocation = manager.allocateForAgent({
    team_id: 'team_v3_005_unit_default_mode',
    agent_id: 'agent_impl',
    role: 'implementer'
  });

  assert.equal(allocation.ok, true);
  assert.equal(Boolean(allocation.assignment), true);
  assert.equal(allocation.assignment?.git_managed, false);
  assert.equal(existsSync(String(allocation.assignment?.worktree_path ?? '')), true);

  const released = manager.releaseTeamAssignments('team_v3_005_unit_default_mode', 'cleanup_default_mode');
  assert.equal(released.released_count, 1);
  assert.equal(existsSync(String(allocation.assignment?.worktree_path ?? '')), false);

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

test('V3-005 unit: complete finalized lifecycle auto-integrates worker branches and prunes branch/worktree state', () => {
  const baseBranch = initGitRepo(gitRepoRoot);
  const store = new SqliteStore(dbPath);
  store.migrate();
  const teamId = 'team_v3_005_unit_finalize_complete';
  createTeamAndAgents(store, teamId);

  const manager = new RuntimeGitIsolationManager({
    store,
    repoRoot: gitRepoRoot
  });

  const implementer = manager.allocateForAgent({
    team_id: teamId,
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  const reviewer = manager.allocateForAgent({
    team_id: teamId,
    agent_id: 'agent_review',
    role: 'reviewer'
  });
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);
  if (!implementer.assignment || !reviewer.assignment) {
    throw new Error('expected assignments for both workers');
  }

  commitInWorktree(implementer.assignment.worktree_path, 'implementer.txt', 'implementer change');
  commitInWorktree(reviewer.assignment.worktree_path, 'reviewer.txt', 'reviewer change');

  createTask(store, {
    teamId,
    taskId: 'task_impl_done',
    requiredRole: 'implementer',
    claimedBy: 'agent_impl',
    status: 'done',
    priority: 1
  });
  createTask(store, {
    teamId,
    taskId: 'task_review_done',
    requiredRole: 'reviewer',
    claimedBy: 'agent_review',
    status: 'done',
    priority: 2
  });
  store.updateAgentStatus('agent_impl', 'idle');
  store.updateAgentStatus('agent_review', 'idle');

  const finalizedTeam = store.updateTeamStatus(teamId, 'finalized');
  if (!finalizedTeam) {
    throw new Error('expected finalized team');
  }
  const cleanup = manager.cleanupForTeam(finalizedTeam, store.listAgentsByTeam(teamId), store.listTasks(teamId));
  assert.equal(cleanup.released_count, 2);
  assert.equal(manager.getTeamAssignments(teamId).length, 0);

  assert.equal(gitShowFile(gitRepoRoot, baseBranch, 'implementer.txt')?.trim(), 'implementer change');
  assert.equal(gitShowFile(gitRepoRoot, baseBranch, 'reviewer.txt')?.trim(), 'reviewer change');
  assert.equal(gitBranchExists(gitRepoRoot, implementer.assignment.branch), false);
  assert.equal(gitBranchExists(gitRepoRoot, reviewer.assignment.branch), false);
  assert.equal(existsSync(implementer.assignment.worktree_path), false);
  assert.equal(existsSync(reviewer.assignment.worktree_path), false);

  store.close();
});

test('V3-005 unit: non-git fallback still releases team assignments without git metadata', () => {
  const store = new SqliteStore(dbPath);
  store.migrate();
  const teamId = 'team_v3_005_unit_fallback';
  createTeamAndAgents(store, teamId);

  const manager = new RuntimeGitIsolationManager({
    store,
    repoRoot: fallbackRepoRoot
  });
  const allocation = manager.allocateForAgent({
    team_id: teamId,
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  assert.equal(allocation.ok, true);
  assert.equal(existsSync(String(allocation.assignment?.worktree_path ?? '')), true);

  const released = manager.releaseTeamAssignments(teamId, 'team_finalized');
  assert.equal(released.released_count, 1);
  assert.equal(manager.getTeamAssignments(teamId).length, 0);
  assert.equal(existsSync(String(allocation.assignment?.worktree_path ?? '')), false);

  store.close();
});

test('V3-005 unit: team_send defaults cwd to assignment and rejects cwd outside assigned worktree', () => {
  const sends: Array<{ worker_id: string; cwd?: string }> = [];
  const adapter = new WorkerAdapter({
    name: 'mock-v3-005-unit',
    spawn: (input) => ({
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned'
    }),
    sendInstruction: (input) => {
      sends.push({ worker_id: input.worker_id, cwd: input.cwd });
      return {
        accepted: true,
        instruction_id: `instruction_${sends.length}`,
        status: 'queued'
      };
    },
    poll: (input) => ({
      worker_id: input.worker_id,
      status: 'running',
      cursor: input.cursor ?? null,
      events: [],
      output: {}
    }),
    interrupt: () => ({
      interrupted: true,
      status: 'interrupted'
    }),
    collectArtifacts: (input) => ({
      worker_id: input.worker_id,
      artifacts: []
    })
  });

  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  const gitManager = new RuntimeGitIsolationManager({
    store: server.store,
    repoRoot
  });
  registerAgentLifecycleTools(server, { workerAdapter: adapter, gitManager });

  const started = server.callTool('team_start', {
    objective: 'v3-005 team_send cwd unit',
    max_threads: 3,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const worker = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);

  const defaultCwdSend = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'default cwd',
    artifact_refs: [],
    idempotency_key: 'v3-005-unit-cwd-default'
  });
  assert.equal(defaultCwdSend.ok, true);
  assert.equal(sends.length, 1);

  const assignment = gitManager
    .getTeamAssignments(teamId)
    .find((entry) => entry.agent_id === String(worker.agent.agent_id));
  if (!assignment) {
    throw new Error('expected git isolation assignment for team_send recipient');
  }
  assert.equal(sends[0]?.cwd, assignment.worktree_path);

  const insideCwd = resolve(assignment.worktree_path, 'src');
  const insideSend = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'inside cwd',
    cwd: insideCwd,
    artifact_refs: [],
    idempotency_key: 'v3-005-unit-cwd-inside'
  });
  assert.equal(insideSend.ok, true);
  assert.equal(sends.length, 2);
  assert.equal(sends[1]?.cwd, insideCwd);

  const outsideCwd = resolve(repoRoot);
  const rejected = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'outside cwd',
    cwd: outsideCwd,
    artifact_refs: [],
    idempotency_key: 'v3-005-unit-cwd-outside'
  });
  assert.equal(rejected.ok, false);
  assert.match(String(rejected.error ?? ''), /outside assigned worktree/);
  assert.equal(sends.length, 2);

  const rejectedCount = server
    .store
    .db
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE idempotency_key = ?')
    .get('v3-005-unit-cwd-outside');
  assert.equal(Number(rejectedCount?.count ?? 0), 0);

  server.store.close();
});

test('V3-005 unit: inactive team with non-git-managed assignments in git-enabled runtime releases instead of stranding', () => {
  initGitRepo(gitRepoRoot);
  const store = new SqliteStore(dbPath);
  store.migrate();
  const teamId = 'team_v3_005_unit_nongit_cleanup';
  createTeamAndAgents(store, teamId);

  const filesystemManager = new RuntimeGitIsolationManager({
    store,
    worktreeRoot: nonGitCleanupWorktreeRoot
  });
  const allocA = filesystemManager.allocateForAgent({
    team_id: teamId,
    agent_id: 'agent_impl',
    role: 'implementer'
  });
  const allocB = filesystemManager.allocateForAgent({
    team_id: teamId,
    agent_id: 'agent_review',
    role: 'reviewer'
  });
  assert.equal(allocA.ok, true);
  assert.equal(allocB.ok, true);
  assert.equal(allocA.assignment?.git_managed, false);
  assert.equal(allocB.assignment?.git_managed, false);
  assert.equal(existsSync(String(allocA.assignment?.worktree_path ?? '')), true);
  assert.equal(existsSync(String(allocB.assignment?.worktree_path ?? '')), true);

  const gitManager = new RuntimeGitIsolationManager({
    store,
    repoRoot: gitRepoRoot,
    worktreeRoot: nonGitCleanupWorktreeRoot
  });

  createTask(store, {
    teamId,
    taskId: 'task_done_a',
    requiredRole: 'implementer',
    claimedBy: 'agent_impl',
    status: 'done',
    priority: 1
  });
  createTask(store, {
    teamId,
    taskId: 'task_done_b',
    requiredRole: 'reviewer',
    claimedBy: 'agent_review',
    status: 'done',
    priority: 2
  });

  const finalized = store.updateTeamStatus(teamId, 'finalized');
  if (!finalized) throw new Error('expected finalized team');

  const cleanup = gitManager.cleanupForTeam(
    finalized,
    store.listAgentsByTeam(teamId),
    store.listTasks(teamId)
  );

  assert.equal(cleanup.released_count, 2);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 0);
  assert.equal(existsSync(String(allocA.assignment?.worktree_path ?? '')), false);
  assert.equal(existsSync(String(allocB.assignment?.worktree_path ?? '')), false);
  const integration = asRecord(cleanup.integration);
  assert.equal(integration.attempted, false);
  assert.equal(integration.reason, 'non_git_assignments');

  store.close();
});
