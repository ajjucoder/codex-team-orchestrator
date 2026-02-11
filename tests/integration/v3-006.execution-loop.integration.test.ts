import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createRuntimeExecutor } from '../../mcp/runtime/executor.js';
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
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-006-int.sqlite';
const logPath = '.tmp/v3-006-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function makeWorkerAdapter(options: { failPoll?: boolean } = {}): { adapter: WorkerAdapter; sent: Array<{ worker_id: string; instruction: string }> } {
  const sent: Array<{ worker_id: string; instruction: string }> = [];
  const provider: WorkerProvider = {
    name: 'mock-v3-006-int',
    spawn: (input: WorkerSpawnInput): WorkerSpawnResult => ({
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned'
    }),
    sendInstruction: (input: WorkerSendInstructionInput): WorkerSendInstructionResult => {
      sent.push({
        worker_id: input.worker_id,
        instruction: input.instruction
      });
      return {
        accepted: true,
        instruction_id: `instruction_${sent.length}`,
        status: 'queued'
      };
    },
    poll: (input: WorkerPollInput): WorkerPollResult => {
      if (options.failPoll) {
        throw {
          code: 'POLL_FAILED',
          message: 'poll failed',
          retryable: false
        };
      }
      return {
        worker_id: input.worker_id,
        status: 'completed',
        events: [{ type: 'done' }],
        output: { summary: 'complete' }
      };
    },
    interrupt: (input: WorkerInterruptInput): WorkerInterruptResult => ({
      interrupted: true,
      status: `interrupted:${input.reason ?? 'manual'}`
    }),
    collectArtifacts: (input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult => ({
      worker_id: input.worker_id,
      artifacts: [{ artifact_id: `patch_${input.worker_id}`, version: 1 }]
    })
  };
  return {
    adapter: new WorkerAdapter(provider),
    sent
  };
}

test('V3-006 integration: scheduler + executor complete dependent tasks with evidence and lead supervision', () => {
  const worker = makeWorkerAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: worker.adapter });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 integration done path',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);
  const leadId = String(lead.agent.agent_id);
  const implementerId = String(implementer.agent.agent_id);

  const taskA = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'foundation',
    description: 'first task',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(taskA.ok, true);
  const taskB = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'dependent',
    description: 'second task',
    required_role: 'implementer',
    priority: 2,
    depends_on_task_ids: [taskA.task.task_id]
  });
  assert.equal(taskB.ok, true);
  assert.equal(taskB.task.status, 'blocked');

  const scheduler = createScheduler({
    server,
    tickIntervalMs: 20,
    readyTaskLimit: 50
  });
  const executor = createRuntimeExecutor({
    server,
    scheduler,
    instructionPrefix: 'V3-006 integration'
  });

  const first = executor.runOnce(teamId);
  assert.equal(first.ok, true);
  assert.equal(first.tasks_completed, 1);
  assert.equal(first.tasks_blocked, 0);
  assert.equal(first.task_results.length, 1);
  assert.equal(server.store.getTask(String(taskA.task.task_id))?.status, 'done');
  assert.equal(server.store.getTask(String(taskB.task.task_id))?.status, 'todo');

  const second = executor.runOnce(teamId);
  assert.equal(second.ok, true);
  assert.equal(second.tasks_completed, 1);
  assert.equal(second.tasks_blocked, 0);
  assert.equal(server.store.getTask(String(taskB.task.task_id))?.status, 'done');
  assert.equal(server.store.getAgent(implementerId)?.status, 'idle');

  assert.equal(worker.sent.length, 2);
  assert.equal(worker.sent.every((entry) => entry.worker_id === `worker_${implementerId}`), true);
  assert.equal(worker.sent.every((entry) => entry.instruction.includes('V3-006 integration')), true);

  const leadMessageCount = server
    .store
    .db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE team_id = ?
         AND from_agent_id = ?
         AND to_agent_id = ?`
    )
    .get(teamId, leadId, implementerId) as { count?: number };
  assert.equal(Number(leadMessageCount.count ?? 0), 2);

  const firstEvidence = server.store.getArtifact(teamId, `artifact_task_${String(taskA.task.task_id)}`);
  const secondEvidence = server.store.getArtifact(teamId, `artifact_task_${String(taskB.task.task_id)}`);
  assert.equal(Boolean(firstEvidence), true);
  assert.equal(Boolean(secondEvidence), true);

  const events = server.store.listEvents(teamId, 400);
  const stageUpdateEvents = events.filter((event) => event.event_type === 'executor_stage:update_status');
  assert.equal(stageUpdateEvents.length >= 2, true);
  const depReleaseEvents = events.filter((event) => event.event_type === 'task_dependencies_released');
  assert.equal(depReleaseEvents.length, 1);

  server.store.close();
});

test('V3-006 integration: missing lead blocks execution and emits blocked evidence trail', () => {
  const worker = makeWorkerAdapter();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerArtifactTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: worker.adapter });
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 integration blocked path',
    profile: 'default',
    max_threads: 3
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(implementer.ok, true);
  const implementerId = String(implementer.agent.agent_id);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'needs lead',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const scheduler = createScheduler({
    server,
    tickIntervalMs: 20,
    readyTaskLimit: 50
  });
  const executor = createRuntimeExecutor({ server, scheduler });

  const run = executor.runOnce(teamId);
  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 1);
  assert.equal(run.task_results.length, 1);
  assert.equal(run.task_results[0]?.final_status, 'blocked');
  assert.deepEqual(
    run.task_results[0]?.events.map((event) => `${event.stage}:${event.status}`),
    [
      'pick_task:succeeded',
      'assign_worker:succeeded',
      'execute:failed',
      'update_status:succeeded'
    ]
  );

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'blocked');
  assert.equal(server.store.getAgent(implementerId)?.status, 'idle');
  assert.match(String(task?.description ?? ''), /\[blocked\] executor failed: lead supervisor unavailable/);
  assert.equal(server.store.getArtifact(teamId, `artifact_task_${taskId}`), null);
  assert.equal(worker.sent.length, 0);

  const terminalEvidence = server
    .store
    .listEvents(teamId, 200)
    .find((event) => event.event_type === 'task_terminal_evidence' && event.task_id === taskId);
  assert.equal(Boolean(terminalEvidence), true);

  server.store.close();
});
