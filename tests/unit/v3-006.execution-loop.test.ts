import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RuntimeExecutor } from '../../mcp/runtime/executor.js';
import type { RuntimeScheduler, SchedulerDispatch, SchedulerTickResult } from '../../mcp/runtime/scheduler.js';
import {
  WorkerAdapter,
  type WorkerCollectArtifactsInput,
  type WorkerCollectArtifactsResult,
  type WorkerInterruptInput,
  type WorkerInterruptResult,
  type WorkerPollInput,
  type WorkerPollResult,
  type WorkerProvider,
  type WorkerSendInstructionInput,
  type WorkerSendInstructionResult,
  type WorkerSpawnInput,
  type WorkerSpawnResult
} from '../../mcp/runtime/worker-adapter.js';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerRebalancerTools } from '../../mcp/server/tools/rebalancer.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-006-unit.sqlite';
const logPath = '.tmp/v3-006-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function makeWorkerAdapter(options: {
  failPoll?: boolean;
  pollStatus?: string;
  pollEvents?: Array<Record<string, unknown>>;
  pollOutput?: Record<string, unknown> | null;
  artifactCount?: number;
} = {}): WorkerAdapter {
  const provider: WorkerProvider = {
    name: 'mock-v3-006',
    spawn: (input: WorkerSpawnInput): WorkerSpawnResult => ({
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned'
    }),
    sendInstruction: (input: WorkerSendInstructionInput): WorkerSendInstructionResult => ({
      accepted: true,
      instruction_id: `instruction_${input.worker_id}`,
      status: 'queued'
    }),
    poll: (input: WorkerPollInput): WorkerPollResult => {
      if (options.failPoll) {
        throw {
          code: 'POLL_FAILED',
          message: 'worker poll failed',
          retryable: false
        };
      }
      const events = options.pollEvents ?? [{ type: 'done' }];
      const output = options.pollOutput === undefined
        ? { summary: 'ok' }
        : (options.pollOutput ?? undefined);
      return {
        worker_id: input.worker_id,
        status: options.pollStatus ?? 'completed',
        events,
        output
      };
    },
    interrupt: (input: WorkerInterruptInput): WorkerInterruptResult => ({
      interrupted: true,
      status: `interrupted:${input.reason ?? 'manual'}`
    }),
    collectArtifacts: (input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult => ({
      worker_id: input.worker_id,
      artifacts: [
        ...Array.from({ length: options.artifactCount ?? 1 }).map((_, index) => ({
          artifact_id: `worker_artifact_${input.worker_id}_${index + 1}`,
          version: index + 1
        }))
      ]
    })
  };
  return new WorkerAdapter(provider);
}

function makeStaticScheduler(dispatches: SchedulerDispatch[]): RuntimeScheduler {
  const tickResult: SchedulerTickResult = {
    scanned_teams: dispatches.length > 0 ? 1 : 0,
    recovered_count: 0,
    cleaned_count: 0,
    dispatched_count: dispatches.length,
    teams: dispatches.length > 0
      ? [{
        team_id: dispatches[0].team_id,
        recovered_tasks: 0,
        cleaned_assignments: 0,
        dispatched_count: dispatches.length,
        dispatches
      }]
      : [],
    dispatches
  };
  return {
    tick: () => tickResult
  } as unknown as RuntimeScheduler;
}

function eventPayload(event: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!event || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return {};
  }
  return event.payload as Record<string, unknown>;
}

