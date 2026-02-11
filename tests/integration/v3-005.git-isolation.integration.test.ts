import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
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
