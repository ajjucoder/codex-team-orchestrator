import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { RuntimeGitIsolationManager } from '../../mcp/runtime/git-manager.js';
import { WorkerAdapter } from '../../mcp/runtime/worker-adapter.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-005-int.sqlite';
const logPath = '.tmp/v3-005-int.log';
const repoRoot = '.tmp/v3-005-int-repo';
const gitRepoRoot = '.tmp/v3-005-int-git-repo';
const finalizedIncompleteRepoRoot = '.tmp/v3-005-int-finalized-incomplete-repo';
const pausedIncompleteRepoRoot = '.tmp/v3-005-int-paused-incomplete-repo';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(gitRepoRoot, { recursive: true, force: true });
  rmSync(finalizedIncompleteRepoRoot, { recursive: true, force: true });
  rmSync(pausedIncompleteRepoRoot, { recursive: true, force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function runIncompleteInactiveScenario(status: 'finalized' | 'paused', repoPath: string): void {
  const baseBranch = initGitRepo(repoPath);
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-005 git isolation integration',
    max_threads: 4,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);

  const taskImplement = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'implement scoped change',
    required_role: 'implementer',
    priority: 1
  });
  const taskReview = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'review scoped change',
    required_role: 'reviewer',
    priority: 2
  });
  assert.equal(taskImplement.ok, true);
  assert.equal(taskReview.ok, true);

  const gitManager = new RuntimeGitIsolationManager({
    store: server.store,
    repoRoot: repoPath
  });
  const scheduler = createScheduler({
    server,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    gitManager
  });

  const firstTick = scheduler.tick();
  assert.equal(firstTick.dispatched_count, 2);

  const implementTask = server.store.getTask(taskImplement.task.task_id);
  const reviewTask = server.store.getTask(taskReview.task.task_id);
  assert.equal(implementTask?.status, 'in_progress');
  assert.equal(reviewTask?.status, 'in_progress');
  const implementOwner = String(implementTask?.claimed_by ?? '');
  const reviewOwner = String(reviewTask?.claimed_by ?? '');
  assert.notEqual(implementOwner, '');
  assert.notEqual(reviewOwner, '');
  assert.notEqual(implementOwner, reviewOwner);

  const assignmentMap = new Map(
    gitManager.getTeamAssignments(teamId).map((assignment) => [assignment.agent_id, assignment])
  );
  const implementAssignment = assignmentMap.get(implementOwner);
  const reviewAssignment = assignmentMap.get(reviewOwner);
  assert.equal(Boolean(implementAssignment), true);
  assert.equal(Boolean(reviewAssignment), true);
  if (!implementAssignment || !reviewAssignment) {
    throw new Error('expected assignment map entries for both workers');
  }

  commitInWorktree(implementAssignment.worktree_path, `${status}-implementer.txt`, `${status} implementer change`);
  commitInWorktree(reviewAssignment.worktree_path, `${status}-reviewer.txt`, `${status} reviewer change`);

  if (status === 'finalized') {
    const finalized = server.callTool('team_finalize', {
      team_id: teamId,
      reason: 'v3-005 finalized incomplete preserve verification'
    });
    assert.equal(finalized.ok, true);
  } else {
    const paused = server.store.updateTeamStatus(teamId, 'paused');
    assert.equal(Boolean(paused), true);
  }

  const cleanupTick = scheduler.tick();
  assert.equal(cleanupTick.cleaned_count, 0);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 2);
  assert.equal(existsSync(implementAssignment.worktree_path), true);
  assert.equal(existsSync(reviewAssignment.worktree_path), true);
  assert.equal(gitBranchExists(repoPath, implementAssignment.branch), true);
  assert.equal(gitBranchExists(repoPath, reviewAssignment.branch), true);
  assert.equal(gitShowFile(repoPath, baseBranch, `${status}-implementer.txt`), null);
  assert.equal(gitShowFile(repoPath, baseBranch, `${status}-reviewer.txt`), null);

  server.store.close();
}

