import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { RuntimeGitIsolationManager } from '../../mcp/runtime/git-manager.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-005-int.sqlite';
const logPath = '.tmp/v3-005-int.log';
const repoRoot = '.tmp/v3-005-int-repo';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

test('V3-005 integration: scheduler enforces worker git isolation and cleans up on completion/finalize', () => {
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
    repoRoot
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

  const assignmentMap = new Map(gitManager.getTeamAssignments(teamId).map((assignment) => [assignment.agent_id, assignment]));
  assert.equal(assignmentMap.size, 2);
  const implementAssignment = assignmentMap.get(implementOwner);
  const reviewAssignment = assignmentMap.get(reviewOwner);
  assert.equal(Boolean(implementAssignment), true);
  assert.equal(Boolean(reviewAssignment), true);

  const completed = server.store.updateTask({
    team_id: teamId,
    task_id: taskImplement.task.task_id,
    expected_lock_version: Number(implementTask?.lock_version ?? 0),
    patch: {
      status: 'done'
    }
  });
  assert.equal(completed.ok, true);
  server.store.updateAgentStatus(implementOwner, 'idle');

  const secondTick = scheduler.tick();
  assert.equal(secondTick.cleaned_count >= 1, true);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 1);
  assert.equal(existsSync(String(implementAssignment?.worktree_path ?? '')), false);
  assert.equal(existsSync(String(reviewAssignment?.worktree_path ?? '')), true);

  const finalized = server.callTool('team_finalize', {
    team_id: teamId,
    reason: 'v3-005 cleanup verification'
  });
  assert.equal(finalized.ok, true);

  const thirdTick = scheduler.tick();
  assert.equal(thirdTick.cleaned_count >= 1, true);
  assert.equal(gitManager.getTeamAssignments(teamId).length, 0);
  assert.equal(existsSync(String(reviewAssignment?.worktree_path ?? '')), false);

  const runtimeIsolation = asRecord(asRecord(server.store.getTeam(teamId)?.metadata).runtime_git_isolation);
  const assignmentsAfterFinalize = asRecord(runtimeIsolation.assignments);
  assert.equal(Object.keys(assignmentsAfterFinalize).length, 0);

  server.store.close();
});