test('V3-006 unit: executor completes claimed task through all stages with evidence and lead supervision', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: makeWorkerAdapter() });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 done unit',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const leadId = String(lead.agent.agent_id);
  const workerId = String(worker.agent.agent_id);
  assert.notEqual(leadId, workerId);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'complete me',
    description: 'implementation task',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({
    server,
    scheduler,
    instructionPrefix: 'V3-006 unit'
  });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.teams_processed, 1);
  assert.equal(run.tasks_completed, 1);
  assert.equal(run.tasks_blocked, 0);
  assert.equal(run.task_results.length, 1);

  const result = run.task_results[0];
  assert.equal(result.final_status, 'done');
  assert.equal(result.agent_id, workerId);
  assert.deepEqual(
    result.events.map((event) => `${event.stage}:${event.status}`),
    [
      'pick_task:succeeded',
      'assign_worker:succeeded',
      'execute:succeeded',
      'validate:succeeded',
      'publish_artifact:succeeded',
      'update_status:succeeded'
    ]
  );

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'done');
  assert.equal(server.store.getAgent(workerId)?.status, 'idle');
  assert.match(String(task?.description ?? ''), /executor evidence: artifact_task_/);

  const evidenceArtifact = server.store.getArtifact(teamId, `artifact_task_${taskId}`);
  assert.equal(Boolean(evidenceArtifact), true);
  const evidencePayload = JSON.parse(String(evidenceArtifact?.content ?? '{}')) as Record<string, unknown>;
  assert.equal(evidencePayload.task_id, taskId);
  assert.equal(evidencePayload.agent_id, workerId);
  assert.equal(evidencePayload.lead_agent_id, leadId);
  const validation = evidencePayload.validation as Record<string, unknown>;
  assert.equal(validation.quality_checks_passed, true);
  assert.equal(validation.compliance_ack, true);
  assert.equal(validation.worker_error_count, 0);

  const latestMessage = server.store.getLatestRouteMessage({
    team_id: teamId,
    from_agent_id: leadId,
    to_agent_id: workerId,
    delivery_mode: 'direct'
  });
  assert.equal(latestMessage?.from_agent_id, leadId);
  assert.equal(latestMessage?.to_agent_id, workerId);

  const events = server.store.listEvents(teamId, 200);
  const terminalEvidence = events.find((event) => event.event_type === 'task_terminal_evidence' && event.task_id === taskId);
  assert.equal(Boolean(terminalEvidence), true);
  const evidence = eventPayload(terminalEvidence).evidence as Record<string, unknown>;
  assert.equal(evidence.quality_checks_passed, true);
  assert.equal(evidence.artifact_refs_count, 1);
  assert.equal(evidence.compliance_ack, true);

  const workerDispatch = events.find((event) => event.event_type === 'worker_instruction_dispatched');
  assert.equal(Boolean(workerDispatch), true);

  server.store.close();
});

test('V3-006 unit: validation errors auto-transition task to blocked with evidence artifact', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: makeWorkerAdapter({ failPoll: true }) });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 blocked unit',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'block me',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 1);
  assert.equal(run.task_results.length, 1);

  const result = run.task_results[0];
  assert.equal(result.final_status, 'blocked');
  assert.deepEqual(
    result.events.map((event) => `${event.stage}:${event.status}`),
    [
      'pick_task:succeeded',
      'assign_worker:succeeded',
      'execute:succeeded',
      'validate:failed',
      'update_status:succeeded'
    ]
  );

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'blocked');
  assert.equal(server.store.getAgent(workerId)?.status, 'idle');
  assert.match(String(task?.description ?? ''), /\[blocked\] executor validation failed/);

  const evidenceArtifact = server.store.getArtifact(teamId, `artifact_task_${taskId}`);
  assert.equal(Boolean(evidenceArtifact), false);

  const events = server.store.listEvents(teamId, 200);
  const workerSnapshot = events.find((event) => event.event_type === 'worker_execution_snapshot');
  assert.equal(Boolean(workerSnapshot), true);
  assert.equal(eventPayload(workerSnapshot).worker_error_count, 1);

  const terminalEvidence = events.find((event) => event.event_type === 'task_terminal_evidence' && event.task_id === taskId);
  assert.equal(Boolean(terminalEvidence), true);
  const evidence = eventPayload(terminalEvidence).evidence as Record<string, unknown>;
  assert.equal(evidence.quality_checks_passed, false);
  assert.equal(evidence.artifact_refs_count, 0);
  assert.equal(evidence.compliance_ack, false);

  server.store.close();
});

test('V3-006 unit: non-terminal worker status keeps task in_progress and defers completion', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, {
    workerAdapter: makeWorkerAdapter({
      pollStatus: 'running',
      pollEvents: [{ type: 'heartbeat' }],
      pollOutput: { summary: 'running' },
      artifactCount: 0
    })
  });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 running status',
    profile: 'default',
    max_threads: 3
  });
  const teamId = String(started.team.team_id);
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'still running',
    required_role: 'implementer',
    priority: 1
  });
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 0);
  assert.equal(run.tasks_skipped, 1);

  const result = run.task_results[0];
  assert.equal(result.final_status, 'skipped');
  assert.deepEqual(
    result.events.map((event) => `${event.stage}:${event.status}`),
    [
      'pick_task:succeeded',
      'assign_worker:succeeded',
      'execute:succeeded',
      'validate:skipped'
    ]
  );

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'in_progress');
  assert.equal(Boolean(server.store.getArtifact(teamId, `artifact_task_${taskId}`)), false);

  server.store.close();
});

test('V3-006 unit: terminal failure worker status transitions task to blocked', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, {
    workerAdapter: makeWorkerAdapter({
      pollStatus: 'failed',
      pollEvents: [],
      pollOutput: null,
      artifactCount: 0
    })
  });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 terminal failure',
    profile: 'default',
    max_threads: 3
  });
  const teamId = String(started.team.team_id);
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'terminal failure',
    required_role: 'implementer',
    priority: 1
  });
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 1);
  assert.equal(run.tasks_skipped, 0);
  assert.equal(run.task_results[0]?.final_status, 'blocked');

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'blocked');
  assert.match(String(task?.description ?? ''), /terminal failure status/);
  assert.equal(Boolean(server.store.getArtifact(teamId, `artifact_task_${taskId}`)), false);

  server.store.close();
});