test('V3-005 integration: complete lifecycle auto-integrates worker branches into base and prunes branch/worktree state', () => {
  const baseBranch = initGitRepo(gitRepoRoot);
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-005 git isolation complete lifecycle integration',
    max_threads: 4,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);

  const taskImplement = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'implement scoped change',
    required_role: 'implementer',
    priority: 1
  });
  const taskReview = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'review scoped change',
    required_role: 'reviewer',
    priority: 2
  });
  assert.equal(taskImplement.ok, true);
  assert.equal(taskReview.ok, true);

  const gitManager = new RuntimeGitIsolationManager({
    store: server.store,
    repoRoot: gitRepoRoot
  });
  const scheduler = createScheduler({
    server,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    gitManager
  });

  const firstTick = scheduler.tick();
  assert.equal(firstTick.dispatched_count, 2);
  assert.equal(firstTick.cleaned_count, 0);
  for (const dispatch of firstTick.dispatches) {
    assert.match(dispatch.git_branch, /^team\/run-[\w-]+\/[\w-]+-\d+$/);
    assert.match(dispatch.git_worktree_path, /\.tmp\/agent-teams\/run-[\w-]+\/[\w-]+-\d+$/);
    assert.equal(existsSync(dispatch.git_worktree_path), true);
  }

  const implementTask = server.store.getTask(taskImplement.task.task_id);
  const reviewTask = server.store.getTask(taskReview.task.task_id);
  assert.equal(implementTask?.status, 'in_progress');
  assert.equal(reviewTask?.status, 'in_progress');
  const implementOwner = String(implementTask?.claimed_by ?? '');
  const reviewOwner = String(reviewTask?.claimed_by ?? '');
  assert.notEqual(implementOwner, '');
  assert.notEqual(reviewOwner, '');
  assert.notEqual(implementOwner, reviewOwner);

  const assignmentMap = new Map(
    gitManager.getTeamAssignments(teamId).map((assignment) => [assignment.agent_id, assignment])
  );
  const implementAssignment = assignmentMap.get(implementOwner);
  const reviewAssignment = assignmentMap.get(reviewOwner);
  assert.equal(Boolean(implementAssignment), true);
  assert.equal(Boolean(reviewAssignment), true);
  if (!implementAssignment || !reviewAssignment) {
    throw new Error('expected assignment map entries for both workers');
  }

  commitInWorktree(implementAssignment.worktree_path, 'implementer.txt', 'implementer change');
  commitInWorktree(reviewAssignment.worktree_path, 'reviewer.txt', 'reviewer change');

  const completedImplement = server.store.updateTask({
    team_id: teamId,
    task_id: taskImplement.task.task_id,
    expected_lock_version: Number(implementTask?.lock_version ?? 0),
    patch: {
      status: 'done'
    }
  });
  const completedReview = server.store.updateTask({
    team_id: teamId,
    task_id: taskReview.task.task_id,
    expected_lock_version: Number(reviewTask?.lock_version ?? 0),
    patch: {
      status: 'done'
    }
  });
  assert.equal(completedImplement.ok, true);
  assert.equal(completedReview.ok, true);
  server.store.updateAgentStatus(implementOwner, 'idle');
  server.store.updateAgentStatus(reviewOwner, 'idle');

  const finalized = server.callTool('team_finalize', {
    team_id: teamId,
    reason: 'v3-005 complete lifecycle auto integrate verification'
  });
  assert.equal(finalized.ok, true);

  const cleanupTick = scheduler.tick();
  assert.equal(cleanupTick.cleaned_count >= 2, true);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 0);
  assert.equal(gitShowFile(gitRepoRoot, baseBranch, 'implementer.txt')?.trim(), 'implementer change');
  assert.equal(gitShowFile(gitRepoRoot, baseBranch, 'reviewer.txt')?.trim(), 'reviewer change');
  assert.equal(gitBranchExists(gitRepoRoot, implementAssignment.branch), false);
  assert.equal(gitBranchExists(gitRepoRoot, reviewAssignment.branch), false);
  assert.equal(existsSync(implementAssignment.worktree_path), false);
  assert.equal(existsSync(reviewAssignment.worktree_path), false);

  const runtimeIsolation = asRecord(asRecord(server.store.getTeam(teamId)?.metadata).runtime_git_isolation);
  const assignmentsAfterFinalize = asRecord(runtimeIsolation.assignments);
  assert.equal(Object.keys(assignmentsAfterFinalize).length, 0);

  server.store.close();
});

