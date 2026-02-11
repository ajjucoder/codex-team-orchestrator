import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createScheduler, createServer } from '../../mcp/server/index.js';
import { createRuntimeExecutor } from '../../mcp/runtime/executor.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-006-e2e.sqlite';
const logPath = '.tmp/v3-006-e2e.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-006 e2e: large objective DAG completes through autonomous loop without manual implementer actions', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'v3-006 large objective',
    profile: 'default',
    max_threads: 6
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);
  assert.equal(reviewer.ok, true);
  assert.equal(tester.ok, true);

  function createTask(input: Record<string, unknown>) {
    const created = server.callTool('team_task_create', input);
    assert.equal(created.ok, true);
    return created.task as { task_id: string };
  }

  const t1 = createTask({
    team_id: teamId,
    title: 'Foundation implementation',
    required_role: 'implementer',
    priority: 1
  });
  const t2 = createTask({
    team_id: teamId,
    title: 'Foundation review',
    required_role: 'reviewer',
    priority: 2,
    depends_on_task_ids: [t1.task_id]
  });
  const t3 = createTask({
    team_id: teamId,
    title: 'Foundation test',
    required_role: 'tester',
    priority: 2,
    depends_on_task_ids: [t1.task_id]
  });
  const t4 = createTask({
    team_id: teamId,
    title: 'Integration implementation',
    required_role: 'implementer',
    priority: 3,
    depends_on_task_ids: [t2.task_id, t3.task_id]
  });
  const t5 = createTask({
    team_id: teamId,
    title: 'Integration review',
    required_role: 'reviewer',
    priority: 4,
    depends_on_task_ids: [t4.task_id]
  });
  const t6 = createTask({
    team_id: teamId,
    title: 'Integration test',
    required_role: 'tester',
    priority: 4,
    depends_on_task_ids: [t4.task_id]
  });
  const t7 = createTask({
    team_id: teamId,
    title: 'Release candidate implementation',
    required_role: 'implementer',
    priority: 5,
    depends_on_task_ids: [t5.task_id, t6.task_id]
  });
  const t8 = createTask({
    team_id: teamId,
    title: 'Release readiness review',
    required_role: 'reviewer',
    priority: 5,
    depends_on_task_ids: [t7.task_id]
  });

  const targetTaskIds = [
    String(t1.task_id),
    String(t2.task_id),
    String(t3.task_id),
    String(t4.task_id),
    String(t5.task_id),
    String(t6.task_id),
    String(t7.task_id),
    String(t8.task_id)
  ];

  const scheduler = createScheduler({ server, tickIntervalMs: 20, readyTaskLimit: 100 });
  const executor = createRuntimeExecutor({
    server,
    scheduler,
    instructionPrefix: 'V3-006 large-objective run'
  });

  let iterations = 0;
  const maxIterations = 24;
  while (iterations < maxIterations) {
    iterations += 1;
    executor.runOnce(teamId);
    const listed = server.callTool('team_task_list', { team_id: teamId });
    assert.equal(listed.ok, true);
    const tasks = listed.tasks as Array<Record<string, unknown>>;
    const doneCount = tasks.filter((task) => task.status === 'done').length;
    const failedTerminalCount = tasks.filter((task) => task.status === 'failed_terminal').length;
    assert.equal(failedTerminalCount, 0);
    if (doneCount === targetTaskIds.length) break;
  }

  const finalList = server.callTool('team_task_list', { team_id: teamId });
  assert.equal(finalList.ok, true);
  const tasks = finalList.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks.length, targetTaskIds.length);
  assert.equal(tasks.filter((task) => task.status === 'done').length, targetTaskIds.length);
  assert.equal(tasks.filter((task) => task.status === 'blocked').length, 0);

  for (const task of tasks) {
    assert.match(String(task.description ?? ''), /executor evidence:/);
    assert.notEqual(String(task.claimed_by ?? ''), String(lead.agent.agent_id));
  }

  const terminalEvents = server
    .store
    .listEvents(teamId, 500)
    .filter((event) => event.event_type === 'task_terminal_evidence');
  assert.equal(terminalEvents.length, targetTaskIds.length);

  const nonLeadAgents = server
    .store
    .listAgentsByTeam(teamId)
    .filter((agent) => agent.role !== 'lead');
  assert.equal(nonLeadAgents.every((agent) => agent.status === 'idle'), true);

  server.store.close();
});