test('V3-006 unit: terminal success requires evidence signal before marking task done', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, {
    workerAdapter: makeWorkerAdapter({
      pollStatus: 'completed',
      pollEvents: [],
      pollOutput: null,
      artifactCount: 0
    })
  });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 missing evidence',
    profile: 'default',
    max_threads: 3
  });
  const teamId = String(started.team.team_id);
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'missing evidence',
    required_role: 'implementer',
    priority: 1
  });
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 1);
  assert.equal(run.tasks_skipped, 0);
  assert.equal(run.task_results[0]?.final_status, 'blocked');

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'blocked');
  assert.match(String(task?.description ?? ''), /missing evidence signals/);
  assert.equal(Boolean(server.store.getArtifact(teamId, `artifact_task_${taskId}`)), false);

  server.store.close();
});

test('V3-006 unit: missing poll with no adapter follows legacy terminal completion path', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 no-adapter legacy path',
    profile: 'default',
    max_threads: 3
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'legacy completion',
    required_role: 'implementer',
    priority: 1
  });
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const scheduler = makeStaticScheduler([{
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    required_role: 'implementer',
    priority: 1,
    git_branch: 'team/run-test/implementer-1',
    git_worktree_path: '/tmp/run-test/implementer-1'
  }]);
  const executor = new RuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 1);
  assert.equal(run.tasks_blocked, 0);
  assert.equal(run.tasks_skipped, 0);
  assert.equal(run.task_results[0]?.final_status, 'done');
  assert.equal(
    run.task_results[0]?.events.some((event) =>
      event.stage === 'validate' &&
      event.status === 'succeeded' &&
      /legacy inbox path/.test(String(event.detail ?? ''))
    ),
    true
  );

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'done');
  assert.match(String(task?.description ?? ''), /executor evidence: artifact_task_/);

  server.store.close();
});
test('V3-006 unit: executeAllInProgress processes claimed tasks even when scheduler dispatches none', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: makeWorkerAdapter() });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 executeAllInProgress',
    profile: 'default',
    max_threads: 3
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'already in progress',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);

  const noDispatchScheduler = makeStaticScheduler([]);

  const withoutExecuteAll = new RuntimeExecutor({
    server,
    scheduler: noDispatchScheduler,
    executeAllInProgress: false
  });
  const skippedRun = withoutExecuteAll.runOnce(teamId);
  assert.equal(skippedRun.tasks_completed, 0);
  assert.equal(server.store.getTask(taskId)?.status, 'in_progress');

  const withExecuteAll = new RuntimeExecutor({
    server,
    scheduler: noDispatchScheduler,
    executeAllInProgress: true
  });
  const completedRun = withExecuteAll.runOnce(teamId);
  assert.equal(completedRun.tasks_completed, 1);
  assert.equal(server.store.getTask(taskId)?.status, 'done');

  server.store.close();
});

test('V3-006 unit: rebalancer exposes execution hints and honors allow_busy_scale_down', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: makeWorkerAdapter() });
  registerTaskBoardTools(server);
  registerRebalancerTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 rebalance hints',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(worker.ok, true);
  const workerId = String(worker.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'busy worker',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: String(created.task.task_id),
    agent_id: workerId,
    expected_lock_version: Number(created.task.lock_version)
  });
  assert.equal(claimed.ok, true);
  server.store.updateAgentStatus(workerId, 'busy');

  const defaultScaleDown = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    task_size: 'small',
    estimated_parallel_tasks: 1,
    budget_tokens_remaining: 1000,
    max_scale_down: 6,
    allow_busy_scale_down: false
  });
  assert.equal(defaultScaleDown.ok, true);
  assert.equal(defaultScaleDown.actions.scaled_down, 0);
  assert.equal(defaultScaleDown.execution_hints.ready_tasks, 0);
  assert.equal(defaultScaleDown.execution_hints.in_progress_tasks, 1);
  assert.equal(defaultScaleDown.execution_hints.idle_agents >= 1, true);
  assert.equal(defaultScaleDown.execution_hints.lead_present, true);

  const allowBusyScaleDown = server.callTool('team_runtime_rebalance', {
    team_id: teamId,
    task_size: 'small',
    estimated_parallel_tasks: 1,
    budget_tokens_remaining: 1000,
    max_scale_down: 6,
    allow_busy_scale_down: true
  });
  assert.equal(allowBusyScaleDown.ok, true);
  assert.equal(allowBusyScaleDown.actions.scaled_down >= 1, true);
  assert.equal(allowBusyScaleDown.actions.offline_agent_ids.includes(workerId), true);

  server.store.close();
});