test('V3-005 integration: incomplete finalized team does not auto-integrate and preserves branch/worktree state', () => {
  runIncompleteInactiveScenario('finalized', finalizedIncompleteRepoRoot);
});

test('V3-005 integration: incomplete paused team does not auto-integrate and preserves branch/worktree state', () => {
  runIncompleteInactiveScenario('paused', pausedIncompleteRepoRoot);
});

test('V3-005 integration: non-git fallback path still cleans up assignments deterministically', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-005 non-git fallback integration',
    max_threads: 3,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(worker.ok, true);

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'non-git assignment bootstrap',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(task.ok, true);

  const gitManager = new RuntimeGitIsolationManager({
    store: server.store,
    repoRoot
  });
  const scheduler = createScheduler({
    server,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    gitManager
  });
  const dispatchTick = scheduler.tick();
  assert.equal(dispatchTick.dispatched_count >= 1, true);
  const assignment = gitManager
    .getTeamAssignments(teamId)
    .find((entry) => entry.agent_id === String(worker.agent.agent_id));
  if (!assignment) {
    throw new Error('expected assignment in non-git fallback test');
  }
  assert.equal(existsSync(assignment.worktree_path), true);

  const finalized = server.callTool('team_finalize', {
    team_id: teamId,
    reason: 'v3-005 non-git fallback cleanup verification'
  });
  assert.equal(finalized.ok, true);

  const cleanupTick = scheduler.tick();
  assert.equal(cleanupTick.cleaned_count >= 1, true);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 0);
  assert.equal(existsSync(assignment.worktree_path), false);

  server.store.close();
});

test('V3-005 integration: team_send enforces assigned worktree cwd in production runtime path', () => {
  const sends: Array<{ worker_id: string; cwd?: string }> = [];
  const adapter = new WorkerAdapter({
    name: 'mock-v3-005-int',
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
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-005 team_send cwd integration',
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

  const createdTask = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'assignment bootstrap',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(createdTask.ok, true);
  const scheduler = createScheduler({
    server,
    tickIntervalMs: 25,
    readyTaskLimit: 50,
    gitManager
  });
  const tick = scheduler.tick();
  assert.equal(tick.dispatched_count >= 1, true);

  const assignment = gitManager
    .getTeamAssignments(teamId)
    .find((entry) => entry.agent_id === String(worker.agent.agent_id));
  if (!assignment) {
    throw new Error('expected scheduler assignment for implementer');
  }

  const defaultCwdSend = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'default cwd',
    artifact_refs: [],
    idempotency_key: 'v3-005-int-cwd-default'
  });
  assert.equal(defaultCwdSend.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.cwd, assignment.worktree_path);

  const insideCwd = resolve(assignment.worktree_path, 'workspace');
  const insideSend = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: String(lead.agent.agent_id),
    to_agent_id: String(worker.agent.agent_id),
    summary: 'inside cwd',
    cwd: insideCwd,
    artifact_refs: [],
    idempotency_key: 'v3-005-int-cwd-inside'
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
    idempotency_key: 'v3-005-int-cwd-outside'
  });
  assert.equal(rejected.ok, false);
  assert.match(String(rejected.error ?? ''), /outside assigned worktree/);
  assert.equal(sends.length, 2);

  const rejectedCount = server
    .store
    .db
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE idempotency_key = ?')
    .get('v3-005-int-cwd-outside');
  assert.equal(Number(rejectedCount?.count ?? 0), 0);

  server.store.close();
});
