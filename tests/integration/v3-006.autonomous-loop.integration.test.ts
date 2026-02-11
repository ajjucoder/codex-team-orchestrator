import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { createRuntimeExecutor } from '../../mcp/runtime/executor.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const cleanupTargets: Array<{ dbPath: string; logPath: string }> = [];

afterEach(() => {
  for (const target of cleanupTargets.splice(0)) {
    rmSync(target.dbPath, { force: true });
    rmSync(`${target.dbPath}-wal`, { force: true });
    rmSync(`${target.dbPath}-shm`, { force: true });
    rmSync(target.logPath, { force: true });
  }
});

function makeWorkerAdapter(): WorkerAdapter {
  const provider: WorkerProvider = {
    name: 'mock-v3-006-integration',
    spawn: (input) => ({
      worker_id: `worker_${input.agent_id}`,
      status: 'spawned'
    }),
    sendInstruction: (input) => ({
      accepted: true,
      instruction_id: `instruction_${input.worker_id}`,
      status: 'queued'
    }),
    poll: (input) => ({
      worker_id: input.worker_id,
      status: 'completed',
      events: [{ type: 'done' }],
      output: { summary: 'ok' }
    }),
    interrupt: () => ({
      interrupted: true,
      status: 'interrupted'
    }),
    collectArtifacts: (input) => ({
      worker_id: input.worker_id,
      artifacts: [{ artifact_id: `artifact_${input.worker_id}`, version: 1 }]
    })
  };
  return new WorkerAdapter(provider);
}

function bootstrapServer(suffix: string) {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const dbPath = `.tmp/v3-006-int-${suffix}-${nonce}.sqlite`;
  const logPath = `.tmp/v3-006-int-${suffix}-${nonce}.log`;
  cleanupTargets.push({ dbPath, logPath });
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server, { workerAdapter: makeWorkerAdapter() });
  registerArtifactTools(server);
  registerTaskBoardTools(server);
  return server;
}

test('V3-006 integration: executor loop auto-completes a claimed task with artifact evidence', () => {
  const server = bootstrapServer('complete');

  const started = server.callTool('team_start', {
    objective: 'v3-006 autonomous loop completion',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Implement autonomous-loop patch',
    description: 'Integration test objective for v3-006.',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const scheduler = createScheduler({ server, tickIntervalMs: 25, readyTaskLimit: 50 });
  const executor = createRuntimeExecutor({
    server,
    scheduler,
    instructionPrefix: 'V3-006 integration run'
  });
  const run = executor.runOnce(teamId);

  assert.equal(run.ok, true);
  assert.equal(run.teams_processed, 1);
  assert.equal(run.tasks_completed, 1);
  assert.equal(run.tasks_blocked, 0);
  assert.equal(run.tasks_skipped, 0);
  assert.equal(run.task_results.length, 1);
  assert.equal(run.task_results[0].task_id, taskId);
  assert.equal(run.task_results[0].final_status, 'done');
  assert.equal(Boolean(run.task_results[0].evidence_ref), true);

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'done');
  assert.match(String(task?.description ?? ''), /executor evidence:/);

  const implementerAgent = server.store.getAgent(String(implementer.agent.agent_id));
  assert.equal(implementerAgent?.status, 'idle');

  const evidence = run.task_results[0].evidence_ref as { artifact_id: string; version: number };
  const artifact = server.store.getArtifact(teamId, evidence.artifact_id, evidence.version);
  assert.equal(Boolean(artifact), true);
  assert.equal(artifact?.name, `executor-evidence-${taskId}`);
  const payload = JSON.parse(String(artifact?.content ?? '{}')) as Record<string, unknown>;
  const validation = payload.validation as Record<string, unknown>;
  assert.equal(validation.quality_checks_passed, true);
  assert.equal(validation.compliance_ack, true);
  assert.equal(validation.worker_error_count, 0);

  const events = server.store.listEvents(teamId, 200);
  const terminalEvidence = events.find((event) => event.event_type === 'task_terminal_evidence' && event.task_id === taskId);
  assert.equal(Boolean(terminalEvidence), true);
  const terminalPayload = terminalEvidence?.payload as Record<string, unknown>;
  const evidencePayload = terminalPayload.evidence as Record<string, unknown>;
  assert.equal(evidencePayload.quality_checks_passed, true);
  assert.equal(evidencePayload.artifact_refs_count, 1);
  assert.equal(evidencePayload.compliance_ack, true);

  server.store.close();
});

test('V3-006 integration: executor blocks when no supervising lead is available', () => {
  const server = bootstrapServer('blocked');

  const started = server.callTool('team_start', {
    objective: 'v3-006 autonomous loop blocked path',
    profile: 'default',
    max_threads: 3
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(implementer.ok, true);

  const created = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'Task without lead supervision',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const scheduler = createScheduler({ server, tickIntervalMs: 25, readyTaskLimit: 50 });
  const executor = createRuntimeExecutor({
    server,
    scheduler,
    instructionPrefix: 'V3-006 blocked path'
  });
  const run = executor.runOnce(teamId);

  assert.equal(run.ok, true);
  assert.equal(run.tasks_completed, 0);
  assert.equal(run.tasks_blocked, 1);
  assert.equal(run.task_results.length, 1);
  assert.equal(run.task_results[0].task_id, taskId);
  assert.equal(run.task_results[0].final_status, 'blocked');
  assert.equal(run.task_results[0].evidence_ref, null);

  const task = server.store.getTask(taskId);
  assert.equal(task?.status, 'blocked');
  assert.match(String(task?.description ?? ''), /lead supervisor unavailable/);

  const implementerAgent = server.store.getAgent(String(implementer.agent.agent_id));
  assert.equal(implementerAgent?.status, 'idle');

  const events = server.store.listEvents(teamId, 200);
  const terminalEvidence = events.find((event) => event.event_type === 'task_terminal_evidence' && event.task_id === taskId);
  assert.equal(Boolean(terminalEvidence), true);
  const terminalPayload = terminalEvidence?.payload as Record<string, unknown>;
  const evidencePayload = terminalPayload.evidence as Record<string, unknown>;
  assert.equal(evidencePayload.quality_checks_passed, false);
  assert.equal(evidencePayload.artifact_refs_count, 0);
  assert.equal(evidencePayload.compliance_ack, false);

  server.store.close();
});
